/**
 * dsh-plugin-perfmon — 采样 worker 入口（独立线程内运行采样循环）
 * ============================================================
 * 背景（2026-10-02 实测）：宿主会清理插件作用域内创建的定时器——主线程上的
 * 常驻采样链活不过首拍（1 tick 后死亡，errors=0），换目录热更新也救不了。
 * worker 线程有**自己的事件循环与原生定时器**，不受该清理影响。
 *
 * 2026-10-07 二轮修复：PerfSampler/PerfStore 改为**动态 import**（在 crash handler
 * 注册之后）——ESM 的静态 import 全部提升到模块体之前执行，sampler.js/store.js
 * 加载失败时 crash handler 还没注册，异常被 Node 默认吞掉 → worker 干净退出 →
 * 父线程无 error 事件 → inline 兜底不可达 → worker-DEAD 静默死亡（宿主活体实证，
 * 本地 selftest/独立进程均不显现——差异在宿主的模块 URL 解析）。
 *
 * 职责：按配置跑两层采样（轻拍/普查），记录直接 append 进 data\ 的
 * perf-*.jsonl；每次普查后额外写一行 k:'s' 心跳（含采样器自身统计），
 * 主线程通过读文件获得数据与统计，无需消息通信。
 */

// ── 第一层：node 内建（保证能加载）+ 启动标记 + crash handler ──
import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cfg = workerData ?? {};

// 启动标记：文件存在 = 模块体开始执行了（不管后面成不成）
try {
	writeFileSync(join(cfg.dataDir ?? ".", "worker-started.marker"),
		`${new Date().toISOString()} pid=${process.pid} node=${process.version}\n`);
} catch { /* 标记失败不阻断 */ }

// crash handler：任何异常写日志后**重抛**——重抛让父线程收到 'error' 事件，
// degradeToInline（P1 #59）才能接管（空吞 = 静默死亡路径，2026-10-07 活体实证）。
const crashLog = (kind, e) => {
	try {
		appendFileSync(
			join(cfg.dataDir ?? ".", "worker-crash.log"),
			`[${new Date().toISOString()}] ${kind}: ${String(e?.stack ?? e)}\n`,
		);
	} catch { /* 日志失败不再放大 */ }
};
process.on("uncaughtException", (e) => {
	crashLog("uncaughtException", e);
	throw e;
});
process.on("unhandledRejection", (e) => {
	crashLog("unhandledRejection", e);
	throw e;
});

// ── 第二层：插件模块（动态 import——加载失败走 crash handler→重抛→error→inline 兜底） ──
const { PerfSampler } = await import("./sampler.js");
const { PerfStore } = await import("./store.js");

// ── 第三层：初始化 + 采样循环 ──
const store = new PerfStore({ dir: cfg.dataDir, retentionHours: cfg.retentionHours ?? 48 });
store.init();
const sampler = new PerfSampler({
	intervalSec: cfg.intervalSec,
	censusIntervalSec: cfg.censusIntervalSec,
	minGpuProcMB: cfg.minGpuProcMB,
	maxGpuProcs: cfg.maxGpuProcs,
	topRssCount: cfg.topRssCount,
	standbyEnabled: cfg.standbyEnabled,
	idleAfterSec: cfg.idleAfterSec,
	standbyPollSec: cfg.standbyPollSec,
	activityRoot: cfg.activityRoot,
	heatCpuPct: cfg.heatCpuPct,
	heatGpuPct: cfg.heatGpuPct,
	onTick: (r) => store.append(r),
	onCensus: (r) => {
		store.append(r);
		store.append({ k: "s", t: Date.now(), ...sampler.stats() });
	},
	onTransition: (r) => store.append(r), // 待机/唤醒转换记录（k:'z'），历史不造假
	onStats: (r) => store.append(r), // 待机期心跳（k:'s', standby:true）
});
sampler.start();

parentPort?.on("message", (m) => {
	if (m?.type === "stop") {
		sampler.stop();
		try {
			parentPort.close();
		} catch {}
		process.exit(0);
	}
	if (m?.type === "wake") sampler.notifyActivity();
	if (m?.type === "marks") sampler.setMarkActive(Boolean(m.active));
});
