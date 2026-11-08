/**
 * dsh-plugin-comfyui — ComfyUI 引擎管理器
 * ==========================================
 * 为所有会话注册一个模型可见网关工具 comfy（action = status | control | upgrade），管理 <installRoot>/engine 的唯一共享引擎：
 *
 *   - action=status             运行状态（运行中/PID/启动档位/运行时长）、版本、显存占用、
 *                     任务队列（执行中/已完成/失败）、模型源清单（各工具专属目录）、日志尾部
 *   - action=control & op=...   启动/停止/重启（normal | lowvram 档位）、卸载模型释放显存、中断当前任务
 *   - action=upgrade & mode=... 版本检查（本地 vs GitHub 最新 release）与一键升级（git 更新 + 重启 + 验证）
 *
 * 架构约定：引擎本体在 <installRoot>/engine（代码 + 配置，不含模型文件）；
 * 模型归各工具所有（各自专属模型目录），经
 * extra_model_paths.yaml 注册给引擎 — 零拷贝、零搬迁。
 *
 * 官方依赖契约：工具用宿主提供的 defineTool（@deepseek-ai/dsh-tools）声明，
 * 参数走官方 author schema DSL（属性上标 required: true，无顶层 type/required 数组）；
 * 配置用 Schemastery（@deepseek-ai/schemastery）的 Config 导出，默认值写在 schema 里。
 * 二者均声明为 peerDependencies（+ 同版本 devDependencies），运行时由宿主解析。
 *
 * config（cordis.patch.yml，schema 见下方 Config；此处仅为说明）：
 *   engineRoot          引擎根目录，默认 <installRoot>/engine/ComfyUI_windows_portable
 *   baseUrl             引擎 HTTP 地址，默认 http://127.0.0.1:8188
 *   stateFile           插件管理的运行状态文件（pid/档位/启动时间）
 *   logsDir             引擎日志目录（插件启动时 stdout/stderr 重定向至此）
 *   startTimeoutSeconds 启动轮询上限，默认 90
 *   registryYaml        可选：模型源注册表覆盖（默认 <engineRoot>\ComfyUI\extra_model_paths.yaml）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ENGINE_LOG_DIR, ENGINE_ROOT, detectComfyUiInstalls, engineLogCandidates, hfEndpointEnv } from "../paths.js";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tool-comfyui";
/** 依赖的宿主服务：工具注册器与系统提示组装。 */
const inject = ["tools", "systemPrompt"];

/**
 * 官方配置契约：导出 Standard Schema（Schemastery）的 Config。
 * Cordis 在插件加载时按它校验该行的 config 并填默认值；不合法即响亮失败。
 * registryYaml 不在 config 里也合法 —— 无默认值即为可选覆盖项。
 */
const Config = Schema.object({
	engineRoot: Schema.string()
		.default(ENGINE_ROOT)
		.description("引擎根目录（便携版解包目录，内含 python_embeded 与 ComfyUI 子目录）"),
	baseUrl: Schema.string().default("http://127.0.0.1:8188").description("引擎 HTTP 地址（默认 http://127.0.0.1:8188）"),
	stateFile: Schema.string().default(path.join(path.dirname(ENGINE_ROOT), "engine-state.json")).description("插件管理的运行状态文件（pid/档位/启动时间）"),
	logsDir: Schema.string().default(ENGINE_LOG_DIR).description("引擎日志目录（插件启动时 stdout/stderr 重定向至此）"),
	startTimeoutSeconds: Schema.number().default(90).min(30).description("启动轮询上限秒数（默认 90）"),
	registryYaml: Schema.string().description("可选：模型源注册表覆盖路径（默认 <engineRoot>\\ComfyUI\\extra_model_paths.yaml）"),
});

/* ------------------------------------------------------------------ */
/* 引擎 HTTP 基础设施                                                    */
/* ------------------------------------------------------------------ */

/**
 * 合并调用方的 `exec.signal` 与本地超时。
 * 官方《工具编写参考》把「遵守 `exec.signal`」列为硬性规则：只挂 AbortSignal.timeout
 * 会把调用方的取消信号丢掉。
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
 * 降级 catch 不能把「已取消」变成「部分成功」——官方规则要求信号触发时停止工作。
 */
function rethrowIfAborted(error, signal) {
	if (signal !== undefined && signal !== null && signal.aborted) throw error;
}

async function callEngine(base, pathname, { method = "GET", body, timeoutMs = 10000, signal } = {}) {
	const res = await fetch(base + pathname, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: withDeadline(timeoutMs, signal),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`ComfyUI ${method} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * 补完 + P1 阻塞类评估：spawnSync/execSync 会把常驻宿主的事件循环整个冻结
 * （runUpdater 最长 10 分钟；netstat/git/taskkill 各自的 15-20s 上限也不短），全部换异步 spawn。
 * 输出累计超过 maxBuffer 停止收集并标 truncated（比 spawnSync 的 ENOBUFS 报错温和）。
 */
function runAsync(file, args, { cwd, timeoutMs = 15000, maxBuffer = 8 * 1024 * 1024 } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ status: null, error: `spawn failed: ${String(error?.message ?? error)}`, stdout: "", stderr: "", truncated: false, timedOut: false });
			return;
		}
		const outChunks = [];
		const errChunks = [];
		let total = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
		}, timeoutMs);
		const finish = (status, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				status,
				error: error ? String(error?.message ?? error) : null,
				stdout: Buffer.concat(outChunks).toString("utf8"),
				stderr: Buffer.concat(errChunks).toString("utf8"),
				truncated,
				timedOut,
			});
		};
		child.stdout?.on("data", (chunk) => { if (total > maxBuffer) { truncated = true; return; } outChunks.push(chunk); total += chunk.length; });
		child.stderr?.on("data", (chunk) => { if (total > maxBuffer) { truncated = true; return; } errChunks.push(chunk); total += chunk.length; });
		child.on("error", (error) => finish(null, error));
		child.on("close", (status) => finish(status));
	});
}

/** 端口占用查找（netstat）。返回监听该端口的进程 PID，无则 null。 */
async function findPidByPort(port) {
	const r = await runAsync("netstat", ["-ano", "-p", "tcp"], { timeoutMs: 15000 });
	if (r.error || r.status !== 0) return null;
	const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "m");
	const m = r.stdout.match(re);
	return m ? Number(m[1]) : null;
}

/** PID 存活探测（signal 0）。 */
function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/** 读取插件维护的运行状态文件（可能不存在）。 */
function readState(config) {
	try {
		return JSON.parse(readFileSync(config.stateFile, "utf8"));
	} catch {
		return null;
	}
}

function writeState(config, state) {
	try {
		writeFileSync(config.stateFile, JSON.stringify(state, null, 2), "utf8");
	} catch {
		/* 状态文件写失败不阻断主流程 */
	}
}

/* ------------------------------------------------------------------ */
/* 启停实现（control 与 upgrade 共用）                                   */
/* ------------------------------------------------------------------ */

async function isEngineUp(config, signal) {
	try {
		return await callEngine(config.baseUrl, "/system_stats", { timeoutMs: 5000, signal });
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

/** 引擎是否已安装到位（便携版 = python_embeded/python.exe + ComfyUI/main.py 都在）。 */
function engineInstalled(config) {
	return existsSync(path.join(config.engineRoot, "python_embeded", "python.exe")) && existsSync(path.join(config.engineRoot, "ComfyUI", "main.py"));
}

/** 引擎未安装时的可执行指引（不把它报成「进程启动失败」，那会让人以为引擎崩了）。 */
function engineMissingMessage(config) {
	const detected = detectComfyUiInstalls().filter((item) => item.kind === "portable" && path.resolve(item.path) !== path.resolve(config.engineRoot));
	return (
		`ComfyUI engine is not installed at ${config.engineRoot} (expected python_embeded\\python.exe and ComfyUI\\main.py). ` +
		`This is a missing install, not a crash. Install it from the settings page or with image_setup (action=install, component=engine, ~1.9 GB). ` +
		(detected.length > 0
			? `An existing ComfyUI was found at ${detected.map((item) => item.path).join(", ")} — reuse it by setting the engineRoot config (or IMAGEKIT_ENGINE_DIR) to that folder. `
			: "") +
		`If you already run ComfyUI yourself, set baseUrl to it instead of starting a plugin-managed copy.`
	);
}

/** 引擎日志尾：优先插件自己的落盘，其次 ComfyUI 自己的 user/comfyui.log。 */
function engineLogTail(config, lines) {
	for (const file of engineLogCandidates(config.engineRoot)) {
		const text = tailFile(file, lines);
		if (text) return text;
	}
	return "";
}

/** 启动引擎（detached、日志落盘、写状态文件）。返回 {pid, profile, startedAt}。 */
async function startEngine(config, profile, signal) {
	if (process.platform !== "win32") {
		throw new Error("the ComfyUI engine is a Windows portable build (python_embeded/python.exe); this plugin targets Windows x64 only.");
	}
	// 先查安装：缺失时 spawn 只会 ENOENT，旧文案「process exited during startup」把安装缺失
	// 说成启动崩溃，用户会去查日志、重试启动，而不是去装引擎。
	if (!engineInstalled(config)) throw new Error(engineMissingMessage(config));
	const running = await isEngineUp(config, signal);
	if (running) {
		const state = readState(config);
		return { alreadyRunning: true, pid: await findPidByPort(portOf(config.baseUrl)), profile: state?.profile ?? "external", version: running.system?.comfyui_version };
	}
	const port = portOf(config.baseUrl);
	const pyExe = path.join(config.engineRoot, "python_embeded", "python.exe");
	const args = [
		"-u", "-s", "ComfyUI/main.py", "--windows-standalone-build",
		// --windows-standalone-build 会把 auto_launch 置 True（ComfyUI 源码 comfy/cli_args.py），
		// 于是 main.py 在服务起来后 webbrowser.open(...) —— 后台拉起却弹出浏览器页面。
		// 实测 2026-10-02：插件启动引擎后 Edge 多出 ComfyUI 标签。必须显式关掉。
		"--disable-auto-launch",
		"--listen", "127.0.0.1", "--port", String(port)
	];
	if (profile === "lowvram") args.push("--lowvram");
	// 取消已到就别再拉新进程——spawn 出去就成了没人接手的孤儿引擎
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	mkdirSync(config.logsDir, { recursive: true });
	const outFd = openSync(path.join(config.logsDir, "engine.log"), "a");
	const errFd = openSync(path.join(config.logsDir, "engine.err.log"), "a");
	const child = spawn(pyExe, args, {
		cwd: config.engineRoot,
		detached: true,
		stdio: ["ignore", outFd, errFd],
		// windowsHide：后台静默拉起，不弹控制台窗口（与 start_comfyui.bat 的可见控制台相反）。
		// 参数里一律不带 --auto-launch：那会让 ComfyUI 自己打开浏览器页面。
		windowsHide: true,
		// 仅当用户在配置里选择 hf-mirror 时注入镜像变量；默认不覆盖官方源。
		env: { ...process.env, ...hfEndpointEnv(config) },
	});
	// stdio 传 fd 时子进程拿到的是复制句柄——父进程（常驻宿主）自己的
	// 副本必须随手关掉，否则每次 start/restart 泄漏 2 个 fd，还长期占住 engine.log /
	// engine.err.log 的打开句柄（日志无法删除/轮转）。spawn 失败（如 python.exe 不存在，
	// ENOENT）若无监听会以 uncaughtException 打崩宿主——对齐 image-gen gateway.js 的
	// 既有姿势：挂 'error' 监听并把失败原因落日志，静默拉起仍然可诊断
	child.on("error", (e) => {
		try { appendFileSync(path.join(config.logsDir, "engine.err.log"), `[spawn] ${String(e?.message ?? e)}\n`, "utf8"); } catch { /* 日志写失败无声 */ }
	});
	child.unref();
	closeSync(outFd);
	closeSync(errFd);
	const startedAt = new Date().toISOString();
	writeState(config, { pid: child.pid, profile, startedAt, baseUrl: config.baseUrl });
	// 轮询直到 HTTP 就绪
	const deadline = Date.now() + config.startTimeoutSeconds * 1000;
	while (Date.now() < deadline) {
		// 轮询等待与探测都接 exec.signal——取消后不再跑满 startTimeoutSeconds
		await sleepAbortable(2000, signal);
		const stats = await isEngineUp(config, signal);
		if (stats) {
			return { pid: child.pid, profile, startedAt, version: stats.system?.comfyui_version };
		}
		if (!pidAlive(child.pid)) {
			const tail = engineLogTail(config, 12);
			throw new Error(
				`ComfyUI process exited during startup (the engine is installed at ${config.engineRoot}; this is a runtime failure, check the log). ` +
					(tail ? `Log tail:\n${tail}` : `No log at ${config.logsDir} — run the engine once with comfy (action=control, op=start) or check ${config.engineRoot}.`)
			);
		}
	}
	throw new Error(`ComfyUI did not become ready within ${config.startTimeoutSeconds}s (pid ${child.pid}). Check logs in ${config.logsDir}.`);
}

/** 停止引擎：先 interrupt 当前任务，再按 PID 树杀。返回被停的 PID 列表。 */
async function stopEngine(config, signal) {
	const port = portOf(config.baseUrl);
	const pids = new Set();
	const state = readState(config);
	if (state?.pid && pidAlive(state.pid)) pids.add(state.pid);
	const netPid = await findPidByPort(port);
	if (netPid) pids.add(netPid);
	if (pids.size === 0) {
		const stillUp = await isEngineUp(config, signal);
		if (!stillUp) return { stopped: [], wasRunning: false };
		// 引擎仍响应 HTTP 却解析不到 PID（netstat 未命中/超时/权限）时，继续走
		// 只会假成功（wasRunning:false → ok:true、state.pid 被清空、重启走 alreadyRunning）——响亮失败
		throw new Error(
			`Engine at ${config.baseUrl} is still up but no PID could be resolved (state pid: ${state?.pid ?? "none"}; netstat no match). ` +
				`Refusing to fake a successful stop — check netstat output/permissions or kill the process manually, then retry.`
		);
	}
	try {
		await callEngine(config.baseUrl, "/interrupt", { method: "POST", body: {}, timeoutMs: 4000, signal });
	} catch {}
	// 停止路径同样接 exec.signal——sleep 可打断、等待循环不再无视取消；
	// taskkill 走异步 runAsync（P1 阻塞类评估：树杀可到秒级，不再冻结宿主事件循环）
	await sleepAbortable(1200, signal);
	for (const pid of pids) {
		if (!pidAlive(pid)) continue;
		await runAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 20000 });
	}
	// 等端口释放（最多 15s）
	for (let i = 0; i < 8 && (await findPidByPort(port)); i++) await sleepAbortable(2000, signal);
	const portFree = (await findPidByPort(port)) === null;
	writeState(config, { ...state, pid: null, stoppedAt: new Date().toISOString() });
	return { stopped: [...pids], wasRunning: pids.size > 0, portFree };
}

function portOf(baseUrl) {
	const m = String(baseUrl).match(/:(\d+)\/?$/);
	return m ? Number(m[1]) : 8188;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可被 exec.signal 打断的等待——启停轮询期间取消要立刻生效，不多等一个间隔。 */
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

/** 读文件尾部 N 行（文件可能不存在/被占用）。 */
function tailFile(file, lines) {
	try {
		const content = readFileSync(file, "utf8");
		return content.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 模型源注册表解析（extra_model_paths.yaml，轻量行级解析）              */
/* ------------------------------------------------------------------ */

function parseModelRegistry(yamlPath) {
	if (!existsSync(yamlPath)) return null;
	try {
		const lines = readFileSync(yamlPath, "utf8").split(/\r?\n/);
		const sections = [];
		let current = null;
		for (const rawLine of lines) {
			const line = rawLine.replace(/#.*$/, "").replace(/\s+$/, "");
			if (line === "") continue;
			const sec = line.match(/^([A-Za-z0-9_-]+):\s*$/);
			if (sec) {
				current = { name: sec[1], basePath: null, folders: [] };
				sections.push(current);
				continue;
			}
			if (!current) continue;
			const base = line.match(/^\s+base_path:\s*(.+)$/);
			if (base) {
				current.basePath = base[1].trim().replace(/^["']|["']$/g, "");
				continue;
			}
			const folder = line.match(/^\s+([a-z_]+):\s*(.+)$/);
			if (folder && folder[1] !== "is_default") {
				current.folders.push({ folder: folder[1], rel: folder[2].trim() });
			}
		}
		// 解析成绝对路径并统计文件
		for (const s of sections) {
			for (const f of s.folders) {
				const abs = s.basePath ? path.join(s.basePath, f.rel) : path.resolve(path.dirname(yamlPath), f.rel);
				f.path = path.normalize(abs);
				try {
					const files = readdirSync(f.path, { withFileTypes: true }).filter((e) => e.isFile());
					f.files = files.length;
					f.sizeGB = files.reduce((sum, e) => {
						try {
							return sum + statSync(path.join(f.path, e.name)).size;
						} catch {
							return sum;
						}
					}, 0) / 1073741824;
					f.sample = files.slice(0, 6).map((e) => e.name);
				} catch {
					f.files = 0;
					f.sizeGB = 0;
					f.sample = [];
				}
			}
		}
		return sections;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 版本与升级                                                           */
/* ------------------------------------------------------------------ */

function localVersionFile(config) {
	const file = path.join(config.comfyDir, "comfyui_version.py");
	try {
		const m = readFileSync(file, "utf8").match(/__version__\s*=\s*"([^"]+)"/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

async function gitInfo(config) {
	// P1 阻塞类评估：git describe 在大仓库可到秒级——同 netstat/taskkill 一并异步化
	const describe = await runAsync("git", ["describe", "--tags", "--always"], { cwd: config.comfyDir, timeoutMs: 15000 });
	const commit = await runAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: config.comfyDir, timeoutMs: 15000 });
	if (describe.error || describe.status !== 0 || commit.error || commit.status !== 0) return { describe: null, commit: null };
	return { describe: describe.stdout.trim(), commit: commit.stdout.trim() };
}

async function latestGitHubRelease(signal) {
	const urls = [
		"https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest",
		"https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest",
	];
	let lastErr = null;
	for (const url of urls) {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": "dsh-plugin-comfyui", Accept: "application/vnd.github+json" },
				signal: withDeadline(20000, signal),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			return { tag: json.tag_name, publishedAt: json.published_at, url: json.html_url };
		} catch (err) {
			// 调用方取消不是「GitHub 不可达」——先按信号上抛，别把 AbortError
			// 吞成换 URL 重试、最后还误导成网络错误
			rethrowIfAborted(err, signal);
			lastErr = err;
		}
	}
	throw new Error(`GitHub API unreachable: ${String(lastErr?.message ?? lastErr)}`);
}

function normalizeVersion(v) {
	return String(v ?? "").trim().replace(/^[vV]/, "");
}

/** 执行官方更新脚本（git 更新引擎代码，不动 python 环境）。 */
async function runUpdater(config) {
	const bat = path.join(config.engineRoot, "update", "update_comfyui.bat");
	if (!existsSync(bat)) throw new Error(`updater script not found: ${bat}`);
	mkdirSync(config.logsDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
	const logFile = path.join(config.logsDir, `upgrade-${stamp}.log`);
	// 传一个非空位置参数跳过 bat 结尾的 pause
	// 补完（P1 阻塞类评估）：spawnSync 同步执行会把常驻宿主的事件循环冻结
	// 最长 10 分钟（所有工具调用/HTTP 处理停摆）——改走异步 runAsync；r.error（spawn 本身
	// 失败）与超时照旧写进结果与日志，不让排查方向被带偏
	const r = await runAsync("cmd.exe", ["/c", bat, "nopause"], { cwd: path.dirname(bat), timeoutMs: 600000, maxBuffer: 20 * 1024 * 1024 });
	const spawnError = r.error;
	const output = [r.timedOut ? "(updater timed out after 600s and was killed)" : null, spawnError, r.stdout, r.stderr].filter(Boolean).join("\n").trim();
	try {
		writeFileSync(logFile, output || "(no output)", "utf8");
	} catch {}
	return { ok: r.status === 0 && !r.error, status: r.status, error: spawnError, output, logFile };
}

/* ------------------------------------------------------------------ */
/* 系统提示                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 工具注册                                                            */
/* ------------------------------------------------------------------ */

function fmtGB(bytes) {
	return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function fmtUptime(startedAtIso) {
	const ms = Date.now() - Date.parse(startedAtIso);
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const min = Math.floor(ms / 60000);
	if (min < 60) return `${min}m`;
	return `${Math.floor(min / 60)}h${min % 60}m`;
}

function apply(ctx, rawConfig) {
	// 后置归一化（schema 只负责校验与填默认值，不做路径派生）：
	// baseUrl 去掉尾部斜杠；registryYaml 缺省时按引擎目录推导；再派生 comfyDir。
	const config = {
		...rawConfig,
		baseUrl: rawConfig.baseUrl.replace(/\/+$/, ""),
		registryYaml: rawConfig.registryYaml || path.join(rawConfig.engineRoot, "ComfyUI", "extra_model_paths.yaml"),
	};
	config.comfyDir = path.join(config.engineRoot, "ComfyUI");
	// baseUrl 不带显式端口时 portOf 只能瞎猜回 8188——startEngine 会把 --port
	// 设成 baseUrl 的端口、findPidByPort 又按它查 PID，两处都会走错。配置错误要响亮，不静默猜。
	if (!/:\d+$/.test(config.baseUrl)) {
		throw new Error(`comfyui baseUrl must include an explicit port (got ${JSON.stringify(rawConfig.baseUrl)}), e.g. http://127.0.0.1:8188`);
	}
	// 模型可见文本（系统提示 + 工具描述）不硬编码引擎位置/端口——engineRoot/
	// baseUrl 是可配置项，用户改了 config 后描述要跟着走，否则一直在陈述错误事实（模型会据此
	// 拼 URL）。默认配置下生成的文本与旧硬编码逐字节一致（契约基线零漂移）。
	const engineDisplay = path.dirname(config.engineRoot);
	const port = portOf(config.baseUrl);
	const systemSectionText = "Shared ComfyUI engine (image + 3D): manage via comfy (action=control), never by hand; models read-only.";

	ctx.systemPrompt.section({
		name: "tool:comfyui",
		order: 2065,
		text: ({ scope }) => (ctx.tools.get("comfy", scope) === undefined ? "" : systemSectionText),
	});

	/* --------------------- runStatus --------------------- */
	async function runStatus(exec) {
		const port = portOf(config.baseUrl);
		const state = readState(config);
		const result = { running: false, baseUrl: config.baseUrl, engineRoot: config.engineRoot };
		const stats = await isEngineUp(config, exec?.signal);
		if (stats) {
			result.running = true;
			result.version = stats.system?.comfyui_version ?? null;
			result.python = stats.system?.python_version ?? null;
			result.devices = (stats.devices ?? []).map((d) => ({
				name: d.name,
				vram_total: d.vram_total,
				vram_free: d.vram_free,
				vram_used: d.vram_total - d.vram_free,
			}));
			result.pid = await findPidByPort(port);
			result.managed = Boolean(state?.pid && pidAlive(state.pid));
			result.profile = state?.profile ?? (result.pid ? "external" : null);
			result.uptime = state?.startedAt ? fmtUptime(state.startedAt) : null;
			try {
				const q = await callEngine(config.baseUrl, "/queue", { timeoutMs: 8000, signal: exec?.signal });
				result.queue = {
					running: (q.queue_running ?? []).map((e) => e[1]),
					pending: (q.queue_pending ?? []).map((e) => e[1]),
				};
			} catch (error) {
				rethrowIfAborted(error, exec?.signal);
				result.queue = null;
			}
			try {
				const h = await callEngine(config.baseUrl, "/history?max_items=10", { timeoutMs: 8000, signal: exec?.signal });
				result.recentTasks = Object.entries(h ?? {})
					.slice(0, 10)
					.map(([promptId, entry]) => ({
						prompt_id: promptId,
						status: entry?.status?.status_str ?? null,
						completed: Boolean(entry?.status?.completed),
					}));
			} catch (error) {
				rethrowIfAborted(error, exec?.signal);
				result.recentTasks = null;
			}
		} else {
			const netPid = await findPidByPort(port);
			// 「没装」和「装了没起」是两种完全不同的行动：前者去下载，后者去启动。
			const installed = engineInstalled(config);
			result.installed = installed;
			if (netPid !== null) {
				result.note = `Port ${port} is occupied by pid ${netPid} but HTTP is not responding (possibly still booting or a hung instance).`;
			} else if (!installed) {
				result.note = engineMissingMessage(config);
			} else {
				result.note = `Engine is not running. Start it with comfy (action=control, op=start) or ${path.join(path.dirname(config.engineRoot), "start_comfyui.bat")}.`;
			}
			result.pid = netPid;
		}
		result.modelSources = parseModelRegistry(config.registryYaml);
		const logTail = engineLogTail(config, 12);
		if (logTail) result.logTail = logTail;
		else if (!result.running) {
			result.logTailNote = `No engine log at ${config.logsDir} yet: logs are only written when this plugin starts the engine. An engine you started yourself keeps its output in its own console.`;
		}
		return result;
	}

	/* --------------------- runControl --------------------- */
	async function runControl(args, exec) {
		const action = args.action;
		if (action === "start" || action === "restart") {
			if (action === "restart") {
				const prev = readState(config);
				await stopEngine(config, exec?.signal); // 启停全程接 exec.signal
				const profile = args.profile ?? prev?.profile ?? "normal";
				const started = await startEngine(config, profile, exec?.signal);
				return { action, ok: true, profile, ...started };
			}
			const started = await startEngine(config, args.profile ?? "normal", exec?.signal);
			return { action, ok: true, ...started };
		}
		if (action === "stop") {
			const stopped = await stopEngine(config, exec?.signal);
			return { action, ok: stopped.wasRunning ? stopped.portFree !== false : true, ...stopped };
		}
		if (action === "free") {
			const before = await callEngine(config.baseUrl, "/system_stats", { timeoutMs: 8000, signal: exec?.signal });
			await callEngine(config.baseUrl, "/free", { method: "POST", body: { unload_models: true, free_memory: true }, timeoutMs: 30000, signal: exec?.signal });
			await sleep(3000);
			const after = await callEngine(config.baseUrl, "/system_stats", { timeoutMs: 8000, signal: exec?.signal });
			const d0 = before?.devices?.[0];
			const d1 = after?.devices?.[0];
			return {
				action,
				ok: true,
				freeBefore: d0 ? fmtGB(d0.vram_free) : null,
				freeAfter: d1 ? fmtGB(d1.vram_free) : null,
			};
		}
		if (action === "interrupt") {
			await callEngine(config.baseUrl, "/interrupt", { method: "POST", body: {}, timeoutMs: 10000, signal: exec?.signal });
			return { action, ok: true, note: "interrupt signal sent; the executing task stops, queue keeps running" };
		}
		throw new Error(`unknown action: ${action}`);
	}

	/* --------------------- runUpgrade --------------------- */
	async function runUpgrade(args, exec) {
		const mode = args.mode;
		const stats = await isEngineUp(config, exec?.signal);
		const current = stats?.system?.comfyui_version ?? localVersionFile(config);
		const git = await gitInfo(config);
		if (mode === "check") {
			const latest = await latestGitHubRelease(exec?.signal);
			const upToDate = normalizeVersion(current) === normalizeVersion(latest.tag);
			return {
				mode,
				current: current ?? "unknown",
				latest: latest.tag,
				upToDate,
				git: git,
				latestPublishedAt: latest.publishedAt,
				latestUrl: latest.url,
				note: upToDate
					? "Engine matches the latest GitHub release."
					: "Newer release available. Run comfy (action=upgrade, mode=upgrade, confirm=true) to apply (stops/restarts the engine).",
			};
		}
		if (mode === "upgrade") {
			if (args.confirm !== true) {
				throw new Error("mode=upgrade requires confirm=true (this stops the engine and updates engine code).");
			}
			const prevProfile = readState(config)?.profile ?? "normal";
			const stopped = await stopEngine(config, exec?.signal); // 取消要能打断升级中的停/起
			const updated = await runUpdater(config);
			const versionAfter = localVersionFile(config);
			let restarted = null;
			if (updated.ok) {
				restarted = await startEngine(config, prevProfile, exec?.signal);
			}
			// upToDate 必须对真正的最新 release 计算——旧写法拿「升级前后本地
			// 版本是否相等」冒充（版本前进反而 false、空转反而 true），latest 也不能拿本地版本冒充
			let latestTag = null;
			try {
				latestTag = (await latestGitHubRelease(exec?.signal))?.tag ?? null;
			} catch (error) {
				rethrowIfAborted(error, exec?.signal); // 取消照常上抛；仅 GitHub 不可达时降级
			}
			return {
				mode,
				current: current ?? "unknown",
				latest: latestTag ?? versionAfter ?? "unknown",
				upToDate: latestTag !== null ? normalizeVersion(versionAfter) === normalizeVersion(latestTag) : false,
				wasRunning: stopped.wasRunning,
				updater: { ok: updated.ok, exitCode: updated.status, log: updated.logFile },
				updaterOutputTail: updated.output.split(/\r?\n/).filter(Boolean).slice(-8).join("\n"),
				restarted,
				note: updated.ok
					? "Upgrade finished; engine code updated and engine restarted. Model folders untouched."
						+ (latestTag === null ? " (latest-release check failed; upToDate could not be verified and is reported as false.)" : "")
					: `Updater exited with code ${updated.status}${updated.error ? ` (spawn error: ${updated.error})` : ""}; engine left stopped. Full log: ${updated.logFile}`,
			};
		}
		throw new Error(`unknown mode: ${mode}`);
	}

	/* ---------------------------- comfy 网关 ---------------------------- */
	// 三个原工具收成一个网关（token 优化第三轮）：execute 按 action 分派到上面抽出的实现函数，
	// render 仍走各自的模型可见文本——不把结果塞进 JSON 让模型看不见。
	const RENDERS = {
		status: (_args, value) => [{ type: "text", text: renderStatus(value) }],
		control: (_args, value) => [{ type: "text", text: JSON.stringify(value).slice(0, 1500) }],
		upgrade: (_args, value) => [{ type: "text", text: JSON.stringify(value).slice(0, 1500) }],
	};
	ctx.tools.register(defineTool({
		name: "comfy",
		description: `Shared ComfyUI engine at ${engineDisplay} (port ${port}): inspect, control, or upgrade.`,
		parameters: {
			action: { type: "string", enum: ["status", "control", "upgrade"], description: "status | control | upgrade.", required: true },
			op: { type: "string", enum: ["start", "stop", "restart", "free", "interrupt"], description: "action=control: start/stop/restart/free/interrupt." },
			profile: { type: "string", enum: ["normal", "lowvram"], description: "op=start/restart; lowvram = slower, safer on 12GB." },
			mode: { type: "string", enum: ["check", "upgrade"], description: "action=upgrade: check = report only | upgrade = perform." },
			confirm: { type: "boolean", description: "Required true for mode=upgrade (double confirmation)." },
		},
		output: {
			// 单一输出 schema 覆盖三种返回结构；各 action 的字段差异由 render 保持原样。
			schema: { type: "object", additionalProperties: true },
			render: (args, value) => RENDERS[String(args.action)](args, value),
		},
		// 原三工具超时不同：取最大（upgrade 15 分钟）；status/control 只是上限放宽，能力不丢。
		timeoutMs: 15 * 60 * 1000,
		isConcurrencySafe: (args) => args?.action === "status",
		async execute(args, exec) {
			const action = args.action;
			if (action === "status") return runStatus(exec);
			if (action === "control") {
				// 原 comfy_control 的 action 参数与网关 action 同名：落到 op 上复用同一实现。
				if (typeof args.op !== "string") throw new Error("action=control requires op: start | stop | restart | free | interrupt");
				return runControl({ ...args, action: args.op }, exec);
			}
			if (action === "upgrade") return runUpgrade(args, exec);
			throw new Error(`unknown action: ${action}`);
		},
	}));
}

function renderStatus(v) {
	if (!v.running) {
		const head = v.installed === false ? "NOT INSTALLED" : "DOWN";
		return `ComfyUI engine ${head} at ${v.baseUrl}. ${v.note ?? ""}` + (v.logTail ? `\n  Log tail:\n    ${v.logTail.split("\n").join("\n    ")}` : "");
	}
	const lines = [];
	lines.push(`ComfyUI ${v.version ?? "?"} at ${v.baseUrl}: RUNNING (pid ${v.pid ?? "?"}, profile ${v.profile ?? "?"}${v.uptime ? `, up ${v.uptime}` : ""}${v.managed ? ", plugin-managed" : ", external"}` + ")");
	for (const d of v.devices ?? []) {
		lines.push(`  GPU ${d.name}: VRAM used ${fmtGB(d.vram_used)} / total ${fmtGB(d.vram_total)} (free ${fmtGB(d.vram_free)})`);
	}
	if (v.queue) {
		lines.push(`  Queue: running=${v.queue.running.length}${v.queue.running.length ? ` (${v.queue.running.join(", ").slice(0, 40)}…)` : ""}, pending=${v.queue.pending.length}`);
	}
	if (v.recentTasks?.length) {
		const last = v.recentTasks.slice(0, 3).map((t) => `${t.status ?? "?"}${t.completed ? "" : "*"}`);
		lines.push(`  Recent tasks (newest first): ${last.join(" | ")} (* = not completed)`);
	}
	for (const s of v.modelSources ?? []) {
		const folders = s.folders
			.map((f) => `${f.folder}=${f.files} file${f.files === 1 ? "" : "s"}${f.files ? ` (${f.sizeGB.toFixed(1)}GB)` : ""}`)
			.join(", ");
		lines.push(`  Model source "${s.name}"${s.basePath ? ` @ ${s.basePath}` : ""}: ${folders || "(no folders)"}`);
		for (const f of s.folders) {
			if (f.sample?.length) lines.push(`    ${f.folder}: ${f.sample.join(", ")}${f.files > f.sample.length ? `, +${f.files - f.sample.length} more` : ""}`);
		}
	}
	if (v.logTail) lines.push(`  Log tail:\n    ${v.logTail.split("\n").join("\n    ")}`);
	else if (v.logTailNote) lines.push(`  ${v.logTailNote}`);
	return lines.join("\n");
}

export { Config, apply, inject, name };
// 供离线自测引用（不注册工具、不进模型上下文）：判断引擎是否装到位、拼「未安装」文案。
export { engineInstalled, engineMissingMessage };