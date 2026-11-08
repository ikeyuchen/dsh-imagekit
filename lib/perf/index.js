/**
 * dsh-plugin-perfmon — 性能监测工具箱
 * ==========================================
 * 为所有会话注册一个模型可见网关工具 perf（action = snapshot | history | mark）；后台采样器常驻宿主进程内（DSH 运行即采样，
 * DSH 关闭即停止，历史落插件 data\ 目录）：
 *
 *   - action=snapshot 当前性能快照：GPU 专用/共享显存、按进程 GPU 归因、
 *                    CPU/内存/磁盘换页、近 10 分钟趋势、活动打点、监测器自身
 *                    开销；共享显存（non-local）超阈值时标记 sysmem fallback
 *                    （显存溢出到系统内存的静默降速）
 *   - action=history  历史窗口聚合：各指标峰值/均值 + 抽样趋势序列 + 窗口内打点
 *   - action=mark     任务打点（op = start | end | status）：start/end 包住一段负载，产出该任务的资源消耗摘要
 *
 * 依赖：`@deepseek-ai/dsh-tools`（官方 defineTool，参数走 author schema DSL）与
 * `@deepseek-ai/schemastery`（官方 Config schema）。二者按官方规范声明在
 * peerDependencies —— link 安装下宿主的 profile 解析层按 peer 申报把请求路由到
 * 运行安装自己的副本，因此与宿主共享同一份实例（官方文档 04「linked checkout
 * 的 peer 规则」）。
 *
 * Config（写在 profile / bundle patch 的 config 段，默认值直接写在 schema 里；
 * 热生效需禁用/启用一次）：
 *   intervalSec        轻拍间隔，默认 5
 *   censusIntervalSec  普查间隔，默认 30
 *   retentionHours     历史保留，默认 48
 *   dataDir            数据目录，默认 <插件目录>\data
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { PerfMonitor } from "./monitor.js";
import { PerfStore } from "./store.js";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tool-perfmon";
/** 依赖的宿主服务：工具注册器与系统提示组装。 */
const inject = ["tools", "systemPrompt"];

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 共享 GPU 内存（non-local 总量）超过该值视为 sysmem fallback 生效（MiB）。 */
const SYSMEM_FALLBACK_THRESHOLD_MB = 512;
/** 展示/聚合上限的命名常量（业务数字不再散落内联，单一事实源可查可改）。 */
const SNAPSHOT_TREND_WINDOW_MS = 10 * 60000; // perf(action=snapshot) 的近况窗口（render 文案「Last 10m」同源）
const SERIES_MAX_POINTS = 100; // perf(action=history) 趋势序列抽样点上限
const GPU_TOP_AT_PEAK_COUNT = 3; // VRAM 峰值时刻列出的 top GPU 进程数（markSummary 与 perf(action=history) 共用）
const FINISHED_MARKS_CAP = 50; // 已完结打点的保留上限（超出即滚出最旧）
const RECENT_FINISHED_MARKS = 5; // status 动作列出的最近已完结打点数

/**
 * 官方配置契约：导出 Standard Schema（Schemastery）的 Config。
 * Cordis 在插件加载时按它校验该行的 config 并填充默认值；不合法即响亮失败。
 * 下界沿用旧 mergeConfig 的校验（低于下界的配置会被拒绝，而不是被静默改写）。
 * （官方文档 03：不要导出普通对象作为 Config。）
 */
const Config = Schema.object({
	intervalSec: Schema.number().default(5).min(2).description("轻拍间隔秒数：会话/GPU 总量 + CPU/内存（下限 2，默认 5）"),
	censusIntervalSec: Schema.number().default(30).min(10).description("普查间隔秒数：按进程 GPU 显存归因 + RSS 排行（下限 10，默认 30）"),
	retentionHours: Schema.number().default(48).min(1).description("JSONL 历史保留小时数，按小时滚动、超期自动删除（下限 1，默认 48）"),
	dataDir: Schema.string()
		.default(path.join(PLUGIN_DIR, "data"))
		.description("数据目录，默认 <插件目录>\\data；固定它可让换 dist 目录热更新时历史与打点不丢"),
	minGpuProcMB: Schema.number().default(16).min(1).description("进程 GPU 显存归因的最小计入值 MiB（下限 1，默认 16）"),
	maxGpuProcs: Schema.number().default(12).min(3).description("每次普查最多列出的进程数（下限 3，默认 12）"),
	topRssCount: Schema.number().default(8).min(3).description("RSS 排行最多列出的进程数（下限 3，默认 8）"),
	mode: Schema.union(["auto", "worker", "inline"])
		.default("inline")
		.description("采样执行位置：inline = 主线程 + kick 自愈（默认，宿主兼容）；worker = 独立线程（独立进程/selftest 用——宿主内 Worker 模块加载不可用，2026-10-07 六轮定位实证）；auto = 先试 worker 再回 inline"),
	standbyEnabled: Schema.boolean()
		.default(true)
		.description("活动感知待机：无 DSH 会话活动（磁盘信号 + CPU/GPU 热度 + 活动打点均静默）时停采样，仅轻探测"),
	idleAfterSec: Schema.number().default(300).min(30).description("连续空闲多少秒后进入待机（下限 30，默认 300）"),
	standbyPollSec: Schema.number().default(30).min(10).description("待机期活动信号探测间隔秒数（纯 stat，成本≈0；下限 10，默认 30）"),
	heatCpuPct: Schema.number().default(20).min(0).description("CPU 超过该百分比视为「机器在工作」（覆盖长工具执行期日志暂静的盲区；下限 0，默认 20）"),
	heatGpuPct: Schema.number().default(5).min(0).description("GPU 利用率超过该百分比视为「机器在工作」（下限 0，默认 5）"),
	activityRoot: Schema.string().description("会话活动信号根目录（可选，缺省 ~/.dsh；留空表示不按磁盘活动判定）"),
});

/* ------------------------------------------------------------------ */
/* 聚合分析                                                            */
/* ------------------------------------------------------------------ */

function round1(x) {
	return x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
}

function summarizeTicks(ticks) {
	let gpuMin = null;
	let gpuMax = null;
	let gpuMaxAt = null;
	let gpuSum = 0;
	let gpuN = 0;
	let cpuSum = 0;
	let cpuN = 0;
	let cpuMax = null;
	let memMin = null;
	for (const r of ticks) {
		const used = r.gpu?.usedMiB;
		if (Number.isFinite(used)) {
			if (gpuMin === null || used < gpuMin) gpuMin = used;
			if (gpuMax === null || used > gpuMax) {
				gpuMax = used;
				gpuMaxAt = r.t;
			}
			gpuSum += used;
			gpuN += 1;
		}
		if (Number.isFinite(r.cpu)) {
			cpuSum += r.cpu;
			cpuN += 1;
			if (cpuMax === null || r.cpu > cpuMax) cpuMax = r.cpu;
		}
		if (Number.isFinite(r.memAvailMB) && (memMin === null || r.memAvailMB < memMin)) memMin = r.memAvailMB;
	}
	return {
		count: ticks.length,
		gpu: gpuN > 0 ? { minMiB: gpuMin, maxMiB: gpuMax, maxAt: gpuMaxAt, avgMiB: Math.round(gpuSum / gpuN) } : null,
		cpu: cpuN > 0 ? { avgPct: round1(cpuSum / cpuN), maxPct: cpuMax } : null,
		memAvailMinMB: memMin,
	};
}

function summarizeCensuses(censuses) {
	let nlMax = null;
	let nlMaxAt = null;
	let pagesMax = null;
	let diskIdleMin = null;
	let vmmemMax = null;
	for (const c of censuses) {
		if (Number.isFinite(c.nonLocalTotalMiB) && (nlMax === null || c.nonLocalTotalMiB > nlMax)) {
			nlMax = c.nonLocalTotalMiB;
			nlMaxAt = c.t;
		}
		if (Number.isFinite(c.pagesPerSec) && (pagesMax === null || c.pagesPerSec > pagesMax)) pagesMax = c.pagesPerSec;
		if (Number.isFinite(c.diskIdlePct) && (diskIdleMin === null || c.diskIdlePct < diskIdleMin)) diskIdleMin = c.diskIdlePct;
		const v = c.rss?.watched?.vmmemMB;
		if (Number.isFinite(v) && (vmmemMax === null || v > vmmemMax)) vmmemMax = v;
	}
	return {
		nonLocalMaxMiB: nlMax,
		nonLocalMaxAt: nlMaxAt,
		pagesPerSecMax: round1(pagesMax),
		diskIdleMinPct: round1(diskIdleMin),
		vmmemMaxMB: vmmemMax,
	};
}

function censusNearest(censuses, t) {
	let best = null;
	let bestD = Infinity;
	for (const c of censuses) {
		const d = Math.abs(c.t - t);
		if (d < bestD) {
			bestD = d;
			best = c;
		}
	}
	return best;
}

/** GPU 峰值时刻的 top 进程（markSummary 与 perf(action=history) 共用同一组合：
 *  原两处逐字重复，改 top-N / 空值处理时极易漏一边）。 */
function topGpuProcsAtPeak(tickSum, censuses) {
	if (tickSum.gpu?.maxAt != null && censuses.length > 0) {
		return (censusNearest(censuses, tickSum.gpu.maxAt)?.gpuProcs ?? []).slice(0, GPU_TOP_AT_PEAK_COUNT);
	}
	return null;
}

function decimate(records, maxPoints, project) {
	if (records.length === 0) return [];
	const step = Math.max(1, Math.ceil(records.length / maxPoints));
	const out = [];
	for (let i = 0; i < records.length; i += step) out.push(project(records[i]));
	return out;
}

/** "15m" / "2h30m" / "45s" / "90" → 毫秒（无单位按秒；单位大小写不敏感）。
 *  整串必须可解析：前后杂字符（"x5m"）、负数（"-5m"）、拼错单位
 *  一律响亮报错而不是静默回退默认窗口——窗口直接决定聚合口径，静默回退会让模型
 *  拿着 30m 的数据以为是 5m 的。空串/非字符串仍回退默认（= 未提供）。 */
function parseDurationMs(text, fallbackMs) {
	if (typeof text !== "string" || text.trim() === "") return fallbackMs;
	const trimmed = text.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.max(1000, Math.round(Number(trimmed) * 1000));
	const unit = String.raw`(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)`;
	if (!new RegExp(`^${unit}(?:\\s*${unit})*$`, "i").test(trimmed)) {
		throw new Error(`invalid 'last' value ${JSON.stringify(text)}: use forms like '15m', '2h30m', '45s', '90' (bare number = seconds)`);
	}
	let ms = 0;
	const re = new RegExp(unit, "gi");
	let m;
	while ((m = re.exec(trimmed)) !== null) {
		const v = Number(m[1]);
		const u = m[2].toLowerCase();
		ms += u === "ms" ? v : u === "s" ? v * 1000 : u === "m" ? v * 60000 : u === "h" ? v * 3600000 : v * 86400000;
	}
	return Math.max(1000, Math.round(ms));
}

function markSummary(store, from, to) {
	const ticks = store.ticksInRange(from, to);
	const censuses = store.censusesInRange(from, to);
	const tickSum = summarizeTicks(ticks);
	const cenSum = summarizeCensuses(censuses);
	const summary = {
		durationSec: Math.round((to - from) / 1000),
		tickCount: ticks.length,
		censusCount: censuses.length,
		gpu: tickSum.gpu,
		cpu: tickSum.cpu,
		memAvailMinMB: tickSum.memAvailMinMB,
		nonLocalMaxMiB: cenSum.nonLocalMaxMiB,
		pagesPerSecMax: cenSum.pagesPerSecMax,
		diskIdleMinPct: cenSum.diskIdleMinPct,
		vmmemMaxMB: cenSum.vmmemMaxMB,
		gpuTopAtPeak: topGpuProcsAtPeak(tickSum, censuses),
	};
	const sysPeak = cenSum.nonLocalMaxMiB;
	summary.sysmemFallback =
		sysPeak === null || sysPeak === undefined
			? null
			: { peakMiB: sysPeak, active: sysPeak >= SYSMEM_FALLBACK_THRESHOLD_MB, thresholdMiB: SYSMEM_FALLBACK_THRESHOLD_MB };
	return summary;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function fmtTime(epochMs) {
	if (!Number.isFinite(epochMs)) return "?";
	const d = new Date(epochMs);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtGpuProcs(procs) {
	return procs.map((p) => `${p.name}#pid${p.pid} ${p.localMiB}MiB ded${p.nonLocalMiB > 0 ? ` + ${p.nonLocalMiB}MiB SHARED` : ""}`).join(" | ");
}

function renderSnapshot(v) {
	const lines = [];
	const s = v.self;
	const standbyTag = s.standby ? `, STANDBY ${s.idleForSec ?? "?"}s` : "";
	// 嵌套三元拆 if/else 链（规范禁嵌套三元，新增采样模式时也好扩展）。
	let modeTag;
	if (s.mode === "worker") modeTag = s.workerAlive ? `worker-alive${standbyTag}` : "worker-DEAD";
	else if (s.mode === "inline") modeTag = `inline${standbyTag}`;
	else modeTag = "starting";
	lines.push(
		`Perf monitor [${modeTag}]: up ${s.uptimeSec ?? "?"}s, ${s.ticks ?? 0} ticks @${s.intervalSec ?? "?"}s + ${s.censuses ?? 0} censuses @${s.censusIntervalSec ?? "?"}s, errors ${s.errors ?? 0}, restarts ${s.restarts ?? 0}${s.workerRestarts ? ` (+worker ${s.workerRestarts})` : ""}, self CPU ${s.hostCpuPctOfOneCore ?? "?"}% of one core, data ${s.dataMB ?? "?"}MB`
	);
	if (v.gpu) {
		// tempC 冷态可为 null：nvidia-smi 未回报温度时不再渲染 "nullC"。
		lines.push(
			`GPU ${v.gpu.name}: ${v.gpu.usedMiB}/${v.gpu.totalMiB} MiB used (free ${v.gpu.freeMiB}, util ${v.gpu.utilPct}%, ${v.gpu.tempC ?? "?"}C)`
		);
	} else {
		lines.push("GPU totals unavailable (nvidia-smi probing or not found)");
	}
	if (v.sysmemFallback) {
		lines.push(
			`Shared GPU memory (non-local): ${v.sysmemFallback.totalSharedMiB} MiB — sysmem fallback ${v.sysmemFallback.active ? "ACTIVE (VRAM overflow into system RAM, expect 10-50x slowdown; find the process with nonLocalMiB > 0 below)" : "not active"} (threshold ${v.sysmemFallback.thresholdMiB} MiB)`
		);
	}
	if (v.gpuProcesses?.length) lines.push(`GPU processes: ${fmtGpuProcs(v.gpuProcesses)}`);
	const disk =
		v.disk && (v.disk.idlePct != null || v.disk.pagesPerSec != null)
			? ` | disk idle ${v.disk.idlePct ?? "?"}% | pages/s ${v.disk.pagesPerSec ?? "?"}`
			: "";
	// totalMB 冷态可为 null：首个 worker 心跳前 monitor.memTotalMB 读
	// 不到，与 availMB 同样兑底，不再渲染 "1234/null MB"。
	lines.push(`CPU ${v.cpuPct ?? "?"}% | RAM avail ${v.memory.availMB ?? "?"}/${v.memory.totalMB ?? "?"} MB${disk}`);
	const watched = Object.entries(v.rss?.watched ?? {})
		.map(([k, mb]) => `${k.replace(/MB$/, "")} ${mb}MB`)
		.join(", ");
	if (watched) lines.push(`RSS watched: ${watched}`);
	if (v.rss?.top?.length) lines.push(`RSS top: ${v.rss.top.map((e) => `${e.name} ${e.mb}MB`).join(", ")}`);
	const l = v.last10Min;
	if (l && l.count > 0) {
		lines.push(
			`Last 10m (${l.count} ticks): GPU ${l.gpu ? `${l.gpu.minMiB}-${l.gpu.maxMiB} MiB (avg ${l.gpu.avgMiB}, peak ${fmtTime(l.gpu.maxAt)})` : "n/a"}, CPU avg ${l.cpu?.avgPct ?? "?"}% max ${l.cpu?.maxPct ?? "?"}%, shared-GPU-mem max ${l.nonLocalMaxMiB ?? "?"} MiB, RAM avail min ${l.memAvailMinMB ?? "?"} MB`
		);
	}
	if (v.activeMarks?.length) {
		lines.push(`Active marks: ${v.activeMarks.map((m) => `#${m.id} "${m.label}" since ${m.startedAt}`).join("; ")}`);
	}
	for (const h of v.hints ?? []) lines.push(`HINT: ${h}`);
	return lines.join("\n");
}

function renderHistory(v) {
	const lines = [];
	// 统一时基：窗口边界与 series 点都是 ISO/UTC，峰值时间原本走
	// fmtTime（本地 HH:MM:SS）——非 UTC 宿主上峰值与窗口对不上，事后归因会被误导。
	// render 内一律 ISO；fmtTime 保留给「Last 10m」这类相对窗口的快照场景。
	const iso = (ms) => new Date(ms).toISOString();
	lines.push(
		`Perf window ${new Date(v.windowFromMs).toISOString()} .. ${new Date(v.windowToMs).toISOString()}: ${v.window.tickCount} ticks, ${v.window.censusCount} censuses`
	);
	if (v.gpu) lines.push(`GPU used MiB: min ${v.gpu.minMiB} / avg ${v.gpu.avgMiB} / max ${v.gpu.maxMiB} (peak at ${iso(v.gpu.maxAt)})`);
	else lines.push("GPU used: no samples in window");
	if (v.nonLocalMaxMiB != null) lines.push(`Shared GPU mem peak: ${v.nonLocalMaxMiB} MiB (at ${iso(v.nonLocalMaxAt)})`);
	if (v.cpu) lines.push(`CPU %: avg ${v.cpu.avgPct} / max ${v.cpu.maxPct}`);
	if (v.memAvailMinMB != null) lines.push(`RAM avail min: ${v.memAvailMinMB} MB`);
	if (v.pagesPerSecMax != null) lines.push(`Pages/sec max: ${v.pagesPerSecMax} | disk idle min: ${v.diskIdleMinPct ?? "?"}%`);
	if (v.vmmemMaxMB != null) lines.push(`WSL vmmem peak: ${v.vmmemMaxMB} MB`);
	if (v.gpuTopAtPeak?.length) lines.push(`Top GPU procs at peak: ${fmtGpuProcs(v.gpuTopAtPeak)}`);
	if (v.series?.length) {
		lines.push(
			`Series: ${v.series.length} points, ${v.series[0].t} → ${v.series[v.series.length - 1].t} (per point: gpuUsedMiB/cpuPct/memAvailMB — see JSON)`
		);
	}
	if (v.marks?.length) {
		lines.push(`Marks: ${v.marks.map((m) => `#${m.id} "${m.label}" ${m.startedAt}..${m.endedAt ?? "…"}`).join("; ")}`);
	}
	return lines.join("\n");
}

function renderMark(v) {
	if (v.action === "status") {
		const act = v.active.map((m) => `#${m.id} "${m.label}" since ${m.startedAt}`).join("; ") || "(none)";
		const fin =
			v.recentFinished.map((m) => `#${m.id} "${m.label}" ${m.durationSec}s GPU peak ${m.summary?.gpu?.maxMiB ?? "?"}MiB`).join(" | ") ||
			"(none)";
		return `Active marks: ${act}\nRecent finished: ${fin}`;
	}
	if (v.action === "start") {
		return `Mark #${v.id} "${v.label}" started at ${v.startedAt}. Call perf (action=mark, op=end) id=${v.id} when the workload finishes to get its resource summary.`;
	}
	const s = v.summary ?? {};
	const lines = [];
	lines.push(`Mark #${v.id} "${v.label}": ${v.durationSec}s (${v.startedAt} → ${v.endedAt}), ${s.tickCount} ticks / ${s.censusCount} censuses`);
	if (s.gpu) lines.push(`GPU used MiB: avg ${s.gpu.avgMiB} / peak ${s.gpu.maxMiB} at ${fmtTime(s.gpu.maxAt)}`);
	if (s.nonLocalMaxMiB != null) lines.push(`Shared GPU mem peak: ${s.nonLocalMaxMiB} MiB`);
	if (s.cpu) lines.push(`CPU %: avg ${s.cpu.avgPct} / peak ${s.cpu.maxPct}`);
	if (s.memAvailMinMB != null) lines.push(`RAM avail min: ${s.memAvailMinMB} MB`);
	if (s.vmmemMaxMB != null) lines.push(`WSL vmmem peak: ${s.vmmemMaxMB} MB`);
	if (s.pagesPerSecMax != null) lines.push(`Pages/sec max: ${s.pagesPerSecMax} | disk idle min: ${s.diskIdleMinPct ?? "?"}%`);
	if (s.gpuTopAtPeak?.length) lines.push(`Top GPU procs at peak: ${fmtGpuProcs(s.gpuTopAtPeak)}`);
	if (s.sysmemFallback) {
		lines.push(
			`Sysmem fallback during mark: ${s.sysmemFallback.active ? `ACTIVE (peak shared ${s.sysmemFallback.peakMiB} MiB ≥ ${s.sysmemFallback.thresholdMiB})` : `no (peak shared ${s.sysmemFallback.peakMiB} MiB < ${s.sysmemFallback.thresholdMiB})`}`
		);
	}
	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 系统提示                                                            */
/* ------------------------------------------------------------------ */

const SYSTEM_SECTION_TEXT =
	// 「12GB GPU」是本机硬件事实，不进系统提示文案：换机器后这句话
	// 就是错的、还会误导模型；显存是否吃紧由 perf(action=snapshot) 的实际读数说话。
	"GPU/CPU/VRAM health: check before heavy GPU jobs — shared-VRAM spill is a silent 10-50x.";

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

function apply(ctx, rawConfig) {
	// 后置归一化：Config schema 已保证类型与下界（Cordis 加载时按 schema 校验并填默认
	// 值，selftest 也经 Config({}) 过一道），这里只做取整与 activityRoot 的「空串视作
	// 未配置」语义——下界不再二次钳制，避免与 schema 的 .min() 形成两处会漂移的事实源
	// 原钳制集合也不完整：idleAfterSec/maxGpuProcs 就没钳）。
	const config = {
		...rawConfig,
		intervalSec: Math.round(rawConfig.intervalSec),
		censusIntervalSec: Math.round(rawConfig.censusIntervalSec),
		retentionHours: Math.round(rawConfig.retentionHours),
		maxGpuProcs: Math.round(rawConfig.maxGpuProcs),
		topRssCount: Math.round(rawConfig.topRssCount),
		idleAfterSec: Math.round(rawConfig.idleAfterSec),
		standbyPollSec: Math.round(rawConfig.standbyPollSec),
		activityRoot: typeof rawConfig.activityRoot === "string" && rawConfig.activityRoot !== "" ? rawConfig.activityRoot : null,
	};

	const store = new PerfStore({ dir: config.dataDir, retentionHours: config.retentionHours });
	store.init();
	// 2026-10-07 六轮定位终版：宿主内 Worker 文件模块加载完全不可用（eval 探针
	// 证明 Worker 线程本身正常，但文件路径/file:// URL/动态 import 均静默失败）。
	// 默认 inline + kick 自愈（每次工具调用复活采样器）；worker/auto 保留给
	// 独立进程/selftest——宿主后续修复 Worker 模块加载后可改回 auto。
	const monitor = new PerfMonitor({
		store,
		mode: config.mode,
		config: {
			dataDir: config.dataDir,
			retentionHours: config.retentionHours,
			intervalSec: config.intervalSec,
			censusIntervalSec: config.censusIntervalSec,
			minGpuProcMB: config.minGpuProcMB,
			maxGpuProcs: config.maxGpuProcs,
			topRssCount: config.topRssCount,
			standbyEnabled: config.standbyEnabled,
			idleAfterSec: config.idleAfterSec,
			standbyPollSec: config.standbyPollSec,
			activityRoot: config.activityRoot,
			heatCpuPct: config.heatCpuPct,
			heatGpuPct: config.heatGpuPct,
		},
	});
	monitor.start();
	const stop = () => {
		try {
			monitor.stop();
		} catch (error) {
			// 清理失败要可诊断：monitor.stop 内部已吞错，这里再静默
			// 就是第二层掩盖；logger 可用则记一笔，不可用维持静默降级。
			try {
				ctx.logger?.warn?.(`[perfmon] monitor.stop() failed: ${String(error?.message ?? error)}`);
			} catch { /* logger 不可用 */ }
		}
	};
	if (typeof ctx.effect === "function") ctx.effect(stop);
	else if (typeof ctx.on === "function") ctx.on("dispose", stop);

	ctx.systemPrompt.section({
		name: "tool:perfmon",
		order: 2070,
		text: ({ scope }) => (ctx.tools.get("perf", scope) === undefined ? "" : SYSTEM_SECTION_TEXT),
	});

	/* --------------------- runSnapshot --------------------- */
	async function runSnapshot(exec) {
		monitor.kick();
		store.refreshFromDisk();
		const now = Date.now();
		const from = now - SNAPSHOT_TREND_WINDOW_MS;
		const lastTick = store.ticks.length > 0 ? store.ticks[store.ticks.length - 1] : null;
		const lastCensus = store.censuses.length > 0 ? store.censuses[store.censuses.length - 1] : null;
		const gpu = lastTick?.gpu ?? null;
		const nonLocal = lastCensus?.nonLocalTotalMiB ?? null;
		const result = {
			now: new Date(now).toISOString(),
			gpu: gpu
				? {
						name: gpu.name,
						usedMiB: gpu.usedMiB,
						totalMiB: gpu.totalMiB,
						freeMiB: gpu.totalMiB - gpu.usedMiB,
						utilPct: gpu.utilPct,
						tempC: gpu.tempC,
					}
				: null,
			sysmemFallback:
				nonLocal === null
					? null
					: { totalSharedMiB: nonLocal, active: nonLocal >= SYSMEM_FALLBACK_THRESHOLD_MB, thresholdMiB: SYSMEM_FALLBACK_THRESHOLD_MB },
			gpuProcesses: lastCensus?.gpuProcs ?? null,
			cpuPct: lastTick?.cpu ?? null,
			memory: { availMB: lastTick?.memAvailMB ?? null, totalMB: monitor.memTotalMB },
			disk: lastCensus ? { idlePct: lastCensus.diskIdlePct ?? null, pagesPerSec: lastCensus.pagesPerSec ?? null } : null,
			rss: lastCensus?.rss ?? null,
			last10Min: {
				...summarizeTicks(store.ticksInRange(from, now)),
				...summarizeCensuses(store.censusesInRange(from, now)),
			},
			activeMarks: store.marks.active,
			self: { ...monitor.stats(), dataMB: store.dataMB() },
		};
		if (result.sysmemFallback?.active) {
			result.hints = [
				"Shared GPU memory (non-local) is high: a CUDA workload likely exceeded dedicated VRAM and the driver is spilling into system RAM (silent 10-50x slowdown, no error raised). Find the process with nonLocalMiB > 0 in gpuProcesses, then free VRAM (e.g., comfy (action=control, op=free)) or rerun that workload with offload flags (lowvram / device_map auto).",
			];
		}
		if (result.self?.standby) {
			result.hints = [
				...(result.hints ?? []),
				`Monitor was in standby (no DSH activity for ${result.self.idleForSec ?? "?"}s) — this call woke it; the next snapshot will have fresh samples.`,
			];
		}
		return result;
	}

	/* --------------------- runHistory --------------------- */
	async function runHistory(args, exec) {
		monitor.kick();
		store.refreshFromDisk();
		const now = Date.now();
		let from;
		let to;
		if (typeof args.from === "string" || typeof args.to === "string") {
			to = typeof args.to === "string" ? Date.parse(args.to) : now;
			from = typeof args.from === "string" ? Date.parse(args.from) : to - 30 * 60000;
			if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("invalid from/to timestamp");
		} else {
			to = now;
			from = now - parseDurationMs(args.last, 30 * 60000);
		}
		const earliest = now - config.retentionHours * 3600000;
		const predatesRetention = from < earliest;
		if (predatesRetention) from = earliest;
		if (from > to) {
			// 区分「保留期外的窗口」与「真的 from > to」：调用方的
			// from 本来早于 to，被保留期钳到 to 之后时旧报错文案会误导模型来回翻时间戳，
			// 正解是把窗口向 now 方向放宽。
			throw new Error(
				predatesRetention
					? `empty window: requested from predates retention (history kept ${config.retentionHours}h) and retention-clamped from (${new Date(from).toISOString()}) is after to (${new Date(to).toISOString()}) — widen the window toward now`
					: "empty window: from is after to",
			);
		}
		const ticks = store.ticksInRange(from, to);
		const censuses = store.censusesInRange(from, to);
		const active = store.marks.active
			.filter((m) => Date.parse(m.startedAt) <= to)
			.map((m) => ({ id: m.id, label: m.label, startedAt: m.startedAt, endedAt: null }));
		const finished = store.marks.finished
			.filter((m) => Date.parse(m.startedAt) <= to && Date.parse(m.endedAt) >= from)
			.map((m) => ({ id: m.id, label: m.label, startedAt: m.startedAt, endedAt: m.endedAt }));
		const tickSum = summarizeTicks(ticks);
		const result = {
			window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tickCount: ticks.length, censusCount: censuses.length },
			windowFromMs: from,
			windowToMs: to,
			...tickSum,
			...summarizeCensuses(censuses),
			marks: [...active, ...finished],
		};
		const topAtPeak = topGpuProcsAtPeak(tickSum, censuses);
		if (topAtPeak) result.gpuTopAtPeak = topAtPeak;
		if (args.series !== false) {
			result.series = decimate(ticks, SERIES_MAX_POINTS, (r) => ({
				t: new Date(r.t).toISOString(),
				gpuUsedMiB: r.gpu?.usedMiB ?? null,
				cpuPct: r.cpu ?? null,
				memAvailMB: r.memAvailMB ?? null,
			}));
		}
		return result;
	}

	/* --------------------- runMark --------------------- */
	async function runMark(args, exec) {
		monitor.kick();
		store.refreshFromDisk();
		const action = args.action;
		if (action === "start") {
			store.marks.seq += 1;
			const id = `m${store.marks.seq}`;
			// 注意：宿主回传工具输出走 lossless-json，返回值里**禁止出现
			// undefined 属性值**（2026-10-02 探针实测：带 note:undefined 的
			// 三次调用全部报 "value is not lossless JSON"）。缺省字段直接不设键。
			const mark = {
				id,
				label: typeof args.label === "string" && args.label.trim() !== "" ? args.label.trim().slice(0, 80) : `task-${id}`,
				startedAt: new Date().toISOString(),
				startedTs: Date.now(),
			};
			store.marks.active.push(mark);
			store.saveMarks();
			monitor.notifyMarks(true);
			return {
				action,
				...mark,
				activeCount: store.marks.active.length,
				hint: `Run perf (action=mark, op=end) id=${id} when the workload finishes to get its resource summary.`,
			};
		}
		if (action === "end") {
			const idx =
				typeof args.id === "string" ? store.marks.active.findIndex((m) => m.id === args.id) : store.marks.active.length - 1;
			if (idx < 0) {
				throw new Error(
					`no active mark${args.id ? ` with id ${args.id}` : ""}; active: ${store.marks.active.map((m) => m.id).join(", ") || "(none)"}`
				);
			}
			const [mark] = store.marks.active.splice(idx, 1);
			const to = Date.now();
			const summary = markSummary(store, mark.startedTs, to);
			const finished = { ...mark, endedAt: new Date(to).toISOString(), durationSec: summary.durationSec, summary };
			store.marks.finished.push(finished);
			if (store.marks.finished.length > FINISHED_MARKS_CAP) store.marks.finished.shift();
			store.saveMarks();
			monitor.notifyMarks(store.marks.active.length > 0);
			return { action, ...finished };
		}
		if (action === "status") {
			return { action, active: store.marks.active, recentFinished: store.marks.finished.slice(-RECENT_FINISHED_MARKS).reverse() };
		}
		throw new Error(`unknown action: ${action}`);
	}
	/* ---------------------------- perf 网关 ---------------------------- */
	// 三个原工具收成一个网关（token 优化第三轮）：execute 按 action 分派到上面抽出的实现函数，
	// render 仍走各自的模型可见文本——不把结果塞进 JSON 让模型看不见。
	const historyPresentationMeta = (_args, v) => ({
		window: {
			from: String(v.window?.from ?? ""),
			to: String(v.window?.to ?? ""),
			tickCount: Number(v.window?.tickCount ?? 0),
		},
		gpu: v.gpu ? { minMiB: Number(v.gpu.minMiB ?? 0), avgMiB: Number(v.gpu.avgMiB ?? 0), maxMiB: Number(v.gpu.maxMiB ?? 0) } : null,
		cpu: v.cpu ? { avgPct: Number(v.cpu.avgPct ?? 0), maxPct: Number(v.cpu.maxPct ?? 0) } : null,
		memAvailMinMB: v.memAvailMinMB ?? null,
		nonLocalMaxMiB: v.nonLocalMaxMiB ?? null,
		series: Array.isArray(v.series)
			? v.series.slice(0, 100).map((p) => ({
				t: String(p.t ?? ""),
				gpuUsedMiB: p.gpuUsedMiB ?? null,
				cpuPct: p.cpuPct ?? null,
			}))
			: [],
		marks: Array.isArray(v.marks)
			? v.marks.slice(0, 10).map((m) => ({
				id: Number(m.id ?? 0),
				label: String(m.label ?? ""),
				startedAt: String(m.startedAt ?? ""),
				endedAt: m.endedAt ?? null,
			}))
			: [],
	});
	const RENDERS = {
		snapshot: (_args, value) => [{ type: "text", text: renderSnapshot(value) }],
		history: (_args, value) => [{ type: "text", text: renderHistory(value) }],
		mark: (_args, value) => [{ type: "text", text: renderMark(value) }],
	};
	ctx.tools.register(defineTool({
		name: "perf",
		description: "Perf snapshot, history, or marks.",
		parameters: {
			action: { type: "string", enum: ["snapshot", "history", "mark"], description: "snapshot | history | mark.", required: true },
			last: { type: "string", description: "history: window like '15m', '2h30m' (default '30m')." },
			from: { type: "string", description: "history: window start, ISO timestamp (overrides last)." },
			to: { type: "string", description: "history: window end, ISO timestamp (default now)." },
			series: { type: "boolean", description: "history: include decimated trend series (default 100 points)." },
			op: { type: "string", enum: ["start", "end", "status"], description: "action=mark: start / end / status." },
			label: { type: "string", description: "mark: name (max 80 chars)." },
			id: { type: "string", description: "mark op=end: default latest active mark." },
		},
		output: {
			// 单一输出 schema 覆盖三种返回结构；各 action 的字段差异由 render 保持原样。
			schema: { type: "object", additionalProperties: true },
			render: (args, value) => RENDERS[String(args.action)](args, value),
			// UI 卡片数据面只属于 history：其余 action 不产 presentationMeta。
			// 0.2.2 起输出校验要求 lossless JSON：undefined 会被判 "presentationMeta returned
			// non-lossless JSON" 并整调用失败，故非 history 明确返回 null（客户端按无 meta 降级）。
			presentationMeta: (args, value) => (args.action === "history" ? historyPresentationMeta(args, value) : null),
		},
		// 原三工具超时不同：取最大（history 60s）；snapshot/mark 只是上限放宽，能力不丢。
		timeoutMs: 60000,
		isConcurrencySafe: (args) => args?.action !== "mark",
		async execute(args, exec) {
			const action = args.action;
			if (action === "snapshot") return runSnapshot(exec);
			if (action === "history") return runHistory(args, exec);
			if (action === "mark") {
				// 原 perf_mark 的 action 参数与网关 action 同名：落到 op 上复用同一实现。
				if (typeof args.op !== "string") throw new Error("action=mark requires op: start | end | status");
				return runMark({ ...args, action: args.op }, exec);
			}
			throw new Error(`unknown action: ${action}`);
		},
	}));
}

export { Config, SYSMEM_FALLBACK_THRESHOLD_MB, apply, inject, name };
