/**
 * dsh-plugin-image-gen / lib/gateway.js
 * =====================================
 * 引擎与网关的自愈层 + HTTP 客户端（从 lib/index.js 拆出，纯代码移动）：
 * 健康探测（区分「网关没起」与「引擎忙」）、隐藏拉起（detached + windowsHide +
 * 日志落盘，绝不弹控制台）、端口/冷却双守卫、callGateway（硬失败）与
 * callGatewaySoft（404=未产出，轮询用）。ensureBackendReady 是生图前的统一预检。
 */
import { spawn, execSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import {
	ENGINE_LOG_DIR,
	ENGINE_PYTHON,
	ENGINE_START_BAT,
	resolveGatewayDir,
	resolveGatewayLogDir,
	hfEndpointEnv
} from "../paths.js";

/**
 * 引擎与网关的自动恢复常量。
 * 引擎生命周期的**所有者是 comfy 插件**；下面那套隐藏拉起只是「管理器不可用」
 * 时的兜底，且必须与它同姿势（detached + windowsHide + 日志落盘），绝不走 bat。
 */
// 路径全部来自 lib/paths.js（IMAGEKIT_INSTALL_ROOT / IMAGEKIT_GATEWAY_DIR 可覆盖），
// 本文件不再出现写死的盘符路径。
const ENGINE_PORT = 8188;
const ENGINE_PY = ENGINE_PYTHON;
/** 仅供人工排查时手动执行；插件自身不再调用它（它会开可见控制台并有 pause）。 */
const ENGINE_BAT_HINT = ENGINE_START_BAT;
const GATEWAY_DIR = resolveGatewayDir();
const GATEWAY_PY = ENGINE_PY;
const GATEWAY_LOG_DIR = resolveGatewayLogDir(GATEWAY_DIR);

/** 散落的魔法数集中为具名常量（含义与旧内联值一致）。 */
const HEALTH_TIMEOUT_MS = 6000;
const GATEWAY_WAIT_MS = 120000;
const VRAM_COLD_GB = 10;
const VRAM_WARM_GB = 1.5;
const TAIL_MAX_BYTES = 8000;

/** 自动拉起冷却（同类服务 60 秒内至多一次，防误判风暴导致的重复进程/窗口）。 */
const AUTO_LAUNCH_COOLDOWN_MS = 60000;
const lastAutoLaunch = { gateway: 0, engine: 0 };

/** 端口占用探测：有监听者返回 true（拉起前的硬守卫）。 */
function portOccupied(port) {
	try {
		const out = execSync("netstat -ano -p tcp", { encoding: "utf8", timeout: 15000, windowsHide: true });
		return new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, "m").test(out);
	} catch {
		return false;
	}
}

function portOf_(base) {
	const m = String(base).match(/:(\d+)\/?$/);
	return m ? Number(m[1]) : 8189;
}

/**
 * 合并调用方的 `exec.signal` 与本工具的本地超时。
 *
 * 官方《工具编写参考》把「遵守 `exec.signal`」列为硬性规则（信号触发时取消进行中的
 * 工作），因此不能只挂 `AbortSignal.timeout` 而丢掉调用方的取消信号。
 */
function withDeadline(timeoutMs, signal) {
	// timeoutMs 缺省/非正数时 AbortSignal.timeout(undefined) 会坏掉整条调用
	//（Node 24 同步抛 ERR_INVALID_ARG_TYPE；按 DOM 规范实现的运行期则 NaN→0 立即超时）——
	// 只在有效正数时创建本地超时信号；否则只用调用方信号（不设本地超时）
	const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
	if (deadline === null) return signal ?? null;
	return signal === undefined || signal === null ? deadline : AbortSignal.any([signal, deadline]);
}

/**
 * 调用方取消（exec.signal）必须向上传播。
 * 降级 catch 不能把「已取消」变成「部分成功」——官方规则要求信号触发时停止工作，
 * 而不是继续跑完并返回一个看起来正常的结果。
 */
function rethrowIfAborted(error, signal) {
	if (signal !== undefined && signal !== null && signal.aborted) throw error;
}

/**
 * 网关健康探测："up" | "engine-down" | "gateway-down"。
 * 关键区分（2026-10-02 多窗口事故修正）：连接被拒 = 网关真没起（可拉起）；
 * 超时/重置 = 网关在但忙（引擎忙时 /health 转发引擎状态可能超时）——重试后
 * 结合端口占用判定，绝不因超时误拉起。
 */
async function gatewayHealth(base, signal) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(base + "/health", { signal: withDeadline(HEALTH_TIMEOUT_MS, signal) });
			const json = await res.json().catch(() => ({}));
			return res.ok && json?.ok ? "up" : "engine-down";
		} catch (err) {
			rethrowIfAborted(err, signal);
			if (String(err?.cause?.code ?? "") === "ECONNREFUSED") return "gateway-down";
			// 重试间隔要能被 exec.signal 打断——取消不该等满 2s×2 的间隔才生效
			await sleepAbortable(2000, signal);
		}
	}
	// 三次无应答：端口有人听 = 网关活着只是忙（按引擎侧处理）；没人听 = 真掉了
	return portOccupied(portOf_(base)) ? "engine-down" : "gateway-down";
}

/** 可被 exec.signal 立刻打断的等待（轮询循环里用，避免取消后还多等一个间隔）。 */
function sleepAbortable(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** 读文件尾部若干行：让「后台静默失败」能从工具返回值里直接看到原因。 */
function tailFile(file, lines = 8) {
	try {
		const size = statSync(file).size;
		const len = Math.min(size, TAIL_MAX_BYTES);
		const fd = openSync(file, "r");
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		closeSync(fd);
		return buf.toString("utf8").split("\n").filter((l) => l.trim() !== "").slice(-lines).join("\n");
	} catch {
		return "";
	}
}

/**
 * 隐藏拉起引擎（兜底路径）：与 comfy 完全同姿势 —— detached + windowsHide +
 * stdout/stderr 落盘，**不弹控制台、不打开任何页面**。
 * 产出与 start_comfyui.bat 一致（含 HF_ENDPOINT 镜像，自定义节点下载配置/权重时用得到）。
 */
function launchEngineHidden(config) {
	mkdirSync(ENGINE_LOG_DIR, { recursive: true });
	// fd 交给子进程后父进程（常驻宿主）要立即关掉自己的副本——否则每次自动
	// 拉起永久泄漏 2 个 fd 并占住日志文件句柄；第二个 openSync 抛错时 finally 也兜住第一个
	const out = openSync(path.join(ENGINE_LOG_DIR, "engine.log"), "a");
	let err;
	try {
		err = openSync(path.join(ENGINE_LOG_DIR, "engine.err.log"), "a");
		const child = spawn(
			ENGINE_PY,
			[
				"-u", "-s", "ComfyUI/main.py", "--windows-standalone-build",
				// 同 comfy：--windows-standalone-build 会打开 auto_launch，
				// 不显式关掉就会在后台拉起时弹出浏览器页面。
				"--disable-auto-launch",
				"--listen", "127.0.0.1", "--port", String(ENGINE_PORT)
			],
			{
				cwd: ENGINE_ROOT,
				detached: true,
				stdio: ["ignore", out, err],
				windowsHide: true,
				env: { ...process.env, ...hfEndpointEnv(config) }
			}
		);
		// spawn 失败（如 python.exe 不存在，ENOENT）会以无监听的 'error' 事件
		// 打崩整个宿主进程——必须挂监听；失败原因落日志，保证「静默拉起」仍然可诊断
		child.on("error", (e) => {
			try { appendFileSync(path.join(ENGINE_LOG_DIR, "engine.err.log"), `[spawn] ${String(e?.message ?? e)}\n`, "utf8"); } catch { /* 日志写失败无声 */ }
		});
		child.unref();
	} finally {
		closeSync(out);
		if (err !== undefined) closeSync(err);
	}
}

/**
 * 隐藏拉起网关：无控制台窗口，stdout/stderr 落盘到 GATEWAY_LOG_DIR
 * 的 gateway(.err).log（死后可查因，不再依赖易丢的控制台）。
 * 依赖已就绪（python_embeded 已装 fastapi/uvicorn/httpx），跳过 bat 的 pip 检查。
 */
function launchGatewayHidden(config) {
	mkdirSync(GATEWAY_LOG_DIR, { recursive: true });
	// 同 launchEngineHidden——fd 用完即关（不泄漏不占文件句柄），spawn 必须挂
	// 'error' 监听（ENOENT 等失败不能以 uncaughtException 打崩宿主），失败原因落日志可诊断
	const out = openSync(path.join(GATEWAY_LOG_DIR, "gateway.log"), "a");
	let err;
	try {
		err = openSync(path.join(GATEWAY_LOG_DIR, "gateway.err.log"), "a");
		const child = spawn(GATEWAY_PY, ["app.py"], {
			cwd: GATEWAY_DIR,
			detached: true,
			stdio: ["ignore", out, err],
			windowsHide: true,
			env: { ...process.env, ...hfEndpointEnv(config), VRAM_IDLE_FREE_MINUTES: "10" }
		});
		child.on("error", (e) => {
			try { appendFileSync(path.join(GATEWAY_LOG_DIR, "gateway.err.log"), `[spawn] ${String(e?.message ?? e)}\n`, "utf8"); } catch { /* 日志写失败无声 */ }
		});
		child.unref();
	} finally {
		closeSync(out);
		if (err !== undefined) closeSync(err);
	}
}

/** 带双守卫的自动拉起：端口已有人听 / 冷却期内 -> 不动作，返回 false。 */
function guardedLaunch(kind, port, launchFn) {
	if (portOccupied(port)) return false;
	if (Date.now() - lastAutoLaunch[kind] < AUTO_LAUNCH_COOLDOWN_MS) return false;
	lastAutoLaunch[kind] = Date.now();
	launchFn();
	return true;
}

/**
 * 预检与自动恢复（生图前调用 ComfyUI 管理器核对引擎状态）：
 * 1) 网关掉线（连接被拒且端口无人听）-> 守卫后隐藏拉起网关（日志落盘，无窗口弹窗）；
 * 2) 引擎侧不可用 -> 直接调用 comfy（同宿主工具注册表）拉起；若其报告
 *    alreadyRunning，说明引擎活着只是忙（/health 超时典型情形）——直接提交排队；
 *    管理器不可用时退回与它同姿势的**隐藏 python 拉起**（windowsHide，无控制台；
 *    同样带端口+冷却双守卫）——刻意不走 bat，因为 bat 会开可见控制台并有 pause；
 * 3) 就绪后取队列/显存快照随结果返回（工作状态监测）。
 */
async function ensureBackendReady(config, ctx, signal) {
	// 本函数是导出 API，调用方未必经 index.js 的 Schema 归一化——
	// selfHealWaitSeconds 缺省/非正数时 NaN 会让引擎等待循环一次都不执行，失败消息还会
	// 打出 "within undefineds"；兑底到与 Schema 默认一致的 420s（见 index.js 的 default(420)）
	if (!(Number.isFinite(config.selfHealWaitSeconds) && config.selfHealWaitSeconds > 0)) {
		config = { ...config, selfHealWaitSeconds: 420 };
	}
	const report = { gateway: "up", engine: "up", queue_running: null, queue_pending: null, vram_free_gb: null, actions: [] };
	let state = await gatewayHealth(config.gatewayUrl, signal);
	if (state === "gateway-down") {
		// 守卫端口从 config.gatewayUrl 派生（与探测同源）——此前写死 8189，
		// 配了非 8189 端口时守卫会以为端口空闲而拉起进程、探测却盯着另一个端口，自愈自相矛盾
		const launched = guardedLaunch("gateway", portOf_(config.gatewayUrl), () => launchGatewayHidden(config));
		report.actions.push(
			launched
				? `auto-started gateway (hidden: no console window; logs in ${GATEWAY_LOG_DIR})`
				: "gateway start skipped (port occupied or cooldown active)"
		);
		// 网关本身轻量（fastapi 导入 + 监听），120s 内起不来基本可判真故障；
		// 引擎冷启动才是 3-8 分钟的大头，见下方 selfHealWaitSeconds。
		const gatewayWaitMs = GATEWAY_WAIT_MS;
		const deadline = Date.now() + gatewayWaitMs;
		while (Date.now() < deadline) {
			// 等待网关起身的间隔也要可被取消——取消后不再多等 2.5s + 一次探测
			await sleepAbortable(2500, signal);
			state = await gatewayHealth(config.gatewayUrl, signal);
			if (state !== "gateway-down") break;
		}
		if (state === "gateway-down") {
			const tail = tailFile(path.join(GATEWAY_LOG_DIR, "gateway.err.log"), 8) || tailFile(path.join(GATEWAY_LOG_DIR, "gateway.log"), 8);
			throw new Error(
				`Gateway at ${config.gatewayUrl} still unreachable ${gatewayWaitMs / 1000}s after a hidden auto-start attempt. ` +
					(tail ? `Gateway log tail:\n${tail}\n` : "") +
					`Recover without asking the user: inspect ${GATEWAY_LOG_DIR}, or start the gateway ` +
					`manually in ${GATEWAY_DIR} (run app.py), then retry.`
			);
		}
		report.gateway = "started";
	}
	if (state === "engine-down") {
		let via = null;
		let alreadyRunning = false;
		try {
			const ctl = ctx.tools?.get?.("comfy");
			if (ctl && typeof ctl.execute === "function") {
				// 网关口径：comfy(action=control, op=start)；原 comfy_control 的 start 就是 op=start。
				const r = await ctl.execute({ action: "control", op: "start" }, undefined);
				via = "comfy";
				alreadyRunning = Boolean(r?.alreadyRunning);
			}
		} catch {
			/* 管理器路径失败 -> 退回与它同姿势的隐藏拉起（无窗口） */
		}
		if (via === null) {
			const launched = guardedLaunch("engine", ENGINE_PORT, () => launchEngineHidden(config));
			via = launched ? "hidden python (windowsHide, no console)" : null;
			if (via === null) {
				throw new Error(
					`ComfyUI engine appears down and auto-start is guarded (port occupied or cooldown). ` +
						`Call comfy(action=status) for diagnosis, then retry. Manual path (opens a console window, human only): ${ENGINE_BAT_HINT}`
				);
			}
		}
		if (alreadyRunning) {
			report.actions.push("engine busy (comfy reports alreadyRunning); submitting to the queue");
		} else {
			report.actions.push(`started ComfyUI engine via ${via}`);
			// v1.5.1：150s → selfHealWaitSeconds（默认 420s）。实测完整冷启动 3-8 分钟，
			// 旧值探针多次观察到「首次超时、重试才成功」——重试的第二次等待其实是在给第一次的拉起续命。
			const engineWaitMs = config.selfHealWaitSeconds * 1000;
			const deadline = Date.now() + engineWaitMs;
			// 等待可被取消；且循环内刚探过的结果直接复用——结束后不再重复一次
			// 完整 gatewayHealth（最坏 ~22s），既免重复探测也守住 selfHealWaitSeconds 的名义上限
			let engineUp = false;
			while (Date.now() < deadline) {
				await sleepAbortable(4000, signal);
				if ((await gatewayHealth(config.gatewayUrl, signal)) === "up") {
					engineUp = true;
					break;
				}
			}
			if (!engineUp) {
				const tail = tailFile(path.join(ENGINE_LOG_DIR, "engine.err.log"), 8) || tailFile(path.join(ENGINE_LOG_DIR, "engine.log"), 8);
				throw new Error(
					`ComfyUI engine did not become ready within ${config.selfHealWaitSeconds}s after auto-start via ${via}. ` +
						(tail ? `Engine log tail:\n${tail}\n` : "") +
						`Recover without asking the user: call comfy(action=status) (it returns the same log tail) for diagnosis, then retry.`
				);
			}
			report.engine = "started";
			report.engine_started_via = via;
		}
	}
	try {
		const q = await callGateway(config.gatewayUrl, "/status", { timeoutMs: 8000, signal });
		report.queue_running = q.queue_running ?? 0;
		report.queue_pending = q.queue_pending ?? 0;
		report.vram_free_gb = q.vram?.free_vram_gb ?? null;
	} catch (error) {
		rethrowIfAborted(error, signal);
		/* 快照失败不阻断生成 */
	}
	// 引擎热状态推断：ComfyUI 无"已加载模型清单"公开 API，以空闲显存近似判定
	if (report.vram_free_gb !== null) {
		report.engine_thermal = classifyEngineThermal(report.vram_free_gb);
	}
	return report;
}

/** 冷/温/饱和三阈值分类——抽成具名 helper（if/else 早返回），禁写嵌套三元。 */
function classifyEngineThermal(vramFreeGb) {
	if (vramFreeGb >= VRAM_COLD_GB) return "cold (no model resident; first generation pays a 7-20s model load)";
	if (vramFreeGb >= VRAM_WARM_GB) return "warm (model likely resident; ready to generate fast)";
	return "saturated (VRAM nearly full — busy or a heavy model is loaded)";
}

/**
 * callGateway 与 callGatewaySoft 的公共骨架——发请求（withDeadline 合成
 * 信号）、网络层失败转成模型可行动的错误（取消原样上抛 + 网关日志尾随）、读出响应文本。
 * 两个调用方在此之上只保留各自的差异（硬失败 vs 404=未产出）；此前两份 ~30 行近乎逐行
 * 相同的副本（连报错文案都已各自漂移）正是「改一处漏一处」的温床。网络错误的报错文案
 * 统一取硬失败版（带恢复指引）——轮询路径遇到网络层故障时同样需要这些建议。
 */
async function requestGateway(base, pathname, { method = "GET", body, timeoutMs, signal } = {}) {
	let res;
	try {
		res = await fetch(base + pathname, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: withDeadline(timeoutMs, signal)
		});
	} catch (err) {
		// 调用方取消（exec.signal）要原样抛出 AbortError，别包装成"网关不可达"——
		// 否则宿主只能看到一个普通错误，无法把取消与真实故障区分开。
		rethrowIfAborted(err, signal);
		const reason = String(err?.cause ?? err?.message ?? err);
		const gtail = tailFile(path.join(GATEWAY_LOG_DIR, "gateway.err.log"), 6);
		throw new Error(
			`Image gateway unreachable at ${base} (${reason}). ` +
				(gtail ? `Gateway log tail:\n${gtail}\n` : "") +
				`Recover without asking the user: 1) check the ComfyUI engine with comfy(action=status) — if it is down, ` +
				`start it via comfy {action:"start"} (shared engine, seen on comfyBaseUrl); ` +
				`2) if the engine is fine but the gateway is down, start it in ${GATEWAY_DIR} (port 8189), ` +
				`wait a few seconds, then retry.`
		);
	}
	return { res, text: await res.text() };
}

/** 调网关并把失败转成模型可行动的错误信息。 */
async function callGateway(base, pathname, opts = {}) {
	const { res, text } = await requestGateway(base, pathname, opts);
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	if (!res.ok) {
		const detail = json?.detail ?? text;
		throw new Error(`Gateway ${opts.method ?? "GET"} ${pathname} -> HTTP ${res.status}: ${JSON.stringify(detail).slice(0, 2000)}`);
	}
	return json;
}

/**
 * 与 callGateway 同源，但**不把 HTTP 错误当异常**——轮询 `/result/{id}` 时
 * 404 就是「还没产出」的正常语义，不能当成故障。网络层错误仍照常抛。
 */
async function callGatewaySoft(base, pathname, opts = {}) {
	const { res, text } = await requestGateway(base, pathname, opts);
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: res.status, ok: res.ok, json, text };
}

export {
	ENGINE_LOG_DIR,
	GATEWAY_LOG_DIR,
	// 导出网关等待上限——tools.js 推导工具硬超时要盖住的最坏链路用它做输入
	GATEWAY_WAIT_MS,
	rethrowIfAborted,
	sleepAbortable,
	tailFile,
	callGateway,
	callGatewaySoft,
	ensureBackendReady,
	// 出图后端选择要判断「网关在不在线」（auto 模式下离线就切内置直连）
	gatewayHealth,
};
