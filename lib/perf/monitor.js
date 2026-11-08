/**
 * dsh-plugin-perfmon — 主线程监测器（worker 优先，inline 兜底）
 * ============================================================
 * mode=auto（默认）：采样循环跑在 worker 线程（见 worker-entry.mjs），
 *   主线程只读 data\ 文件与维护 marks —— 宿主清理不到 worker 的定时器，
 *   采样真正持续。worker 意外退出时由 kick() 在下次工具调用时拉起。
 * mode=inline：回退为主线程 PerfSampler（kick 自愈模式，仅供诊断/测试；
 *   在宿主内该模式采样链会在首拍后停摆）。
 *
 * 数据通路：worker 每次普查后写 k:'s' 心跳行（含 stats），主线程
 * store.refreshFromDisk() 在每次工具调用时刷新内存视图与 lastStats。
 */
import { Worker } from "node:worker_threads";
import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { PerfSampler } from "./sampler.js";

/** 静默降级点至少留一笔可诊断日志：bare catch 把 postMessage
 *  失败、terminate 抛错等真实故障完全吞掉，worker 消息链路损坏后停摆不可诊断；
 *  monitor 无法拿到 ctx.logger，退而求其次用 console.warn（宿主主线程日志可见）。 */
const _warn = (where, e) => {
	try {
		console.warn(`[perfmon:monitor] ${where}: ${String(e?.message ?? e)}`);
	} catch {}
};

export class PerfMonitor {
	constructor({ store, config, mode = "auto" }) {
		this.store = store;
		this.config = config ?? {};
		// 2026-10-07 六轮定位终版：宿主内 Worker 模块加载完全不可用（eval 探针证明
		// Worker 线程本身正常，但无论文件路径/URL/动态 import 都无法加载模块）。
		// 默认走 inline + kick 自愈；worker/auto 保留给独立进程与 selftest。
		this.mode = mode === "worker" || mode === "auto" ? "worker-pending" : "inline";
		this._worker = null;
		this._workerAlive = false;
		this._sampler = null;
		this._restarts = 0;
		this._stopped = false;
	}

	start() {
		this._stopped = false; // stop 后复用时重新武装（与 sampler.start 同语义）
		if (this.mode === "inline") {
			this._startInline();
			return;
		}
		try {
			this._startWorker();
		} catch {
			this._startInline();
		}
	}

	_startWorker() {
		const workerPath = fileURLToPath(new URL("./worker-entry.mjs", import.meta.url));

		// 2026-10-07 五轮定位终版：Worker 线程本身正常（eval 模式实测），问题在
		// 宿主的**文件模块加载**不覆盖 Worker 内部——new Worker(path) 的模块加载
		// 静默失败（worker-started.marker 不存在）。修法：eval: true 模式包一层
		// bootstrap，内联代码里动态 import() 真正的 worker-entry.mjs——eval 绕过
		// Worker 构造器的文件加载，动态 import 走标准 ESM 解析器（与主线程无关）。
		const workerUrl = pathToFileURL(workerPath).href;
		const worker = new Worker(
			// 这段代码在 Worker 的 CJS 上下文执行；import() 是 CJS 里合法的动态 ESM 导入
			`import(${JSON.stringify(workerUrl)}).catch(e => {` +
			`  try { require("fs").appendFileSync(` +
			`    require("path").join(${JSON.stringify(this.config?.dataDir ?? ".")}, "worker-crash.log"),` +
			`    "[" + new Date().toISOString() + "] dynamic-import-failed: " + String(e && e.stack || e) + "\\n"` +
			`  ); } catch {}` +
			`  process.exit(1);` +
			`});`,
			{ eval: true, workerData: this.config },
		);
		this._worker = worker;
		this._workerAlive = true;
		this.mode = "worker";
		// 2026-10-07 四轮定位：宿主事件循环里 unref'd Worker 可能被提前回收——
		// worker-url.marker 存在但 worker-started.marker 不存在 = Worker 创建成功
		// 但模块体从未执行。去掉 unref（宿主是常驻进程，不需要 worker 保活）。
		// worker.unref?.();
		// 回调按实例隔离（与 this._worker 比对）：旧实例迟到的
		// exit/error 不得改写新实例的存活标记——否则 kick() 虚增 restarts 并再拉
		// 一个 worker，被覆盖的旧实例未被 terminate，双实例双写。
		worker.on("exit", () => {
			if (this._worker !== worker) return;
			this._workerAlive = false;
			// 不在 exit 里 degrade：那会抢在 kick() 的重启分支之前把 mode 切到
			// inline，worker 永远不会被重新拉起（2026-10-07 selftest 实测 3 FAIL）。
			// 正确的兜底通道是 worker-entry 的 crash-log+重抛 → 父线程 'error' 事件。
		});
		worker.on("error", () => {
			if (this._worker !== worker) return;
			this._workerAlive = false;
			// worker 异步失败（入口缺失/语法错误/未捕获异常）不经 start() 的同步 catch，
		// 直接降级 inline 兜底，kick() 才不会无限重拉同一个坏 worker。
			this._degradeToInline();
		});
	}

	/** worker 异步失败后的 inline 兜底（幂等：已在 inline 则不再重复起）。 */
	_degradeToInline() {
		if (this.mode === "inline" || this._sampler !== null) return;
		const stale = this._worker;
		this._worker = null; // 摘引用：该实例后续 exit 事件不再被认领
		if (stale) {
			try { stale.terminate(); } catch (e) { _warn("terminate(stale)", e); }
		}
		try {
			this._startInline();
		} catch {
			/* inline 也起不来：保持停摆，stats 的 mode/workerAlive 如实反映 */
		}
	}

	_startInline() {
		const store = this.store;
		this._sampler = new PerfSampler({
			intervalSec: this.config.intervalSec,
			censusIntervalSec: this.config.censusIntervalSec,
			minGpuProcMB: this.config.minGpuProcMB,
			maxGpuProcs: this.config.maxGpuProcs,
			topRssCount: this.config.topRssCount,
			onTick: (r) => store.append(r),
			onCensus: (r) => {
				store.append(r);
				store.append({ k: "s", t: Date.now(), ...this._sampler.stats() });
			},
		});
		this.mode = "inline";
		this._sampler.start();
	}

	/** 每次工具调用触发：唤醒 worker（瞬时）+ 死亡即拉起；inline 模式交给 sampler.kick() 自愈。
	 *  stop() 之后 worker 分支短路不复活；inline 分支例外（2026-10-11）：宿主
	 *  启动早期会 dispose 一次 fiber（HMR/profile 同步），effect disposer 调 stop()，但工具表仍指向
	 *  旧闭包（同名工具注册不覆盖旧对象）——旧 kick 永久短路会让采样链静默死亡
	 *  （实测 0 ticks/0 restarts/0 errors，data\ 连 jsonl 都不出现）。工具被调用本身就是"闭包仍在
	 *  服役"的证明：inline 链复活成本极低（宿主内本就靠 kick 续命），worker 是重资源仍不复活。 */
	kick() {
		if (this._stopped) {
			if (this.mode === "inline" && this._sampler) {
				this._stopped = false;
				try {
					this._sampler.start(); // stop 后复用重新武装（ 同语义）
				} catch (e) {
					_warn("revive(sampler.start)", e);
				}
			}
			if (this._stopped) return false;
		}
		if (this.mode === "worker") {
			try {
				this._worker?.postMessage({ type: "wake" });
			} catch (e) { _warn("postMessage(wake)", e); }
			if (!this._workerAlive) {
				this._restarts += 1;
				// 重启前先摘引用并 terminate 旧实例：旧实例迟到的
				// exit/error 不再被认领，也未终止的旧实例也不会与新实例重叠双写。
				const stale = this._worker;
				this._worker = null;
				if (stale) {
					try { stale.terminate(); } catch (e) { _warn("terminate(restart)", e); }
				}
				try {
					this._startWorker();
					return true;
				} catch {
					this._startInline();
					return true;
				}
			}
			return false;
		}
		if (this.mode === "inline" && this._sampler) return this._sampler.kick();
		return false;
	}

	/** 活动打点存在期间强制在线（转发给 worker / inline sampler）。 */
	notifyMarks(active) {
		if (this._stopped) return; // 已停机不再转发
		try {
			this._worker?.postMessage({ type: "marks", active: Boolean(active) });
		} catch (e) { _warn("postMessage(marks)", e); }
		try {
			this._sampler?.setMarkActive(Boolean(active));
		} catch (e) { _warn("setMarkActive", e); }
	}

	stop() {
		// 停机标记：此后 kick()/notifyMarks() 短路——否则 dispose 与
		// 工具调用并发时，任何一次 kick 都会命中 !alive 分支把已 terminate 的 worker 复活。
		this._stopped = true;
		// 先摘引用再 terminate：停机触发的 exit/error 不再被回调认领（避免误降级/改状态）。
		// 不再 postMessage({type:"stop"})——terminate 抢在线程消费该消息之前拆除它，
		// 那条停止消息是死代码；terminate 返回的 Promise 收尾失败也不让它变 unhandledRejection。
		const w = this._worker;
		this._worker = null;
		try {
			if (w) {
				const done = w.terminate();
				if (done && typeof done.catch === "function") done.catch(() => {});
			}
		} catch (e) { _warn("terminate(stop)", e); }
		try {
			this._sampler?.stop();
		} catch (e) { _warn("sampler.stop", e); }
		this._workerAlive = false;
	}

	stats() {
		const raw =
			this.mode === "worker"
				? this.store.lastStats ?? {}
				: this._sampler?.stats() ?? this.store.lastStats ?? {};
		const { k: _k, t: _t, ...base } = raw; // 心跳行带来的 k/t 杂键剔除
		// restarts 语义分离：base.restarts 是采样链自愈计数（worker 心跳
		// 里也带），workerRestarts 才是 monitor 拉起 worker 的次数——原来两者相加会把
		// 「worker 从未重启、采样链自愈过 N 次」误报成 restarts=N。...base 放前面，
		// monitor 自身的键不再可能被心跳同名键静默覆盖。
		return {
			...base,
			mode: this.mode,
			workerAlive: this.mode === "worker" ? this._workerAlive : null,
			workerRestarts: this._restarts ?? 0,
		};
	}

	get memTotalMB() {
		if (this.mode === "inline" && this._sampler) return this._sampler.memTotalMB;
		const v = this.store.lastStats?.memTotalMB;
		return Number.isFinite(v) ? v : null;
	}
}
