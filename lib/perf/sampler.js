/**
 * dsh-plugin-perfmon — 后台性能采样器（零依赖）
 * ============================================================
 * 全部探测使用系统自带可执行文件，分两层采样控制自身开销：
 *
 *   轻拍 tick（默认 5s：1 个子进程，~200ms wall / 极低 CPU）
 *     - nvidia-smi --query-gpu        GPU 总量（占用/总量/利用率/温度）
 *     - Node 内置 os.cpus()/freemem() CPU% 与可用内存（零子进程、零开销）
 *
 *   普查 census（默认 30s：~1.3s wall / ~0.3s CPU）
 *     - nvidia-smi --query-compute-apps  CUDA 进程 pid → exe 映射（WDDM 下
 *                                       per-process 显存列是 [N/A]，仅取名字）
 *     - typeperf（单次调用组合查询）：
 *         GPU Process Memory(*)\Local Usage      按进程 专用 显存（字节）
 *         GPU Process Memory(*)\Non Local Usage  按进程 共享 显存（字节）
 *         Memory\Pages/sec、PhysicalDisk(_Total)\% Idle Time
 *     - tasklist /fo csv /nh             RSS 普查（vmmem/python/krita/node 聚合 + topN）
 *
 * 为什么按进程显存走计数器：Windows WDDM 下 nvidia-smi 的 per-process 显存
 * 显示 [N/A]（2026-10-02 实测），GPU Process Memory 计数器是唯一可靠来源；
 * non-local（共享 GPU 内存）总量持续偏高 = CUDA sysmem fallback（显存溢出
 * 到系统内存的静默降速）的识别信号——这正是 12GB 卡跑 16GB 模型时"任务没
 * 报错但慢 10-50 倍"的那种状态。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { latestDshActivityMs } from "./activity.js";

/**
 * 模块加载时刻捕获的原始 setTimeout。宿主（DSH/cordis）可能对插件作用域内
 * 创建的定时器做生命周期管理（2026-10-02 实测：安装进宿主后采样链在首拍后
 * 停摆而 errors=0，独立 node 进程则正常），因此：
 *   1) 定时器优先注入宿主作用域 API（ctx.setTimeout，随插件生命周期清理）；
 *   2) 否则用这里捕获的原始引用；
 *   3) kick() 自愈：每次工具调用检查链条是否停摆，停摆即按代际重启。
 */
const RAW_SET_TIMEOUT = setTimeout;

/** 停摆判定系数：_lastLoopAt 落后超过 N 个周期即视为停摆。kick() 重启与 stats() 上报
 *  共用同一常量（原 kick 用 2.5× 而 stats 写成 3×，且待机周期长、
 *  按在线周期算阈值会把健康待机的每轮轮询大半时间误报成 stalled）。 */
const STALL_FACTOR = 2.5;

/** 子进程输出解码：tasklist 在中文 Windows 上输出 GBK（OEM 936），需显式解码。 */
export function safeDecode(buf, encoding) {
	if (encoding && encoding !== "utf8") {
		try {
			return new TextDecoder(encoding).decode(buf);
		} catch {}
	}
	return buf.toString("utf8");
}

const NVIDIA_CANDIDATES = [
	"nvidia-smi",
	"C:\\Windows\\System32\\nvidia-smi.exe",
	"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
];

const GPU_LOCAL = "\\GPU Process Memory(*)\\Local Usage";
const GPU_NONLOCAL = "\\GPU Process Memory(*)\\Non Local Usage";
const MEM_PAGES = "\\Memory\\Pages/sec";
const DISK_IDLE = "\\PhysicalDisk(_Total)\\% Idle Time";

/* ------------------------------------------------------------------ */
/* 子进程执行                                                          */
/* ------------------------------------------------------------------ */

export function runCommand(exe, args, timeoutMs = 20000, encoding = "utf8") {
	return new Promise((resolve) => {
		const started = Date.now();
		let child;
		try {
			child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ ok: false, error: String(err?.message ?? err), stdout: "", stderr: "", ms: 0 });
			return;
		}
		const chunks = [];
		const errChunks = [];
		let settled = false;
		let timer = null;
		const settle = (ok, error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				ok,
				error: error ?? null,
				stdout: safeDecode(Buffer.concat(chunks), encoding),
				stderr: safeDecode(Buffer.concat(errChunks), encoding),
				ms: Date.now() - started,
			});
		};
		timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			settle(false, `timeout after ${timeoutMs}ms`);
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			errChunks.push(chunk);
		});
		child.on("error", (err) => settle(false, String(err?.code ?? err?.message ?? err)));
		child.on("close", (code) => settle(code === 0, code === 0 ? null : `exit ${code}`));
	});
}

/* ------------------------------------------------------------------ */
/* 输出解析（格式均以 2026-10-02 本机真实输出校准）                     */
/* ------------------------------------------------------------------ */

/** 从 PDH-CSV / tasklist 行提取带引号字段。 */
export function csvQuotedFields(line) {
	const out = [];
	const re = /"((?:[^"]|"")*)"/g;
	let m;
	while ((m = re.exec(line)) !== null) out.push(m[1].replace(/""/g, '"'));
	return out;
}

/** nvidia-smi --query-gpu=timestamp,name,memory.total,memory.used,utilization.gpu,temperature.gpu（每行一卡）。 */
export function parseGpuTotals(stdout) {
	const gpus = [];
	for (const raw of String(stdout).split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		const f = line.split(",").map((s) => s.trim());
		if (f.length < 6) continue;
		const total = Number(f[f.length - 4]);
		const used = Number(f[f.length - 3]);
		const util = Number(f[f.length - 2]);
		const temp = Number(f[f.length - 1]);
		if (!Number.isFinite(used) || !Number.isFinite(total)) continue;
		gpus.push({
			name: f.slice(1, f.length - 4).join(","),
			totalMiB: total,
			usedMiB: used,
			utilPct: Number.isFinite(util) ? util : null,
			tempC: Number.isFinite(temp) ? temp : null,
		});
	}
	return gpus;
}

/** nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory → [{pid, exe}]。 */
export function parseComputeApps(stdout) {
	const apps = [];
	for (const raw of String(stdout).split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || !line.includes(",")) continue;
		const f = line.split(",");
		const pid = Number(f[0]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const exe = f.slice(1, f.length - 1).join(",").trim();
		if (exe === "") continue;
		apps.push({ pid, exe });
	}
	return apps;
}

/** 找到 typeperf 输出的表头行与首个数据行（均为带引号 PDH-CSV 行）。 */
export function typeperfRows(stdout) {
	const lines = String(stdout).split(/\r?\n/).filter((l) => l.startsWith('"'));
	if (lines.length < 2) return null;
	return { header: csvQuotedFields(lines[0]), data: csvQuotedFields(lines[1]) };
}

/**
 * 解析 census 组合 typeperf 输出（GPU per-process Local/Non Local + Pages/s + Disk Idle）。
 * 返回 { byPid: Map<pid,{localBytes,nonLocalBytes}>, totalLocalBytes, totalNonLocalBytes, pagesPerSec, diskIdlePct }
 */
export function parseCensusCounters(stdout) {
	const rows = typeperfRows(stdout);
	if (!rows) return null;
	const byPid = new Map();
	let totalLocal = 0;
	let totalNonLocal = 0;
	let pagesPerSec = null;
	let diskIdlePct = null;
	const gpuRe = /\\GPU Process Memory\(pid_(\d+)[^)]*\)\\(Local Usage|Non Local Usage)$/;
	const pagesRe = /\\Memory\\Pages\/sec$/;
	const diskRe = /\\PhysicalDisk\(_Total\)\\% Idle Time$/;
	for (let i = 1; i < rows.header.length; i++) {
		const field = rows.header[i];
		const value = Number(rows.data[i]);
		if (!Number.isFinite(value)) continue;
		const g = field.match(gpuRe);
		if (g) {
			const pid = Number(g[1]);
			const isLocal = g[2] === "Local Usage";
			let entry = byPid.get(pid);
			if (!entry) {
				entry = { localBytes: 0, nonLocalBytes: 0 };
				byPid.set(pid, entry);
			}
			if (isLocal) {
				entry.localBytes += value;
				totalLocal += value;
			} else {
				entry.nonLocalBytes += value;
				totalNonLocal += value;
			}
			continue;
		}
		if (pagesRe.test(field)) pagesPerSec = value;
		else if (diskRe.test(field)) diskIdlePct = value;
	}
	return { byPid, totalLocalBytes: totalLocal, totalNonLocalBytes: totalNonLocal, pagesPerSec, diskIdlePct };
}

/* ------------------------------------------------------------------ */
/* CPU（Node 内置，零子进程）                                          */
/* ------------------------------------------------------------------ */

export function cpuTimes() {
	return os.cpus().map((c) => ({ ...c.times }));
}

/** 两次 os.cpus() 快照之间的总 CPU 占用率（%）。 */
export function cpuPercentBetween(prev, cur) {
	let idle = 0;
	let total = 0;
	const n = Math.min(prev.length, cur.length);
	for (let i = 0; i < n; i++) {
		const a = prev[i];
		const b = cur[i];
		const dIdle = b.idle - a.idle;
		const dTotal =
			b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
		if (dTotal > 0) {
			idle += dIdle;
			total += dTotal;
		}
	}
	if (total <= 0) return null;
	return Math.round((1 - idle / total) * 1000) / 10;
}

/* ------------------------------------------------------------------ */
/* RSS 普查（tasklist）                                                */
/* ------------------------------------------------------------------ */

/** tasklist /fo csv /nh → [{name, pid, rssKB}]。 */
export function parseTasklist(stdout) {
	const out = [];
	for (const raw of String(stdout).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith('"')) continue;
		const f = csvQuotedFields(line);
		if (f.length < 5) continue;
		const pid = Number(f[1]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		// 空/非数值内存列显式拒绝：replace 后空串经 Number() 变 0，
		// isFinite 拦不住——字段错位的行会以 rssKB=0 混进聚合、稀释 RSS 读数。
		const rssDigits = f[4].replace(/[^\d]/g, "");
		if (rssDigits === "") continue;
		const rssKB = Number(rssDigits);
		if (!Number.isFinite(rssKB)) continue;
		out.push({ name: f[0], pid, rssKB });
	}
	return out;
}

const WATCHED_RULES = [
	["vmmem", /^vmmem/i], // WSL2 虚拟机
	["qemu", /^qemu-system/i], // QEMU 虚拟机（本机 Linux 开发实测在用）
	["python", /^python/i], // 推理/引擎进程
	["krita", /^krita/i], // 设计台绘画
	["node", /^node/i], // DSH 宿主等
];

/** RSS 聚合：关注组（WSL/推理进程/Krita/Node 宿主）+ 全量 topN（≥100MB）。 */
export function aggregateRss(procs, topN = 8) {
	const byName = new Map();
	for (const p of procs) {
		const key = p.name.toLowerCase();
		const cur = byName.get(key) ?? { name: p.name, rssKB: 0 };
		cur.rssKB += p.rssKB;
		byName.set(key, cur);
	}
	const watched = {};
	for (const [key, re] of WATCHED_RULES) {
		let sum = 0;
		for (const [name, agg] of byName) if (re.test(name)) sum += agg.rssKB;
		if (sum > 0) watched[`${key}MB`] = Math.round(sum / 1024);
	}
	const top = [...byName.values()]
		.filter((e) => e.rssKB >= 100 * 1024)
		.sort((a, b) => b.rssKB - a.rssKB)
		.slice(0, topN)
		.map((e) => ({ name: e.name, mb: Math.round(e.rssKB / 1024) }));
	return { watched, top };
}

function baseName(p) {
	return String(p).split(/[\\/]/).pop();
}

/* ------------------------------------------------------------------ */
/* 采样器                                                              */
/* ------------------------------------------------------------------ */

export class PerfSampler {
	constructor(opts) {
		this.intervalSec = opts.intervalSec ?? 5;
		this.censusIntervalSec = opts.censusIntervalSec ?? 30;
		this.minGpuProcMB = opts.minGpuProcMB ?? 16;
		this.maxGpuProcs = opts.maxGpuProcs ?? 12;
		this.topRssCount = opts.topRssCount ?? 8;
		this.onTick = opts.onTick ?? (() => {});
		this.onCensus = opts.onCensus ?? (() => {});
		this.onError = opts.onError ?? (() => {});
		this.onTransition = opts.onTransition ?? (() => {});
		this.onStats = opts.onStats ?? (() => {});
		// 活动感知待机（2026-10-02 用户需求）：无会话活动 → 停采样仅轻探测
		this.standbyEnabled = opts.standbyEnabled !== false;
		this.idleAfterSec = Number.isFinite(opts.idleAfterSec) && opts.idleAfterSec >= 1 ? opts.idleAfterSec : 300;
		this.standbyPollSec = Number.isFinite(opts.standbyPollSec) && opts.standbyPollSec >= 1 ? opts.standbyPollSec : 30;
		this.activityRoot = typeof opts.activityRoot === "string" && opts.activityRoot !== "" ? opts.activityRoot : null;
		this.heatCpuPct = Number.isFinite(opts.heatCpuPct) ? opts.heatCpuPct : 20;
		this.heatGpuPct = Number.isFinite(opts.heatGpuPct) ? opts.heatGpuPct : 5;
		this._standby = false;
		this._standbyAt = 0;
		this._markActive = false;
		this._inStandbyPoll = false; // 正在 _pollStandby 内部（区分轮询内/外部唤醒）
		this._lastActivityAt = Date.now();
		this._lastHeatAt = 0;
		this._lastCpuPct = null;
		this._lastGpuUtil = null;
		this.setTimer = typeof opts.setTimer === "function" ? opts.setTimer : (fn, ms) => RAW_SET_TIMEOUT(fn, ms);
		this._gen = 0;
		this._lastLoopAt = Date.now();
		this._restarts = 0;
		this._busySince = 0;
		// DSH 磁盘信号的节流缓存：新鲜度只被用于 idleAfterSec（默认
		// 300s）量级的判定，没必要每 tick 全量 stat sessions/（同步阻塞，本机实测中位
		// ~2ms/次、随历史会话数线性增长）。窗口夹在 [5s, 30s]，待机轮询周期不短于它，
		// 待机唤醒延迟不受影响。
		this._dshScanEveryMs = Math.min(30_000, Math.max(5_000, this.idleAfterSec * 250));
		this._lastDshScanAt = 0;
		this._lastDshActivity = 0;
		this.memTotalMB = Math.round(os.totalmem() / 1048576);
		this._cpuPrev = cpuTimes();
		this._cpuUsageStart = process.cpuUsage();
		this._startedAt = Date.now();
		this._stopped = false;
		this._busy = false;
		this._timer = null;
		this._ticks = 0;
		this._censuses = 0;
		this._errors = 0;
		this._tickMsTotal = 0;
		this._lastTickMs = 0;
		this._censusMsTotal = 0;
		this._nvidiaExe = null;
		this._nvidiaDisabledUntil = 0;
		this._censusEvery = Math.max(1, Math.round(this.censusIntervalSec / this.intervalSec));
	}

	start() {
		this._stopped = false;
		this._loop();
	}

	stop() {
		this._stopped = true;
		this._gen += 1;
		// 在飞的旧拍的 finally 因代际不匹配不再清 _busy：由 stop 兜底复位，避免复用时卡死
		this._busy = false;
		this._disposeTimer();
	}

	/** 取消并清空挂起的下一跳定时器（stop 与 kick 共用）：kick 重启
	 * 前必须先撤旧定时器，否则旧回调点火会开第二条并发链——_timer 只留最新句柄，
	 * 双链并存＝双倍采样率。 */
	_disposeTimer() {
		if (this._timer) {
			if (typeof this._timer === "function") {
				try {
					this._timer(); // ctx.setTimeout 风格：返回注销函数
				} catch {}
			} else {
				try {
					clearTimeout(this._timer);
				} catch {}
			}
			this._timer = null;
		}
	}

	/**
	 * 自愈入口（每次工具调用都会触发）：采样链停摆超过 2.5 个周期即按代际重启。
	 * 返回 true 表示本次调用重启了链条。若正处超长普查（<90s）则让路。
	 */
	kick() {
		if (this._stopped) return false;
		const stallMs = Date.now() - this._lastLoopAt;
		if (stallMs < this.intervalSec * 1000 * STALL_FACTOR) return false;
		if (this._busy && Date.now() - this._busySince < 90_000) return false;
		this._gen += 1;
		this._disposeTimer(); // 撤掉旧链的下一跳
		this._busy = false;
		this._restarts += 1;
		this.onError(new Error(`sampler loop stalled ${Math.round(stallMs / 1000)}s; restarting (restart #${this._restarts})`));
		this._loop();
		return true;
	}

	/**
	 * 外部活动通知（每次 perf 工具调用都会触发）：刷新活动时刻并立即唤醒待机
	 * （旧实现只翻转 _standby，采样要等下一个待机轮询定时器、
	 * 最长 standbyPollSec 后才恢复——与“立即唤醒”的注释和 snapshot 的 hint 承诺不符）。
	 */
	notifyActivity() {
		this._lastActivityAt = Date.now();
		this._exitStandby("tool-call");
	}

	/** 活动打点存在期间强制在线（主线程经消息转发）。 */
	setMarkActive(active) {
		this._markActive = Boolean(active);
		if (this._markActive) this._exitStandby("mark");
	}

	/** 活动时刻 = max(DSH 磁盘信号, 机器热度, 工具调用唤醒)。 */
	_activityMs() {
		let m = this._lastActivityAt;
		if (this._lastHeatAt > m) m = this._lastHeatAt;
		// 节流缓存；探测坏掉时 latestDshActivityMs 返回“刚有活动”
		// 兜底并经 onError 上报——这里包一层，宿主回调抛错不得外溢。
		const now = Date.now();
		if (now - this._lastDshScanAt >= this._dshScanEveryMs) {
			this._lastDshScanAt = now;
			this._lastDshActivity = latestDshActivityMs(this.activityRoot, (e) => {
				try {
					this.onError(e);
				} catch {}
			});
		}
		if (this._lastDshActivity > m) m = this._lastDshActivity;
		return m;
	}

	_evaluateStandby() {
		if (!this.standbyEnabled || this._standby) return;
		if (Number.isFinite(this._lastCpuPct) && this._lastCpuPct >= this.heatCpuPct) this._lastHeatAt = Date.now();
		if (Number.isFinite(this._lastGpuUtil) && this._lastGpuUtil >= this.heatGpuPct) this._lastHeatAt = Date.now();
		if (this._markActive) return;
		if (Date.now() - this._activityMs() > this.idleAfterSec * 1000) this._enterStandby();
	}

	async _pollStandby() {
		if (this._markActive || Date.now() - this._activityMs() < this.idleAfterSec * 1000) {
			this._exitStandby("activity");
			return;
		}
		// 停采样仅轻探测（文件头承诺）：待机期间也要刷新 CPU/GPU 热度
		// 信号——否则 _lastCpuPct/_lastGpuUtil 冻结在进待机前的低值，外部渲染任务把机器
		// 烧热也永远唤不醒（heatCpuPct/heatGpuPct 两个配置随之失效）。
		try {
			const cpuNow = cpuTimes();
			const cpuPct = cpuPercentBetween(this._cpuPrev, cpuNow);
			this._cpuPrev = cpuNow;
			if (Number.isFinite(cpuPct)) this._lastCpuPct = cpuPct;
			const gpus = await this._queryGpuTotals();
			if (gpus && gpus.length > 0) this._lastGpuUtil = gpus[0].utilPct ?? null;
			if (Number.isFinite(this._lastCpuPct) && this._lastCpuPct >= this.heatCpuPct) this._lastHeatAt = Date.now();
			if (Number.isFinite(this._lastGpuUtil) && this._lastGpuUtil >= this.heatGpuPct) this._lastHeatAt = Date.now();
			if (Date.now() - this._activityMs() < this.idleAfterSec * 1000) {
				this._exitStandby("heat");
				return;
			}
		} catch {}
		try {
			this.onStats({ k: "s", t: Date.now(), standby: true, ...this.stats() });
		} catch {}
	}

	_enterStandby() {
		this._standby = true;
		this._standbyAt = Date.now();
		try {
			this.onTransition({ k: "z", t: this._standbyAt, state: "standby" });
		} catch {}
		this.onError(new Error(`entering standby: no DSH activity for ${this.idleAfterSec}s`));
	}

	_exitStandby(reason) {
		if (!this._standby) return;
		this._standby = false;
		this._lastActivityAt = Date.now();
		try {
			this.onTransition({ k: "z", t: Date.now(), state: "active", reason });
		} catch {}
		// 真正的立即补拍：外部触发（工具调用/活动打点）时撤掉挂起的
		// 待机轮询定时器并立刻调度一拍；_pollStandby 内部触发的唤醒不再二次调度——
		// _loop 的 standby 分支本来就会落到下方立即补拍，再调度会开出第二条并发链
		// （_schedule 的闭包代际只防旧回调，防不住同代双链）。kick() 语义不受影响。
		if (!this._inStandbyPoll) {
			this._disposeTimer();
			this._schedule(0);
		}
	}

	async _loop() {
		const gen = this._gen;
		if (this._stopped || gen !== this._gen) return;
		this._lastLoopAt = Date.now();
		if (this._standby) {
			this._inStandbyPoll = true;
			try {
				await this._pollStandby();
			} catch {
				/* 待机轮询抛错（含活动探测）不得杀死采样链 */
			} finally {
				this._inStandbyPoll = false;
			}
			if (this._stopped || gen !== this._gen) return;
			if (this._standby) {
				this._schedule(this.standbyPollSec * 1000);
				return;
			}
			// 刚被唤醒：落到下方立即补一拍
		}
		const started = Date.now();
		try {
			await this._tick();
		} catch (err) {
			this._errors += 1;
			try {
				this.onError(err);
			} catch {
				/* 宿主回调自身抛错不得杀死采样链 / 变 unhandledRejection */
			}
		}
		if (this._stopped || gen !== this._gen) return;
		this._lastTickMs = Date.now() - started;
		this._lastLoopAt = Date.now();
		this._tickMsTotal += this._lastTickMs;
		try {
			this._evaluateStandby();
		} catch {
			/* 活动探测抛错不得杀死采样链 */
		}
		if (this._stopped || gen !== this._gen) return;
		this._schedule(Math.max(250, this.intervalSec * 1000 - this._lastTickMs));
	}

	_schedule(wait) {
		// 单一链句柄（review：同代双链）：_exitStandby 与在飞链尾都会调用 _schedule，
		// 不先撤旧定时器时后一次调用会把前一个句柄覆盖成孤儿 → 两个定时器同时点火。
		this._disposeTimer();
		// 闭包捕获代际：kick 重启后旧定时器若仍点火（宿主式句柄
		// 取消不掉），回调就地失效，不再开第二条并发链。
		const gen = this._gen;
		const handle = this.setTimer(() => {
			if (gen !== this._gen) return;
			this._loop();
		}, wait);
		if (handle && typeof handle.unref === "function") handle.unref();
		this._timer = handle;
	}

	async _tick() {
		if (this._busy) return;
		this._busy = true;
		this._busySince = Date.now();
		// 本拍代际：kick() 强清 _busy 重启后，仍在飞的旧拍恢复时
		// 不得再发事件（重复 onTick/onCensus、挪动普查节奏），也不得清掉新拍刚设的 _busy。
		const gen = this._gen;
		try {
			const now = Date.now();
			const cpuNow = cpuTimes();
			const cpuPct = cpuPercentBetween(this._cpuPrev, cpuNow);
			this._cpuPrev = cpuNow;
			this._lastCpuPct = cpuPct;
			const memAvailMB = Math.round(os.freemem() / 1048576);
			const gpus = await this._queryGpuTotals();
			if (gen !== this._gen) return; // 旧拍：丢弃陈旧事件（finally 不清 _busy）
			this._lastGpuUtil = gpus && gpus.length > 0 ? (gpus[0].utilPct ?? null) : null;
			this._ticks += 1;
			this.onTick({ k: "t", t: now, gpu: gpus && gpus.length > 0 ? gpus[0] : null, cpu: cpuPct, memAvailMB });
			if ((this._ticks - 1) % this._censusEvery === 0) await this._census(now);
		} finally {
			if (gen === this._gen) this._busy = false;
		}
	}

	async _nvidia() {
		if (Date.now() < this._nvidiaDisabledUntil) return null;
		if (this._nvidiaExe) return this._nvidiaExe;
		for (const candidate of NVIDIA_CANDIDATES) {
			const r = await runCommand(candidate, ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], 10000);
			if (r.ok) {
				this._nvidiaExe = candidate;
				return candidate;
			}
		}
		this._nvidiaDisabledUntil = Date.now() + 5 * 60_000;
		this.onError(new Error("nvidia-smi not found; GPU probing disabled for 5 minutes"));
		return null;
	}

	async _queryGpuTotals() {
		const exe = await this._nvidia();
		if (!exe) return null;
		const r = await runCommand(
			exe,
			["--query-gpu=timestamp,name,memory.total,memory.used,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
			15000
		);
		if (!r.ok) {
			this._errors += 1;
			this._nvidiaExe = null;
			this._nvidiaDisabledUntil = Date.now() + 60_000;
			this.onError(new Error(`nvidia-smi query-gpu failed: ${r.error ?? r.stderr.slice(0, 120)}`));
			return null;
		}
		return parseGpuTotals(r.stdout);
	}

	async _census(now) {
		const started = Date.now();
		const exe = await this._nvidia();
		const jobs = [
			exe
				? runCommand(exe, ["--query-compute-apps=pid,process_name,used_gpu_memory", "--format=csv,noheader"], 15000).then((r) =>
						r.ok ? parseComputeApps(r.stdout) : []
					)
				: Promise.resolve([]),
			runCommand("typeperf", [GPU_LOCAL, GPU_NONLOCAL, MEM_PAGES, DISK_IDLE, "-sc", "1"], 30000).then((r) => {
				const parsed = parseCensusCounters(r.stdout);
				if (!parsed && !r.ok) return null;
				return parsed; // 退出码非 0 但输出可解析时仍然接受
			}),
			runCommand("tasklist", ["/fo", "csv", "/nh"], 30000, "gbk").then((r) => (r.ok ? parseTasklist(r.stdout) : [])),
		];
		const [apps, counters, procs] = await Promise.all(jobs);
		if (!counters) {
			this._errors += 1;
			this.onError(new Error("typeperf census counters unavailable"));
		}
		const pidToName = new Map();
		for (const a of apps) pidToName.set(a.pid, a.exe);
		for (const p of procs) if (!pidToName.has(p.pid)) pidToName.set(p.pid, p.name);
		const gpuProcs = [];
		let nonLocalTotalMiB = null;
		if (counters) {
			nonLocalTotalMiB = Math.round(counters.totalNonLocalBytes / 1048576);
			for (const [pid, e] of counters.byPid) {
				const localMiB = e.localBytes / 1048576;
				const nlMiB = e.nonLocalBytes / 1048576;
				if (localMiB + nlMiB < this.minGpuProcMB) continue;
				const exe = pidToName.get(pid);
				gpuProcs.push({
					pid,
					name: exe ? baseName(exe) : `pid ${pid}`,
					localMiB: Math.round(localMiB),
					nonLocalMiB: Math.round(nlMiB),
				});
			}
			gpuProcs.sort((a, b) => b.localMiB + b.nonLocalMiB - (a.localMiB + a.nonLocalMiB));
			if (gpuProcs.length > this.maxGpuProcs) gpuProcs.length = this.maxGpuProcs;
		}
		const rss = aggregateRss(procs, this.topRssCount);
		this._censuses += 1;
		this._censusMsTotal += Date.now() - started;
		this.onCensus({
			k: "c",
			t: started,
			gpuProcs,
			nonLocalTotalMiB,
			pagesPerSec: counters?.pagesPerSec ?? null,
			diskIdlePct: counters?.diskIdlePct ?? null,
			rss,
		});
	}

	stats() {
		const uptimeMs = Date.now() - this._startedAt;
		const usage = process.cpuUsage(this._cpuUsageStart);
		const hostCpuMs = (usage.user + usage.system) / 1000;
		// 停摆阈值与 kick() 共用 STALL_FACTOR，且按当前周期取分母：待机时一轮 =
		// standbyPollSec（默认 30s），按在线周期算会把健康轮询误报成停摆。
		const stallBaseSec = this._standby ? this.standbyPollSec : this.intervalSec;
		return {
			startedAt: new Date(this._startedAt).toISOString(),
			uptimeSec: Math.round(uptimeMs / 1000),
			intervalSec: this.intervalSec,
			censusIntervalSec: this.censusIntervalSec,
			ticks: this._ticks,
			censuses: this._censuses,
			errors: this._errors,
			lastTickMs: this._lastTickMs,
			avgTickMs: this._ticks > 0 ? Math.round(this._tickMsTotal / this._ticks) : null,
			avgCensusMs: this._censuses > 0 ? Math.round(this._censusMsTotal / this._censuses) : null,
			hostCpuMs: Math.round(hostCpuMs),
			hostCpuPctOfOneCore: uptimeMs > 0 ? Math.round((hostCpuMs / uptimeMs) * 1000) / 10 : null,
			gpuMonitoring: this._nvidiaExe ? true : Date.now() < this._nvidiaDisabledUntil ? false : "probing",
			memTotalMB: this.memTotalMB,
			restarts: this._restarts,
			stalled: !this._stopped && Date.now() - this._lastLoopAt > stallBaseSec * 1000 * STALL_FACTOR,
			standby: this._standby,
			idleForSec: this._standby ? Math.round((Date.now() - this._standbyAt) / 1000) : null,
			standbyEnabled: this.standbyEnabled,
		};
	}
}
