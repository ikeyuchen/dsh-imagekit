/**
 * dsh-imagekit — 资源管理（引擎 / 模型 / 放大引擎的下载、校验、删除、升级）
 * ==================================================================
 * 设计原则：
 *  - 只操作「清单登记路径」：所有写入都必须在 installRoot 派生的目录内，越界即拒；
 *  - 下载支持断点续传（HTTP Range）+ 大小/哈希校验，先落 .partial 再原子改名；
 *  - 长下载写进度文件，status 可轮询；不阻塞宿主事件循环（异步流）；
 *  - 删除必须带确认令牌，且先检查没有正在运行的下载任务；
 *  - 默认不自动下载：只有显式调用 install 才联网。
 *
 * 本模块不自己管 ComfyUI 进程：升级引擎时通过宿主的 comfy 工具停/起引擎，
 * 并跨版本保留引擎目录里的用户数据（extra_model_paths.yaml / custom_nodes / user /
 * input / output / models）；只搬移，不改写这些文件的内容。
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	lstatSync,
	renameSync as renamePath,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { defaultAssetPaths as defaultPaths, resolveGatewayDir } from "./paths.js";

const MANIFEST_FILE = "models.manifest.json";
/** 最近一次成功使用的解压器（status 里展示，便于用户确认没有 7-Zip 也能装）。 */
let lastExtractor = null;
const STATE_DIR = ".imagekit";
const STATE_FILE = "state.json";
const JOB_FILE = "job.json";
const BACKUPS_DIR = "backups";

/** 组件键 → 清单里的说明角色。 */
const COMPONENTS = ["engine", "models", "upscale"];

function readJson(file, fallback) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** 递归统计目录大小（不跟随符号链接）。 */
function dirSize(dir) {
	let bytes = 0;
	let files = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = path.join(d, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile()) {
				try {
					bytes += statSync(abs).size;
					files += 1;
				} catch {
					/* 文件在遍历中消失：忽略 */
				}
			}
		}
	};
	walk(dir);
	return { bytes, files };
}

function human(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let n = bytes;
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i += 1;
	}
	return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** 去掉版本号里的路径非法字符，保证备份目录名可读且安全。 */
function safeSegment(value) {
	return (
		String(value ?? "")
			.replace(/[^A-Za-z0-9._-]+/g, "_")
			.replace(/^[._-]+|[._-]+$/g, "") || "unknown"
	);
}

/** 备份目录名里的时间戳（可排序）。 */
function backupStamp() {
	return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** 组件当前安装根。 */
function componentRoot(layout, component) {
	if (component === "engine") return layout.engineRoot;
	if (component === "models") return layout.modelsRoot;
	return layout.upscaleRoot;
}

/** 引擎升级要跨版本保留的用户数据（相对 engineRoot）。
 *  固定版本升级是「整目录替换」：不搬走这些，模型注册表、自定义节点、工作流库
 *  会随旧便携版一起进备份，新解压出来的是出厂空目录 —— 出图会静默报模型找不到。
 *  都用同盘 rename，不复制大文件。 */
const ENGINE_USER_DATA = [
	"ComfyUI/extra_model_paths.yaml", // 模型注册表（绝对路径，最容易被冲掉）
	"ComfyUI/custom_nodes", // 自定义节点（pose / vnccs 等工作流依赖）
	"ComfyUI/user", // 工作流库 / 设置 / comfyui.db
	"ComfyUI/input", // 用户上传的参考图
	"ComfyUI/output", // 引擎自己的输出目录
	"ComfyUI/models" // 用户可能直接放在便携版里的模型
];

/** 临时保管区：放在 installRoot 下（与引擎同盘，rename 才有效）。 */
function engineStagingRoot(layout) {
	return assertWithin(
		layout.installRoot,
		path.join(layout.installRoot, ".staging", `engine-upgrade-${process.pid}-${Date.now()}`)
	);
}

/** 升级前把用户数据挪进临时区；返回可回滚的清单。 */
function stageEngineUserData(layout) {
	const staging = engineStagingRoot(layout);
	const saved = [];
	for (const rel of ENGINE_USER_DATA) {
		const from = path.join(layout.engineRoot, rel);
		if (!existsSync(from)) continue;
		const to = path.join(staging, rel);
		mkdirSync(path.dirname(to), { recursive: true });
		renameSync(from, to);
		saved.push({ rel, from, to, staging, restored: false });
	}
	return saved;
}

/** 解压完（或回滚后）把用户数据放回原位；新解压出来的同名路径只是模板/空目录，直接替换。 */
function restoreEngineUserData(saved) {
	for (const item of saved) {
		if (item.restored) continue;
		if (!existsSync(item.to)) {
			item.restored = true;
			continue;
		}
		rmSync(item.from, { recursive: true, force: true });
		mkdirSync(path.dirname(item.from), { recursive: true });
		renameSync(item.to, item.from);
		item.restored = true;
	}
}

/**
 * 回滚前把「已经放回新引擎目录」的用户数据再挪回临时区。
 * 否则 restoreBackup 会先删掉新目录（连同刚放回的自定义节点 / 模型注册表）。
 */
function stashEngineUserDataForRollback(saved) {
	for (const item of saved) {
		if (!item.restored) continue;
		if (!existsSync(item.from)) {
			item.restored = false;
			continue;
		}
		rmSync(item.to, { recursive: true, force: true });
		mkdirSync(path.dirname(item.to), { recursive: true });
		renameSync(item.from, item.to);
		item.restored = false;
	}
}


function cleanupEngineStaging(saved) {	for (const dir of new Set(saved.map((item) => item.staging))) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 清理失败不影响升级结果，clean 动作也会再扫一遍 */
		}
		// 父级 .staging 只有空了才删：并发升级时别把别人的保管区一起清掉
		const parent = path.dirname(dir);
		try {
			if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
		} catch {
			/* 已不存在或还有别的会话在用 */
		}
	}
}

/** 引擎运行状态文件（引擎插件的 stateFile 默认在便携版目录的同级）。 */
function engineRuntimeStateFile(layout) {
	return path.join(path.dirname(layout.engineRoot), "engine-state.json");
}

/** 引擎 HTTP 探活：/system_stats 有响应即视为运行中（不依赖 pid 文件，手工启动的引擎也能识别）。 */
async function engineHttpUp(baseUrl, timeoutMs = 3000) {
	const base = String(baseUrl ?? "").replace(/\/+$/, "");
	if (base === "") return false;
	try {
		const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/** 取宿主里已注册的 comfy 引擎工具（停止/启动引擎复用它的完整逻辑，不在这里复制一份）。 */
function comfyToolOf(ctx) {
	try {
		const tool = ctx?.tools?.get?.("comfy");
		return tool !== undefined && tool !== null && typeof tool.execute === "function" ? tool : null;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 网关进程：它用引擎目录里的 python_embeded\python.exe 跑 app.py         */
/* ------------------------------------------------------------------ */

/** 从 URL 里取端口；取不到返回 null。 */
function portOfUrl(url) {
	const m = String(url ?? "").match(/:(\d+)\/?$/);
	return m ? Number(m[1]) : null;
}

/** 异步跑一个命令（不冻结宿主事件循环）；超时杀进程。 */
function runCommand(file, args, { cwd, timeoutMs = 60000 } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ status: null, error: String(error?.message ?? error), stdout: "", stderr: "" });
			return;
		}
		const out = [];
		const err = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* 已退出 */
			}
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ status: null, error: String(error?.message ?? error), stdout: "", stderr: "" });
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({
				status,
				error: timedOut ? `timed out after ${timeoutMs}ms` : null,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8")
			});
		});
	});
}

/** 监听某端口的进程 PID（netstat），没有返回 null。 */
async function findListeningPid(port) {
	const r = await runCommand("netstat", ["-ano", "-p", "tcp"], { timeoutMs: 15000 });
	if (r.error !== null || r.status !== 0) return null;
	const m = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "m").exec(r.stdout);
	return m ? Number(m[1]) : null;
}

/** 进程的可执行文件路径（拿不到就 null）。 */
async function processPathOf(pid) {
	const r = await runCommand(
		"powershell",
		["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path`],
		{ timeoutMs: 15000 }
	);
	const value = String(r.stdout ?? "").trim();
	return value === "" ? null : value;
}

async function killTree(pid) {
	await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 20000 });
}

/** 网关目录（与网关服务本身同源，来自 lib/paths.js 的解析规则）。 */
function gatewayDirOf() {
	try {
		const dir = resolveGatewayDir();
		return typeof dir === "string" && dir !== "" ? dir : null;
	} catch {
		return null;
	}
}

/**
 * 升级前停掉「用引擎 python 在跑」的网关：
 *  - 它的 exe 就在 <engineRoot>/python_embeded 里，进程活着时整目录 rename 会 EPERM；
 *  - 换完 python_embeded 后它的依赖（fastapi/uvicorn/...）也没了，必须先停再补装。
 * 只在端口上的进程确实来自本引擎目录时才动手，避免误杀别人的服务。
 */
async function stopGatewayForUpgrade(layout, config, lines) {
	const port = portOfUrl(text(config?.gatewayUrl)) ?? 8189;
	const pid = await findListeningPid(port);
	if (pid === null) return false;
	const exe = await processPathOf(pid);
	const enginePrefix = `${path.resolve(layout.engineRoot).toLowerCase()}${path.sep}`;
	const inside = typeof exe === "string" && path.resolve(exe).toLowerCase().startsWith(enginePrefix);
	if (!inside) {
		lines.push(`gateway on port ${port} (pid ${pid}) is not using this engine's python (${exe ?? "path unknown"}) — left running`);
		return false;
	}
	await killTree(pid);
	for (let i = 0; i < 6 && (await findListeningPid(port)) !== null; i += 1) await sleepFor(500);
	lines.push(`stopped image gateway (pid ${pid}, port ${port}) — it shares this engine's python_embeded`);
	return true;
}

/**
 * 换完 python_embeded 之后补装网关依赖：新解压的 python 里没有 fastapi/uvicorn，
 * 不补装网关下次生图就起不来。失败按「升级失败」处理（回滚），不让系统停在半可用状态。
 */
async function reinstallGatewayDeps(layout, lines) {
	const gatewayDir = gatewayDirOf();
	if (gatewayDir === null) return;
	const requirements = path.join(gatewayDir, "requirements.txt");
	if (!existsSync(requirements)) {
		lines.push(`WARN gateway requirements.txt not found at ${requirements}; install fastapi/uvicorn/httpx manually if the gateway fails to start`);
		return;
	}
	const python = path.join(layout.engineRoot, "python_embeded", "python.exe");
	if (!existsSync(python)) {
		lines.push(`WARN engine python not found at ${python}; cannot reinstall gateway deps`);
		return;
	}
	const result = await runCommand(
		python,
		["-m", "pip", "install", "-r", requirements, "--disable-pip-version-check", "-q"],
		{ cwd: gatewayDir, timeoutMs: 15 * 60 * 1000 }
	);
	if (result.status !== 0) {
		const tail = String(result.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-4).join("\n");
		throw new Error(
			`gateway dependency install failed (${result.error ?? `pip exited ${result.status}`}); ` +
			`the new python_embeded has no fastapi/uvicorn. Run "${python}" -m pip install -r "${requirements}" then retry.` +
			(tail ? `\n${tail}` : "")
		);
	}
	lines.push("reinstalled gateway dependencies into the new python_embeded");
}

/** 备份单元的父目录：engine 以整个便携版目录为单元，基准是其父目录。 */
function componentBase(layout, component) {
	return component === "engine" ? path.dirname(layout.engineRoot) : componentRoot(layout, component);
}

function backupsRoot(layout, component) {
	return path.join(layout.stateDir, BACKUPS_DIR, component);
}

/** 解析清单里的组件/档位，返回 { name, version, chosen }。 */
function resolvePack(manifest, component, pack) {
	if (manifest === null) return null;
	const node = manifest.components?.[component];
	if (node === undefined) return null;
	const packs = node.packs ?? { default: node };
	const name = pack === undefined ? Object.keys(packs)[0] : String(pack);
	const chosen = packs[name];
	if (chosen === undefined) return null;
	return {
		name,
		version: typeof chosen.version === "string" ? chosen.version : null,
		label: typeof chosen.label === "string" ? chosen.label : null,
		chosen
	};
}

/** 引擎内置版本文件；读不到返回 null（不猜版本）。 */
export function readEngineVersion(layout) {
	try {
		const body = readFileSync(path.join(layout.engineRoot, "ComfyUI", "comfyui_version.py"), "utf8");
		const match = /__version__\s*=\s*["']([^"']+)["']/.exec(body);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

/** 版本比较：去掉前缀 v、忽略空白（"v0.44.0" 与 "0.44.0" 视为同版）。 */
function sameVersion(a, b) {
	const norm = (value) => String(value ?? "").trim().replace(/^[vV]/, "");
	const left = norm(a);
	return left !== "" && left === norm(b);
}

/**
 * 组件版本视图：
 *  - targetVersion：清单当前登记的版本（升级目标）
 *  - installedVersion：已安装版本（引擎以磁盘 comfyui_version.py 为准，其次 state 记录 / 清单探测）
 *  - updateAvailable：已安装且「磁盘真实版本」与清单不同，或有清单文件缺失（需要修复）
 */
export function componentVersions(manifest, component, pack, layout, state, missing) {
	const info = resolvePack(manifest, component, pack);
	const targetVersion = info?.version ?? null;
	const recorded = state?.installed?.[component] ?? null;
	let installedVersion = recorded?.version ?? null;
	let versionSource = recorded ? "recorded" : null;
	if (component === "engine") {
		const engineVersion = readEngineVersion(layout);
		if (engineVersion !== null) {
			installedVersion = engineVersion;
			versionSource = "engine";
		}
	}
	const installed = existsSync(componentRoot(layout, component));
	const missingCount = Number.isInteger(missing)
		? missing
		: entriesOf(manifest, component, pack, layout, {}).filter((entry) => !entryPresent(entry)).length;
	if (!installedVersion && installed && missingCount === 0) {
		installedVersion = targetVersion;
		versionSource = "manifest";
	}
	// 两种「要动手」的情况必须分开，否则界面会出现「可升级 → 和已装版本一模一样」：
	//  - versionMismatch：磁盘版本 ≠ 清单版本  → 真的升级
	//  - needsRepair    ：版本对但缺文件      → 修复（重新下载缺的那几个）
	const versionMismatch =
		installed && targetVersion !== null && installedVersion !== null && !sameVersion(installedVersion, targetVersion);
	const needsRepair = installed && missingCount > 0;
	return {
		targetVersion,
		installedVersion,
		versionSource,
		installed,
		versionMismatch,
		needsRepair,
		// 保留旧字段语义：有任何一个动作可做（升级或修复）
		updateAvailable: versionMismatch || needsRepair
	};
}

/** 列出一个组件的旧版本备份（按时间倒序；只认带 meta.json 的备份）。 */
export function listBackups(layout, component) {
	const root = backupsRoot(layout, component);
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const rows = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const meta = readJson(path.join(root, entry.name, "meta.json"), null);
		if (meta === null || !Array.isArray(meta.payloads)) continue;
		rows.push({
			...meta,
			id: entry.name,
			dir: path.join(root, entry.name),
			base: componentBase(layout, component)
		});
	}
	return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * 把 targets 移入备份目录（同盘 rename，毫秒级，不复制 10GB 文件）。
 * 返回备份对象；targets 为空返回 null。失败时由调用方决定是否回滚。
 */
export function backupTargets(layout, component, targets, extra = {}) {
	const base = componentBase(layout, component);
	const list = [...new Set(targets.map((target) => path.resolve(target)))].filter((target) => existsSync(target));
	if (list.length === 0) return null;
	const version = safeSegment(extra.version);
	let dir = path.join(backupsRoot(layout, component), `${version}-${backupStamp()}`);
	let serial = 2;
	while (existsSync(dir)) {
		dir = path.join(backupsRoot(layout, component), `${version}-${backupStamp()}-${serial}`);
		serial += 1;
	}
	const payloadDir = path.join(dir, "payload");
	// 备份靠同盘 rename（毫秒级）；跨盘先从第一步开始就会失败，不留下半移状态。
	const backupVolume = path.parse(dir).root.toLowerCase();
	for (const target of list) {
		if (path.parse(target).root.toLowerCase() !== backupVolume) {
			throw new Error(
				`backup requires ${target} on the same volume as ${dir}; nothing moved (move installRoot or the component to one disk)`
			);
		}
	}
	const payloads = [];
	let bytes = 0;
	let files = 0;
	try {
		for (const target of list) {
			const rel = path.relative(base, target);
			if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
				throw new Error(`backup refused: ${target} is not inside ${base}`);
			}
			const stat = lstatSync(target);
			const size = stat.isDirectory() ? dirSize(target) : { bytes: stat.size, files: 1 };
			const dest = path.join(payloadDir, rel);
			mkdirSync(path.dirname(dest), { recursive: true });
			renameSync(target, dest);
			payloads.push(rel);
			bytes += size.bytes;
			files += size.files;
		}
	} catch (error) {
		// 中途失败：把已进入备份的条目移回原位，保持「失败不改变现状」。
		for (const rel of [...payloads].reverse()) {
			try {
				const target = path.join(base, rel);
				mkdirSync(path.dirname(target), { recursive: true });
				renameSync(path.join(payloadDir, rel), target);
			} catch {
				/* 恢复失败时保留备份，由调用方报错 */
			}
		}
		throw error;
	}
	const meta = {
		id: path.basename(dir),
		component,
		version: extra.version ?? null,
		pack: extra.pack ?? null,
		kind: extra.kind ?? "files",
		createdAt: new Date().toISOString(),
		bytes,
		files,
		payloads
	};
	writeJson(path.join(dir, "meta.json"), meta);
	return { ...meta, dir, base };
}

/** 把备份内容移回原位（升级失败回滚）；成功后删除备份目录。 */
export function restoreBackup(layout, backup) {
	const base = backup.base ?? componentBase(layout, backup.component);
	for (const rel of backup.payloads) {
		const target = path.join(base, rel);
		const safe = path.relative(base, target);
		if (safe === "" || safe.startsWith("..") || path.isAbsolute(safe)) {
			throw new Error(`restore refused: ${target} is outside ${base}`);
		}
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		mkdirSync(path.dirname(target), { recursive: true });
		renameSync(path.join(backup.dir, "payload", rel), target);
	}
	rmSync(backup.dir, { recursive: true, force: true });
}

/** 删除一个旧版本备份（id 只允许安全字符，且必须落在 backups/<component> 内）。 */
export function removeBackup(layout, component, id) {
	const root = backupsRoot(layout, component);
	if (!/^[A-Za-z0-9._-]+$/.test(String(id))) throw new Error(`invalid backup id: ${String(id)}`);
	const target = assertWithin(root, path.join(root, String(id)));
	if (path.resolve(target) === path.resolve(root)) throw new Error("refusing to delete the backups root");
	if (!existsSync(target)) throw new Error(`backup not found: ${component}/${String(id)}`);
	if (lstatSync(target).isSymbolicLink()) {
		throw new Error(`${component}/${String(id)} is a junction/symlink; refusing to delete`);
	}
	// 优先用 meta 里的统计（不含 meta.json 本身）；缺失时现场遍历。
	const meta = readJson(path.join(target, "meta.json"), null);
	const { bytes, files } = meta !== null && Number.isFinite(meta.bytes) ? meta : dirSize(target);
	rmSync(target, { recursive: true, force: true });
	return { bytes, files };
}

/** 升级成功后按 keepVersions 清理更旧的备份；返回被清理的条目。 */
export function pruneBackups(layout, component, keep) {
	const limit = Math.max(0, Math.min(2, Number(keep) || 0));
	const removed = [];
	for (const backup of listBackups(layout, component).slice(limit)) {
		try {
			const size = removeBackup(layout, component, backup.id);
			removed.push({ ...backup, ...size });
		} catch {
			/* 删不掉就留着，下次升级/手动删除再处理 */
		}
	}
	return removed;
}

/** 断言目标落在 root 内（含 root 自身），否则抛错——删除/写入的唯一护栏。 */
function assertWithin(root, target) {
	const absRoot = path.resolve(root);
	const absTarget = path.resolve(target);
	const rel = path.relative(absRoot, absTarget);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return absTarget;
	throw new Error(`refused: ${absTarget} is outside ${absRoot}`);
}

/** 删除只允许命中三个已配置组件根之一；不在 installRoot 下的已有资产（用户显式配置）也允许。 */
function assertManagedRoot(layout, target) {
	const absTarget = path.resolve(target);
	for (const root of [layout.engineRoot, layout.modelsRoot, layout.upscaleRoot]) {
		if (path.resolve(root) === absTarget) return absTarget;
	}
	return assertWithin(layout.installRoot, absTarget);
}

/** volatile 字段在宿主侧可能是 { get() } 描述符；统一拆包后当字符串用。 */
function text(value) {
	const raw = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
	return String(raw ?? "").trim();
}

/** 解析安装根：installRoot 优先；空则回落到各组件已有路径的父级。 */
export function resolveLayout(config) {
	const engineRoot = text(config?.engineRoot).replace(/[\\/]+$/, "");
	const modelsRoot = text(config?.modelsRoot).replace(/[\\/]+$/, "");
	const upscaleRoot = text(config?.upscaleEnginesRoot).replace(/[\\/]+$/, "");
	const installRoot = text(config?.installRoot).replace(/[\\/]+$/, "")
		// engineRoot 默认是 <installRoot>/engine/ComfyUI_windows_portable；向上两级回推工具分类根。
		|| (engineRoot ? path.dirname(path.dirname(engineRoot)) : path.dirname(modelsRoot || process.cwd()));
	return {
		installRoot,
		engineRoot: engineRoot || path.join(installRoot, "engine", "ComfyUI_windows_portable"),
		modelsRoot: modelsRoot || path.join(installRoot, "models"),
		upscaleRoot: upscaleRoot || path.join(installRoot, "upscale-engines", "engines"),
		// 生成图输出目录（只读展示；实际写入由 generate/upscale 模块按 Config.outputDir 执行）。
		outputDir: text(config?.outputDir).replace(/[\\/]+$/, "") || path.join(installRoot, "outputs"),
		stateDir: path.join(installRoot, STATE_DIR)
	};
}

/** 默认工具分类根：单点定义在 lib/paths.js（IMAGEKIT_INSTALL_ROOT 可覆盖）。 */
export function defaultAssetPaths() {
	return defaultPaths();
}

/** 清单加载：随包提供的 models.manifest.json；缺失视为「无可下载清单」。 */
export function loadManifest(pluginRoot) {
	const file = path.join(pluginRoot, MANIFEST_FILE);
	const manifest = readJson(file, null);
	if (manifest === null || typeof manifest !== "object") {
		return { file, manifest: null, error: `清单缺失或不可解析：${file}` };
	}
	return { file, manifest, error: null };
}

/** 按 modelSource / upscaleSource 选下载 URL；custom 用 modelPackBaseUrl 拼相对路径。 */
export function pickUrl(entry, config) {
	const sources = entry?.sources ?? {};
	if (entry?.path && String(config?.modelPackBaseUrl ?? "") !== "") {
		const base = String(config.modelPackBaseUrl).replace(/\/+$/, "");
		return `${base}/${String(entry.path).replace(/^\/+/, "")}`;
	}
	const preferred =
		entry?.kind === "upscale" ? String(config?.upscaleSource ?? "official") : String(config?.modelSource ?? "huggingface");
	// "mirror" 留给「我们自己/用户自建的镜像」：清单条目里加 sources.mirror 即可生效，默认不填就走 official。
	const order = [preferred, "mirror", "sourceforge", "huggingface", "hf-mirror", "modelscope", "official"];
	for (const key of order) {
		const url = sources[key];
		if (typeof url === "string" && url !== "") return url;
	}
	return null;
}

export function fileSha256(file) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(file);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/**
 * GitHub Releases 资源解析：`.../releases/download/<tag>/<asset>` → Releases API 直链。
 *
 * github.com 的 releases/download 是重定向到 objects.githubusercontent.com 的普通下载；
 * 直连受限或需要鉴权时，用官方 API 取同一份资源更稳：
 *   GET /repos/{owner}/{repo}/releases/tags/{tag} → 找同名 asset.id
 *   GET /repos/{owner}/{repo}/releases/assets/{id} + Accept: application/octet-stream
 * 有 GITHUB_TOKEN / GH_TOKEN 时带 Bearer，避免匿名限额与私有仓库 404。
 * 非 GitHub 链接返回 null。
 */
const GITHUB_RELEASE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/;

async function resolveGithubAsset(url, signal) {
	const match = GITHUB_RELEASE_RE.exec(String(url));
	if (match === null) return null;
	const [, owner, repo, tag, rawAsset] = match;
	const assetName = decodeURIComponent(rawAsset);
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
	const auth = token === "" ? {} : { authorization: `Bearer ${token}` };
	const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
	const res = await fetch(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`, {
		headers: { accept: "application/vnd.github+json", ...auth },
		signal: signal ?? undefined,
		redirect: "follow"
	});
	if (!res.ok) return null;
	const release = await res.json();
	const asset = (release?.assets ?? []).find((row) => row?.name === assetName);
	if (asset === undefined || asset?.id === undefined) return null;
	return {
		url: `${apiBase}/releases/assets/${asset.id}`,
		headers: { accept: "application/octet-stream", ...auth },
		sizeBytes: Number.isFinite(asset.size) ? asset.size : null
	};
}

/**
 * 下载健壮性参数：
 *  - GitHub releases/download 直链在国内网络经常直接连不上（实测 fetch 报
 *    UND_ERR_CONNECT_TIMEOUT），而官方 Releases API 的资产直链通常可达，
 *    所以 GitHub 源优先解析成 API 资产直链，失败再退回原链接；
 *  - undici 的默认连接超时不足以覆盖「连上了但一个字节都不发」的情况，
 *    这里自己做「无数据超时」：每收到一块数据就重置计时，超时即中继重试；
 *  - 失败重试沿用 .partial 续传，不会把已下载的 2 GB 丢掉。
 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const DOWNLOAD_ATTEMPTS = 3;

function sleepFor(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一次下载尝试的取消信号：调用方 signal + 无数据超时（收到数据后自动续期）。 */
function attemptSignal(signal, idleTimeoutMs) {
	const controller = new AbortController();
	const parts = signal === undefined || signal === null ? [controller.signal] : [controller.signal, signal];
	let timer = null;
	const arm = () => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			controller.abort(new Error(`download stalled: no data for ${idleTimeoutMs}ms`));
		}, idleTimeoutMs);
	};
	const dispose = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return { signal: parts.length > 1 ? AbortSignal.any(parts) : parts[0], arm, dispose };
}

/** 把 GitHub 链接改写成代理链接；proxyBase 为空或不是 GitHub 链接时返回 null。
 *  只用于 `github.com/...` 发布页链接：ghfast.top 之类的代理不代 api.github.com（实测 403）。 */
export function proxiedUrl(url, proxyBase) {
	const base = String(proxyBase ?? "").trim();
	if (base === "") return null;
	const target = String(url);
	if (!/^https:\/\/github\.com\//i.test(target)) return null;
	return `${base.replace(/\/+$/, "")}/${target}`;
}

/**
 * 候选下载地址（按优先级）：
 *   1. 官方 Releases API 资产直链——本机实测最快（4.0 MB/s）且稳定；
 *   2. `githubProxy` 配置的代理（仅当用户显式配置）——直连被墙时唯一的兜底；
 *   3. 原始 github.com 链接——本机实测 8/8 连接超时，放最后。
 * 注意：代理只提升可达性，本机实测 3.55 MB/s，比 API 直链慢，所以不默认开启。
 */
async function downloadCandidates(url, signal, proxyBase = "") {
	const list = [];
	const target = String(url);
	const isRelease = GITHUB_RELEASE_RE.test(target);
	let apiAsset = null;
	if (isRelease) {
		try {
			apiAsset = await resolveGithubAsset(url, signal);
			if (apiAsset !== null) list.push(apiAsset);
		} catch {
			/* API 不可用（限额/网络）：继续走后面的候选 */
		}
	}
	const proxied = proxiedUrl(target, proxyBase);
	if (proxied !== null) list.push({ url: proxied, headers: {} });
	// 代理已经指到同一份资产时，不再重复请求原始链接
	list.push({ url: target, headers: {} });
	return list;
}

/**
 * 下载单个文件到 dest，支持断点续传。
 * 返回 { downloaded, skipped, reason }；不抛网络错误以外的异常给调用方处理。
 */
/**
 * 多连接分片下载
 * ==============
 * 单连接常被服务端/线路限速；把同一文件切成 N 段并发 Range 请求再拼接，本机实测约 1.4×（4 段；
 * 8 段无额外收益）。仍然只用 Node 内置 fetch，不引入 aria2 之类外部下载器。
 *
 * 安全网：
 *  - 只能用于「知道确切字节数」的条目（清单强制 sizeBytes），否则无法切分；
 *  - 先用 `bytes=0-0` 探测服务端是否真支持 Range；返回 200 就直接走单流；
 *  - 每段独立续传（`.partial.N`），失败重试后整段回退到单流重下，保证「最差也能下完」；
 *  - 拼接完成才做一次 sha256 校验，与单流路径共用同一套校验与原子改名。
 */
const MULTI_MIN_BYTES = 8 * 1024 * 1024;
const MULTI_PARTS_DEFAULT = 4;
const MULTI_PARTS_MAX = 8;

/** 按总字节数切成 parts 段（边界只由 sizeBytes 决定 → 跨进程稳定，可续传）。 */
function splitRanges(total, parts) {
	const n = Math.max(1, Math.min(parts, MULTI_PARTS_MAX));
	const base = Math.floor(total / n);
	const ranges = [];
	let start = 0;
	for (let i = 0; i < n; i += 1) {
		const end = i === n - 1 ? total - 1 : start + base - 1;
		ranges.push({ start, end });
		start = end + 1;
	}
	return ranges;
}

/** 探测某个候选地址是否支持 Range（请求 1 字节，看是否 206 + content-range）。 */
async function probeRangeSupport(candidates, signal, idleTimeoutMs) {
	for (const candidate of candidates) {
		const ctl = attemptSignal(signal, idleTimeoutMs);
		ctl.arm();
		try {
			const res = await fetch(candidate.url, {
				headers: { ...(candidate.headers ?? {}), Range: "bytes=0-0" },
				signal: ctl.signal,
				redirect: "follow"
			});
			const ok = res.status === 206 && String(res.headers.get("content-range") ?? "").startsWith("bytes 0-0/");
			try {
				await res.body?.cancel();
			} catch {
				/* 已关闭 */
			}
			ctl.dispose();
			if (ok) return candidate;
		} catch (error) {
			ctl.dispose();
			if (signal?.aborted) throw error;
		}
	}
	return null;
}

/** 下载一段（支持段内续传）；服务端忽略 Range（返回 200）时抛 rangeUnsupported 触发回退。 */
async function downloadPart(candidates, partFile, start, end, signal, idleTimeoutMs, onBytes) {
	const expected = end - start + 1;
	let have = existsSync(partFile) ? statSync(partFile).size : 0;
	if (have === expected) return;
	if (have > expected) {
		rmSync(partFile, { force: true });
		have = 0;
	}
	const headers = have > 0 ? { Range: `bytes=${start + have}-${end}` } : { Range: `bytes=${start}-${end}` };
	let lastError = null;
	for (const candidate of candidates) {
		const ctl = attemptSignal(signal, idleTimeoutMs);
		ctl.arm();
		let res;
		try {
			res = await fetch(candidate.url, {
				headers: { ...(candidate.headers ?? {}), ...headers },
				signal: ctl.signal,
				redirect: "follow"
			});
		} catch (error) {
			ctl.dispose();
			lastError = error;
			continue;
		}
		if (res.status === 200) {
			// 服务端无视 Range：分段方案不可用，交给调用方回退单流
			try {
				await res.body?.cancel();
			} catch {
				/* 忽略 */
			}
			ctl.dispose();
			throw Object.assign(new Error("server ignored Range"), { rangeUnsupported: true });
		}
		if (res.status !== 206) {
			try {
				await res.body?.cancel();
			} catch {
				/* 忽略 */
			}
			ctl.dispose();
			lastError = new Error(`HTTP ${res.status} for part ${start}-${end}`);
			continue;
		}
		try {
			const sink = createWriteStream(partFile, { flags: have > 0 ? "a" : "w" });
			await pipeline(
				Readable.fromWeb(res.body),
				async function* (source) {
					for await (const chunk of source) {
						ctl.arm();
						have += chunk.length;
						onBytes(chunk.length);
						yield chunk;
					}
				},
				sink
			);
			ctl.dispose();
			if (have !== expected) throw new Error(`part ${start}-${end} incomplete: ${have}/${expected}`);
			return;
		} catch (error) {
			ctl.dispose();
			if (signal?.aborted) throw error;
			lastError = error;
		}
	}
	throw lastError ?? new Error(`part ${start}-${end} failed`);
}

/** 顺序拼接分段文件到 out（手动处理背压，避免大文件把内存顶爆）。 */
async function concatParts(parts, out) {
	const sink = createWriteStream(out);
	try {
		for (const part of parts) {
			for await (const chunk of createReadStream(part)) {
				if (!sink.write(chunk)) await once(sink, "drain");
			}
		}
	} finally {
		await new Promise((resolve, reject) => {
			sink.end((error) => (error ? reject(error) : resolve()));
		});
	}
}

/** 多连接下载：成功返回 true；服务端不支持 Range 或重试用尽返回 false（调用方回退单流）。 */
async function downloadMulti(url, dest, { sizeBytes, sha256, onProgress, signal, proxyBase, connections, idleTimeoutMs }) {
	const candidates = await downloadCandidates(url, signal, proxyBase);
	const probed = await probeRangeSupport(candidates, signal, idleTimeoutMs);
	if (probed === null) return false;
	const orderedCandidates = [probed, ...candidates.filter((c) => c !== probed)];

	const partFiles = [];
	const written = [];
	const ranges = splitRanges(sizeBytes, connections);
	let reported = 0;
	const report = () => {
		if (onProgress) onProgress({ written: reported, total: sizeBytes });
	};
	try {
		ranges.forEach((_, i) => {
			partFiles.push(`${dest}.partial.${i}`);
			written.push(0);
		});
		// 已存在的分段按大小计入（续传场景）
		let resumed = 0;
		for (const file of partFiles) if (existsSync(file)) resumed += statSync(file).size;
		reported = resumed;
		report();

		await Promise.all(
			ranges.map((range, i) =>
				downloadPart(orderedCandidates, partFiles[i], range.start, range.end, signal, idleTimeoutMs, (bytes) => {
					written[i] += bytes;
					reported += bytes;
					report();
				})
			)
		);

		const partial = dest + ".partial";
		await concatParts(partFiles, partial);
		const size = statSync(partial).size;
		if (size !== sizeBytes) {
			rmSync(partial, { force: true });
			throw new Error(`size mismatch after concat: got ${size}, expected ${sizeBytes} (partial removed)`);
		}
		if (sha256 !== null) {
			const actual = await fileSha256(partial);
			if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
				rmSync(partial, { force: true });
				const mismatch = new Error(`sha256 mismatch: got ${actual}, expected ${sha256} (partial removed)`);
				mismatch.permanent = true;
				throw mismatch;
			}
		}
		renameSync(partial, dest);
		for (const file of partFiles) rmSync(file, { force: true });
		return true;
	} catch (error) {
		if (error?.rangeUnsupported === true) {
			for (const file of partFiles) rmSync(file, { force: true });
			rmSync(dest + ".partial", { force: true });
			return false;
		}
		throw error;
	}
}

export async function downloadTo(url, dest, { sizeBytes = null, sha256 = null, onProgress = null, signal = null, force = false, attempts = DOWNLOAD_ATTEMPTS, idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS, proxyBase = "", connections = MULTI_PARTS_DEFAULT } = {}) {
	mkdirSync(path.dirname(dest), { recursive: true });
	const partial = dest + ".partial";
	// force：升级时旧文件已进备份，无视已有目标重新拉取；.partial 仍可续传。
	if (force) rmSync(dest, { force: true });
	if (!force && existsSync(dest)) {
		const have = statSync(dest).size;
		if (sizeBytes !== null && have === sizeBytes) return { skipped: true, reason: "already downloaded (size matches)" };
		// 归档条目通常没有上游字节数；存在即视为已下载，解压步骤会再校验 checkPath。
		if (sizeBytes === null && sha256 === null) return { skipped: true, reason: "already downloaded (archive)" };
	}
	const maxAttempts = Math.max(1, Number(attempts) || 1);
	// 多连接：仅当已知确切大小、文件足够大且用户没关掉时启用；
	// 失败/服务端不支持 Range 都会自动回退到下面的单流路径。
	const wantedConnections = Math.max(1, Math.min(MULTI_PARTS_MAX, Number(connections) || MULTI_PARTS_DEFAULT));
	if (wantedConnections > 1 && sizeBytes !== null && sizeBytes >= MULTI_MIN_BYTES && !existsSync(partial)) {
		try {
			// force 时旧目标已在上面删掉、分段也可能残留：先清干净再分片
			if (force) for (let i = 0; i < wantedConnections; i += 1) rmSync(`${dest}.partial.${i}`, { force: true });
			const done = await downloadMulti(url, dest, {
				sizeBytes,
				sha256,
				onProgress,
				signal,
				proxyBase,
				connections: wantedConnections,
				idleTimeoutMs
			});
			if (done) return { skipped: false, bytes: sizeBytes, connections: wantedConnections };
		} catch (error) {
			// 内容校验失败（sha256）不重试；其它错误（网络/断流）回退单流再试一次
			if (error?.permanent === true) throw error;
			if (signal !== undefined && signal !== null && signal.aborted) throw error;
		}
	}
	let lastError = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		// 每次尝试都按 .partial 现有长度续传；服务端不支持 Range 时下面会退回从头写。
		const start = existsSync(partial) ? statSync(partial).size : 0;
		const rangeHeaders = start > 0 ? { Range: `bytes=${start}-` } : {};
		const candidates = await downloadCandidates(url, signal, proxyBase);
		let opened = null;
		for (const candidate of candidates) {
			const ctl = attemptSignal(signal, idleTimeoutMs);
			ctl.arm();
			try {
				const res = await fetch(candidate.url, {
					headers: { ...(candidate.headers ?? {}), ...rangeHeaders },
					signal: ctl.signal,
					redirect: "follow"
				});
				// 416：.partial 比远端文件还长（上次下载残留/远端换包）——丢掉重来
				if (res.status === 416) {
					try {
						await res.body?.cancel();
					} catch {
						/* 忽略 */
					}
					rmSync(partial, { force: true });
					ctl.dispose();
					lastError = new Error(`range not satisfiable for ${candidate.url} (partial removed)`);
					continue;
				}
				if (!res.ok && res.status !== 206) {
					try {
						await res.body?.cancel();
					} catch {
						/* 忽略 */
					}
					throw new Error(`HTTP ${res.status}`);
				}
				opened = { res, ctl };
				break;
			} catch (error) {
				ctl.dispose();
				lastError = error;
			}
		}
		if (opened === null) {
			if (attempt < maxAttempts) {
				await sleepFor(1200 * attempt);
				continue;
			}
			break;
		}
		const { res, ctl } = opened;
		let written = start;
		try {
			// 服务器不支持 Range（返回 200 而非 206）时从头写，避免拼接出坏文件
			if (written > 0 && res.status !== 206) {
				written = 0;
				rmSync(partial, { force: true });
			}
			const total = sizeBytes ?? (res.headers.get("content-length") ? written + Number(res.headers.get("content-length")) : null);
			const sink = createWriteStream(partial, { flags: written > 0 ? "a" : "w" });
			await pipeline(
				Readable.fromWeb(res.body),
				async function* (source) {
					for await (const chunk of source) {
						ctl.arm(); // 收到数据就重置「无数据超时」
						written += chunk.length;
						if (onProgress) onProgress({ written, total });
						yield chunk;
					}
				},
				sink
			);
			if (sizeBytes !== null && written !== sizeBytes) {
				throw new Error(`size mismatch: got ${written}, expected ${sizeBytes} (partial kept for resume)`);
			}
			if (sha256 !== null) {
				const actual = await fileSha256(partial);
				if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
					rmSync(partial, { force: true });
					// 哈希不符是「拿到的包就是错的」：重试只会把 2 GB 再下一遍，直接失败
					const mismatch = new Error(`sha256 mismatch: got ${actual}, expected ${sha256} (partial removed)`);
					mismatch.permanent = true;
					throw mismatch;
				}
			}
			renameSync(partial, dest);
			return { skipped: false, bytes: written, connections: 1 };
		} catch (error) {
			lastError = error;
			// 调用方取消：立刻上抛，不当作「网络抖动」重试
			if (signal !== undefined && signal !== null && signal.aborted) throw error;
			// 内容校验失败（sha256 不符）不重试：换多少字节都一样错
			if (error?.permanent === true) throw error;
			if (attempt < maxAttempts) await sleepFor(1200 * attempt);
		} finally {
			ctl.dispose();
		}
	}
	throw lastError ?? new Error(`download failed: ${url}`);
}

/** 找 7z：环境变量 > 常见安装路径 > PATH。 */
/**
 * 解压器候选（按优先级）：
 *   1. 7-Zip —— 支持选择性解压（extractGlobs），速度快；
 *   2. Windows 10 1803+ 自带的 bsdtar（C:\Windows\System32\tar.exe，libarchive）——
 *      **能读 7z 和 zip**，也支持 `--include` 通配符，所以没装 7-Zip 的机器照样能装引擎/放大包；
 *   3. PATH 上的 tar（Linux/macOS 的 bsdtar 同样支持；GNU tar 不支持 7z，失败会自动跳过）。
 * `IMAGEKIT_EXTRACTOR=7z|tar` 可强制只用其中一种（排障/测试用）。
 */
function findExtractors() {
	const forced = String(process.env.IMAGEKIT_EXTRACTOR ?? "").trim().toLowerCase();
	const list = [];
	if (forced !== "tar") {
		const sevenZip = [
			process.env.SEVEN_ZIP,
			"C:/Program Files/7-Zip/7z.exe",
			"C:/Program Files (x86)/7-Zip/7z.exe"
		].filter((value) => typeof value === "string" && value !== "");
		for (const candidate of sevenZip) {
			if (existsSync(candidate)) list.push({ kind: "7z", cmd: candidate, label: candidate });
		}
		// PATH 上的 7z 放最后：存在与否只能靠 spawn 试出来
		list.push({ kind: "7z", cmd: "7z.exe", label: "7z.exe (PATH)" });
	}
	if (forced !== "7z") {
		const windowsTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
		if (process.platform === "win32" && existsSync(windowsTar)) {
			list.push({ kind: "tar", cmd: windowsTar, label: "Windows 自带 tar (libarchive)" });
		}
		list.push({ kind: "tar", cmd: "tar", label: "tar (PATH)" });
	}
	return list;
}

/** 当前会优先使用的解压器（status 展示用，不实际执行）。 */
function describeExtractor() {
	const [first] = findExtractors();
	return first === undefined ? "none (install 7-Zip or use Windows 10+)": `${first.kind} — ${first.label}`;
}

/** 按 kind 生成解压命令参数。 */
function extractArgs(extractor, archive, outDir, globs) {
	if (extractor.kind === "7z") return ["x", archive, `-o${outDir}`, "-y", "-bd", ...globs];
	// bsdtar：-C 指定输出目录；--include 逐个追加通配符（等价于 7z 的位置参数过滤）
	return ["-xf", archive, "-C", outDir, ...globs.flatMap((glob) => ["--include", glob])];
}

function runProcess(file, args, timeoutMs = 20 * 60 * 1000) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`${file} timed out after ${timeoutMs}ms`)); }, timeoutMs);
		child.stderr.on("data", (chunk) => { err = (err + String(chunk)).slice(-4000); });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ code });
			else reject(new Error(`${file} exited ${code}: ${err}`));
		});
	});
}

/** 在解压目录里按 basename 找目录（浅层优先）；用于整合包只挑引擎目录。 */
function findDirByBasename(root, name) {
	let level = [root];
	for (let depth = 0; depth < 8 && level.length > 0; depth += 1) {
		const next = [];
		for (const dir of level) {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const abs = path.join(dir, entry.name);
				if (entry.name === name) return abs;
				next.push(abs);
			}
		}
		level = next;
	}
	return null;
}

/**
 * 解压归档：
 *  - 普通包：整体解压到 extractDir，可按 extractRename 重命名顶层目录；
 *  - 整合包：extractGlobs 只解压匹配路径到临时目录，再按 extractMove 把引擎目录搬到 extractDir。
 * 7z 不存在时明确报错，不假装成功。
 */
async function extractArchive(archive, extractDir, renameSpec, entry = {}) {
	const globs = entry.extractGlobs ?? [];
	const moves = entry.extractMove ?? [];
	const extractors = findExtractors();
	if (extractors.length === 0) {
		throw new Error(
			`no extractor available for ${path.basename(archive)}: install 7-Zip (https://www.7-zip.org) ` +
				"or use Windows 10 1803+ which ships tar.exe; on Linux/macOS install p7zip"
		);
	}
	let used = null;
	let lastError = null;
	for (const extractor of extractors) {
		try {
			await extractArchiveWith(extractor, archive, extractDir, renameSpec, entry);
			used = extractor;
			break;
		} catch (error) {
			lastError = error;
			// 命令不存在（没装）→ 换下一个；解压失败（包损坏/参数不对）也换，最终错误会带上两条原因
			continue;
		}
	}
	if (used === null) {
		throw new Error(
			`extract failed for ${path.basename(archive)} (tried ${extractors.map((e) => e.label).join(", ")}): ` +
				String(lastError?.message ?? lastError)
		);
	}
	lastExtractor = used;
	return used;
}

/** 用一个具体的解压器解压（内部函数：由 extractArchive 依次尝试）。 */
async function extractArchiveWith(extractor, archive, extractDir, renameSpec, entry = {}) {
	const globs = entry.extractGlobs ?? [];
	const moves = entry.extractMove ?? [];
	if (globs.length > 0 || moves.length > 0) {
		const staging = path.join(extractDir, `.staging-${process.pid}-${Date.now()}`);
		mkdirSync(extractDir, { recursive: true });
		mkdirSync(staging, { recursive: true });
		try {
			await runProcess(extractor.cmd, extractArgs(extractor, archive, staging, globs));
			for (const name of moves) {
				const found = findDirByBasename(staging, name);
				if (found === null) {
					throw new Error(`archive ${archive} does not contain ${name} (checked extractGlobs)`);
				}
				const target = path.join(extractDir, name);
				// 已存在的引擎目录保留不动（重装/修复时不会覆盖用户当前可用版本）。
				if (existsSync(target)) continue;
				renamePath(found, target);
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
		return;
	}
	mkdirSync(extractDir, { recursive: true });
	await runProcess(extractor.cmd, extractArgs(extractor, archive, extractDir, []));
	if (renameSpec !== null && renameSpec !== undefined) {
		const from = path.join(extractDir, String(renameSpec.from));
		const to = path.join(extractDir, String(renameSpec.to));
		if (existsSync(from)) {
			if (existsSync(to)) {
				// overwrite=true：目标目录是被替换的引擎本体，整目录换掉才不会新旧 exe / 模型混在一起
				if (renameSpec.overwrite !== true) throw new Error(`extract target already exists: ${to}`);
				rmSync(to, { recursive: true, force: true });
			}
			renamePath(from, to);
		}
	}
}

/** 收集某组件某档位的文件条目（统一成 {url, dest, sizeBytes, sha256, label}）。 */
function entriesOf(manifest, component, pack, layout, config) {
	const info = resolvePack(manifest, component, pack);
	if (info === null) return [];
	const chosen = info.chosen;
	const list = Array.isArray(chosen) ? chosen : Array.isArray(chosen.files) ? chosen.files : [];
	const baseDir =
		component === "engine" ? layout.installRoot : component === "models" ? layout.modelsRoot : layout.upscaleRoot;
	return list.map((entry) => ({
		label: entry.label ?? entry.path ?? "(unnamed)",
		url: pickUrl({ ...entry, kind: component }, config),
		dest: assertWithin(baseDir, path.join(baseDir, String(entry.path ?? ""))),
		extractTo: entry.extractTo
			? assertWithin(baseDir, path.join(baseDir, String(entry.extractTo)))
			: null,
		extractRename: entry.extractRename ?? null,
		// 整合包选择性解压：extractGlobs 传给 7z 只解压匹配路径，extractMove 按目录名搬到目标根
		extractGlobs: Array.isArray(entry.extractGlobs) ? entry.extractGlobs.map((g) => String(g)) : null,
		extractMove: Array.isArray(entry.extractMove) ? entry.extractMove.map((g) => String(g)) : null,
		// checkPath/checkPaths：归档类条目「已安装」的判据（下载的是压缩包，解压后包本身可删）
		checkPath:
			entry.checkPath === undefined || entry.checkPath === null
				? null
				: assertWithin(baseDir, path.join(baseDir, String(entry.checkPath))),
		checkPaths: Array.isArray(entry.checkPaths)
			? entry.checkPaths.map((p) => assertWithin(baseDir, path.join(baseDir, String(p))))
			: null,
		sizeBytes: entry.sizeBytes ?? null,
		sha256: entry.sha256 ?? null,
		optional: entry.optional === true
	}));
}

/** 模型各 pack 的独立状态：pack 之间是叠加关系，标准/快速/8G 可同时安装。 */
export function packSummaries(manifest, component, layout, config) {
	const node = manifest?.components?.[component];
	const packs = node?.packs ?? {};
	const rows = [];
	for (const [name, chosen] of Object.entries(packs)) {
		const meta = Array.isArray(chosen) ? {} : chosen;
		const entries = entriesOf(manifest, component, name, layout, config);
		const missingEntries = entries.filter((entry) => !entryPresent(entry));
		const expectedBytes = entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
		const missingBytes = missingEntries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
		rows.push({
			name,
			label: typeof meta.label === "string" ? meta.label : name,
			version: typeof meta.version === "string" ? meta.version : null,
			mode: typeof meta.mode === "string" ? meta.mode : null,
			vram: typeof meta.vram === "string" ? meta.vram : null,
			quant: typeof meta.quant === "string" ? meta.quant : null,
			expected: entries.length,
			missing: missingEntries.length,
			missingBytes,
			expectedBytes,
			installed: entries.length > 0 && missingEntries.length === 0
		});
	}
	return rows;
}

/** 清单条目的「已安装」判据：checkPaths 全在；否则 checkPath/dest 在。 */
function entryPresent(entry) {
	if (Array.isArray(entry.checkPaths) && entry.checkPaths.length > 0) {
		return entry.checkPaths.every((checkPath) => existsSync(checkPath));
	}
	return existsSync(entry.checkPath ?? entry.dest);
}

/** 组件现状：路径、体积、是否已安装、缺失文件数、版本与旧版本备份。 */
export function componentStatus(manifest, component, pack, layout, config, state = {}) {
	const info = resolvePack(manifest, component, pack);
	const entries = entriesOf(manifest, component, pack, layout, config);
	const root = componentRoot(layout, component);
	const installed = existsSync(root);
	const { bytes, files } = installed ? dirSize(root) : { bytes: 0, files: 0 };
	const missing = entries.filter((e) => !entryPresent(e));
	const expectedBytes = entries.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0);
	const versions = componentVersions(manifest, component, pack, layout, state, missing.length);
	return {
		component,
		pack: info?.name ?? pack,
		packLabel: info?.label ?? null,
		installedPack: state?.installed?.[component]?.pack ?? null,
		root,
		installed,
		bytes,
		files,
		expected: entries.length,
		missing: missing.length,
		expectedBytes,
		...versions,
		packs: component === "models" ? packSummaries(manifest, component, layout, config) : [],
		backups: listBackups(layout, component)
	};
}

/** 生成人可读的状态报告（tool render 用）。 */
export function renderStatus(lines) {
	return lines.join("\n");
}

/**
 * 注册资源管理工具（image_setup）。
 * 组件操作是显式调用：status 只读；install/upgrade/delete/clean 都会改磁盘。
 */
export function registerSetupTools(ctx, { pluginRoot, config }) {
	const routeConfig = config;
	// 设置页/手动按钮的 host 路由：只调用同一个 image_setup 工具，不绕过任何护栏。
	try {
		ctx.inject?.(["connection"], (c) => {
			const connection = c.get?.("connection");
			const register = connection?.fetch?.register;
			if (typeof register !== "function") return;
			// 同一个路由骨架：请求体透传给指定工具，不另开写盘路径。
			const toolHandler = (toolName) => async (request) => {
				let body;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, message: "body is not JSON" }, { status: 400 });
				}
				const tool = ctx.tools?.get?.(toolName);
				if (tool === undefined || typeof tool.execute !== "function") {
					return Response.json({ ok: false, message: `${toolName} tool is not registered` }, { status: 503 });
				}
				try {
					const value = await tool.execute(body ?? {}, {});
					return Response.json({ ok: true, value }, { headers: { "cache-control": "no-store" } });
				} catch (error) {
					return Response.json({ ok: false, message: String(error?.message ?? error) }, { status: 500 });
				}
			};
			c.effect(
				() =>
					register({
						path: "/api/dsh-imagekit/setup",
						methods: ["POST"],
						requestBody: "buffered",
						fetch: toolHandler("image_setup")
					}),
				"imagekit: setup route"
			);
			// 设置页「性能与显存」面板：只读快照，走同一个 perf 工具。
			c.effect(
				() =>
					register({
						path: "/api/dsh-imagekit/perf",
						methods: ["POST"],
						requestBody: "buffered",
						fetch: toolHandler("perf")
					}),
				"imagekit: perf route"
			);
		});
	} catch {
		/* 无 connection 服务的宿主：工具仍可用，只是没有设置页按钮。 */
	}
	void routeConfig;
	const layout = resolveLayout(config);
	const { manifest, error: manifestError } = loadManifest(pluginRoot);
	const stateFile = path.join(layout.stateDir, STATE_FILE);
	const jobFile = path.join(layout.stateDir, JOB_FILE);

	const readState = () => readJson(stateFile, {});
	const writeState = (patch) => writeJson(stateFile, { ...readState(), ...patch });
	const readJob = () => readJson(jobFile, null);
	const writeJob = (job) => writeJson(jobFile, job);
	/**
	 * 首次 status 把探测到的当前版本落盘（adopted）。
	 * 没有这一步，清单升版本后磁盘齐全会被“推断成新版本”，升不了级；
	 * 只是写版本元数据，不动任何资产文件。
	 */
	const adoptDetectedVersions = (rows) => {
		// 安装/升级进行中不写 state，避免和任务收尾的版本记录互相覆盖。
		if (readJob()?.state === "running") return 0;
		const state = readState();
		const installed = { ...(state.installed ?? {}) };
		let count = 0;
		for (const row of rows) {
			if (!row.installed || row.missing !== 0 || row.targetVersion === null) continue;
			const detected = row.component === "engine" ? readEngineVersion(layout) : null;
			const current = installed[row.component];
			if (current !== undefined) {
				// 旧记录里可能写的是 "latest" 这类非版本字符串（早期清单把 version 当渠道名用）：
				// 磁盘能探到真实版本就修回真实值，否则这个记录会一直误导升级判定。
				if (detected !== null && !/^v?\d+(\.\d+)*$/i.test(String(current.version ?? ""))) {
					installed[row.component] = { ...current, version: detected, engineVersion: detected, repairedAt: new Date().toISOString() };
					count += 1;
				}
				continue;
			}
			installed[row.component] = {
				// 引擎记录磁盘探测到的版本：装的是 0.39.0 就不能记成清单的 0.44.0
				version: detected ?? row.targetVersion,
				engineVersion: row.component === "engine" ? detected : undefined,
				pack: row.pack ?? null,
				at: new Date().toISOString(),
				source: "adopted"
			};
			count += 1;
		}
		if (count > 0) writeState({ installed });
		return count;
	};

	ctx.tools.register(
		defineTool({
			name: "image_setup",
			description: "Install, verify, upgrade or delete engine / model packs / upscale packs. Model packs are additive: delete pack=<name> removes only that pack's own files.",
			parameters: {
				action: {
					type: "string",
					enum: ["status", "defaults", "install", "upgrade", "delete", "verify", "clean"],
					required: true,
					description: "status | defaults | install | upgrade | delete | verify | clean."
				},
				component: {
					type: "string",
					enum: COMPONENTS,
					description: "install/upgrade/delete/verify: engine | models | upscale (default all for status)."
				},
				pack: { type: "string", description: "pack name (core/fast/lowvram/lowvram-fast/full); delete pack=<name> removes just that pack." },
				confirm: { type: "string", description: "delete: must equal the component name." },
				backup: {
					type: "string",
					description: "delete: backup id from status (removes an old version instead of current files)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					properties: {
						action: { type: "string", required: true },
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						components: { type: "array", items: { type: "object", additionalProperties: true }, required: true }
					}
				},
				render: (_args, value) => [{ type: "text", text: value.message }]
			},
			isConcurrencySafe: (args) => args?.action === "status" || args?.action === "verify",
			// 2 GB 引擎归档的下载 + 解压远超 60s：旧值会让「直接调用 image_setup upgrade」
			// 在下载中途被宿主判超时（设置页路由虽然绕过工具超时，但模型直接调用走的是这里）。
			// 下载本身已有「无数据超时 + 3 次重试」兜底，这里给足上限。
			timeoutMs: 30 * 60 * 1000,
			async execute(args, exec) {
				const action = String(args?.action ?? "");
				const signal = exec?.signal ?? null;
				const pack = args?.pack === undefined ? undefined : String(args.pack);

				const statusOf = (component) =>
					componentStatus(manifest, component, pack, layout, config, readState());

				if (action === "defaults") {
					const defaults = defaultAssetPaths();
					return {
						action,
						ok: true,
						message: `defaults: ${defaults.installRoot}`,
						components: [],
						defaults
					};
				}

				if (action === "status") {
					const rows = COMPONENTS.map(statusOf);
					const adopted = adoptDetectedVersions(rows);
					const lines = [
						`installRoot: ${layout.installRoot}`,
						`manifest: ${manifest === null ? `MISSING (${manifestError})` : path.join(pluginRoot, MANIFEST_FILE)}`
					];
					for (const row of rows) {
						const versionText = row.installed
							? `v${row.installedVersion ?? "?"}`
							: row.targetVersion
								? `(manifest v${row.targetVersion})`
								: "";
						const updateText = row.versionMismatch
							? ` -> v${row.targetVersion}`
							: row.needsRepair
								? ` (missing ${row.missing}, repairable)`
								: "";
						lines.push(
							`${row.component}${row.pack ? `/${row.pack}` : ""}: ${row.installed ? "installed" : "absent"} ${versionText}${updateText} ` +
								`@ ${row.root} — ${human(row.bytes)} / ${row.files} files; ` +
								`manifest entries ${row.expected}, missing ${row.missing}` +
								(row.expectedBytes ? `, expected ${human(row.expectedBytes)}` : "") +
								(row.versionSource ? `; version via ${row.versionSource}` : "")
						);
						for (const modelPack of row.packs ?? []) {
							lines.push(
								`  pack ${modelPack.name}: ${modelPack.installed ? "installed" : `missing ${modelPack.missing} (${human(modelPack.missingBytes)})`}` +
									` — ${modelPack.label}${modelPack.missingBytes && modelPack.installed === false ? ` / total ${human(modelPack.expectedBytes)}` : ""}`
							);
						}
						for (const backup of row.backups) {
							lines.push(
								`  backup ${backup.component}/v${backup.version ?? "?"} ${human(backup.bytes)} / ${backup.files} files ` +
									`@ ${backup.dir} [id=${backup.id}]`
							);
						}
					}
					if (adopted > 0) lines.push(`recorded detected versions for ${adopted} component(s) in ${stateFile}`);
					const job = readJob();
					if (job !== null) lines.push(`last job: ${job.action} ${job.component ?? ""} ${job.state}${job.message ? ` — ${job.message}` : ""}`);
					lines.push(
						// 当前会优先用哪个解压器 + 最近一次实际用了哪个（没有 7-Zip 时这里会显示 tar）
						`extractor: ${describeExtractor()}${lastExtractor !== null ? ` (last used: ${lastExtractor.kind})` : ""}`,
						`outputDir: ${layout.outputDir ?? "(from Config.outputDir)"}`,
						"Downloads are explicit: run image_setup action=install component=models pack=core (needs network); " +
							"upgrade keeps a backup and auto-rolls back on failure; delete needs confirm=<component>; " +
							"delete backup=<id> removes an old version."
					);
					// job 给设置页显示「进度 x/y / 失败原因」；模型可见文本仍只用 message。
					// job 给设置页画进度条：字节级百分比优先，缺字节数时退回文件数百分比
					const lastJob = readJob();
					const jobOut =
						lastJob === null || typeof lastJob !== "object"
							? lastJob
							: {
									...lastJob,
									percent:
										Number(lastJob.totalBytes) > 0
											? Math.max(0, Math.min(100, Math.round((Number(lastJob.writtenBytes ?? 0) / Number(lastJob.totalBytes)) * 100)))
											: Number(lastJob.total) > 0
												? Math.max(0, Math.min(100, Math.round((Number(lastJob.done ?? 0) / Number(lastJob.total)) * 100)))
												: null
								};
					return { action, ok: true, message: renderStatus(lines), components: rows, job: jobOut };
				}

				if (action === "verify") {
					if (manifest === null) {
						return { action, ok: false, message: `manifest missing: ${manifestError}`, components: [] };
					}
					const components = args?.component ? [String(args.component)] : COMPONENTS;
					const lines = [];
					for (const component of components) {
						for (const entry of entriesOf(manifest, component, pack, layout, config)) {
							const extracted = entry.checkPaths ?? (entry.checkPath === null ? null : [entry.checkPath]);
							if (extracted !== null && extracted.length > 0) {
								const absent = extracted.filter((checkPath) => !existsSync(checkPath));
								if (absent.length === 0) {
									lines.push(`OK-EXTRACTED ${entry.label} -> ${extracted.join(", ")}`);
								} else {
									lines.push(`MISSING-EXTRACTED ${entry.label} -> ${absent.join(", ")}`);
								}
								continue;
							}
							if (!existsSync(entry.dest)) {
								lines.push(`MISSING ${entry.label} -> ${entry.dest}`);
								continue;
							}
							const size = statSync(entry.dest).size;
							if (entry.sizeBytes !== null && size !== entry.sizeBytes) {
								lines.push(`SIZE-MISMATCH ${entry.label}: ${size} != ${entry.sizeBytes}`);
								continue;
							}
							if (entry.sha256 !== null) {
								const actual = await fileSha256(entry.dest);
								lines.push(
									actual.toLowerCase() === String(entry.sha256).toLowerCase()
										? `OK ${entry.label}`
										: `SHA-MISMATCH ${entry.label}: ${actual}`
								);
							} else {
								lines.push(`OK-SIZE-ONLY ${entry.label} (no sha256 in manifest)`);
							}
						}
					}
					if (lines.length === 0) lines.push("清单里没有该组件的文件条目（manifest 未登记）。");
					return { action, ok: true, message: lines.join("\n"), components: [] };
				}

				if (action === "clean") {
					const cleaned = [];
					for (const entry of COMPONENTS.flatMap((c) => entriesOf(manifest, c, undefined, layout, config))) {
						const partial = entry.dest + ".partial";
						if (existsSync(partial)) {
							rmSync(partial, { force: true });
							cleaned.push(partial);
						}
					}
					const staging = path.join(layout.installRoot, ".staging");
					if (existsSync(staging)) {
						assertWithin(layout.installRoot, staging);
						rmSync(staging, { recursive: true, force: true });
						cleaned.push(staging);
					}
					return {
						action,
						ok: true,
						message: cleaned.length ? `removed: ${cleaned.join(", ")}` : "nothing to clean",
						components: []
					};
				}

				if (action === "delete") {
					const component = args?.component === undefined ? null : String(args.component);
					if (component === null || !COMPONENTS.includes(component)) {
						return { action, ok: false, message: "delete requires component: engine | models | upscale", components: [] };
					}
					if (String(args?.confirm ?? "") !== component) {
						return {
							action,
							ok: false,
							message: `delete refused: confirm must equal "${component}" (this removes files on disk)`,
							components: []
						};
					}
					// 按包删除（仅 models）：pack 之间是叠加关系，装错一个 12G 包不该逼用户全删。
					// 规则：只删「该包独有」的文件；与其他**已安装**包共用的文件保留（删了会连带坏掉那些包）。
					const packArg = args?.pack === undefined ? "" : String(args.pack).trim();
					if (packArg !== "" && args?.backup === undefined) {
						if (component !== "models") {
							return {
								action,
								ok: false,
								message: `delete pack=<name> only applies to component=models; ${component} has a single pack`,
								components: []
							};
						}
						const target = resolvePack(manifest, component, packArg);
						if (target === null) {
							const available = Object.keys(manifest?.components?.models?.packs ?? {}).join(" | ");
							return {
								action,
								ok: false,
								message: `models: unknown pack "${packArg}"; available: ${available}`,
								components: []
							};
						}
						if (readJob()?.state === "running") {
							return { action, ok: false, message: "delete refused: a download/upgrade job is running", components: [] };
						}
						const targetEntries = entriesOf(manifest, component, packArg, layout, config);
						// 其他包里出现过的同一路径 → 可能仍被需要
						const otherPacks = Object.keys(manifest?.components?.models?.packs ?? {}).filter((name) => name !== packArg);
						const sharedWith = new Map();
						for (const name of otherPacks) {
							for (const entry of entriesOf(manifest, component, name, layout, config)) {
								if (!sharedWith.has(entry.dest)) sharedWith.set(entry.dest, []);
								sharedWith.get(entry.dest).push(name);
							}
						}
						// 只有「完整安装」的其他包才算仍在使用（缺文件的包本来就要重下）
						const installedOther = new Set(
							otherPacks.filter((name) => {
								const list = entriesOf(manifest, component, name, layout, config);
								return list.length > 0 && list.every((entry) => entryPresent(entry));
							})
						);
						const removed = [];
						const kept = [];
						for (const entry of targetEntries) {
							if (!entryPresent(entry)) continue;
							const users = (sharedWith.get(entry.dest) ?? []).filter((name) => installedOther.has(name));
							if (users.length > 0) {
								kept.push({ entry, users });
								continue;
							}
							const size = (() => {
								try {
									return statSync(entry.dest).size;
								} catch {
									return 0;
								}
							})();
							rmSync(entry.dest, { force: true });
							removed.push({ entry, size });
						}
						if (removed.length === 0 && kept.length === 0) {
							return { action, ok: true, message: `models/${packArg}: nothing installed, nothing to delete`, components: [] };
						}
						// 更新 state：删掉的正好是记录在案的包时，改记第一个仍完整的包（没有就清掉）
						const state = readState();
						const installedState = { ...(state.installed ?? {}) };
						const stillInstalled = otherPacks.filter((name) => {
							const list = entriesOf(manifest, component, name, layout, config);
							return list.length > 0 && list.every((entry) => entryPresent(entry));
						});
						if (state.installed?.models?.pack === packArg || stillInstalled.length === 0) {
							if (stillInstalled.length === 0) delete installedState.models;
							else installedState.models = { ...installedState.models, pack: stillInstalled[0], at: new Date().toISOString() };
						}
						writeState({ installed: installedState, lastAction: "delete-pack" });
						const freedBytes = removed.reduce((sum, item) => sum + item.size, 0);
						const lines = [
							`models/${packArg}: removed ${removed.length} file(s), ${human(freedBytes)}` +
								(removed.length > 0 ? `\n  ${removed.map((item) => item.entry.label).join("\n  ")}` : "")
						];
						if (kept.length > 0) {
							lines.push(
								`kept ${kept.length} file(s) shared with installed packs ` +
									[...new Set(kept.flatMap((item) => item.users))].join("/") +
									` (still needed; delete those packs first to remove them):\n  ` +
									kept.map((item) => item.entry.label).join("\n  ")
							);
						}
						if (stillInstalled.length > 0) lines.push(`models still installed: ${stillInstalled.join(", ")}`);
						writeJob({ action, component, state: "done", at: new Date().toISOString() });
						return { action, ok: true, message: lines.join("\n"), components: [] };
					}

					const backupId = args?.backup === undefined ? "" : String(args.backup).trim();
					if (backupId !== "") {
						try {
							const removed = removeBackup(layout, component, backupId);
							return {
								action,
								ok: true,
								message: `${component}: removed backup ${backupId} (${human(removed.bytes)}, ${removed.files} files)`,
								components: []
							};
						} catch (error) {
							return { action, ok: false, message: `${component}: ${error?.message ?? error}`, components: [] };
						}
					}
					const root = componentRoot(layout, component);
					assertManagedRoot(layout, root);
					if (!existsSync(root)) return { action, ok: true, message: `${component}: already absent (${root})`, components: [] };
					let link = false;
					try {
						link = lstatSync(root).isSymbolicLink();
					} catch {
						link = false;
					}
					if (link) {
						return {
							action,
							ok: false,
							message: `${component}: ${root} is a junction/symlink; refusing to delete the link. Manage its target explicitly.`,
							components: []
						};
					}
					const { bytes, files } = dirSize(root);
					rmSync(root, { recursive: true, force: true });
					writeJob({ action, component, state: "done", at: new Date().toISOString() });
					const backupCount = listBackups(layout, component).length;
					return {
						action,
						ok: true,
						message:
							`${component}: removed ${root} (${human(bytes)}, ${files} files)` +
							(backupCount > 0 ? `; ${backupCount} old-version backup(s) kept — delete with backup=<id>` : ""),
						components: []
					};
				}

				if (action === "install" || action === "upgrade") {
					if (manifest === null) {
						return { action, ok: false, message: `manifest missing: ${manifestError}`, components: [] };
					}
					const components = args?.component ? [String(args.component)] : COMPONENTS;
					const lines = [];
					const keep = Math.max(0, Math.min(2, Number(config?.keepVersions ?? 1) || 0));
					let changed = false;
					for (const component of components) {
						if (!COMPONENTS.includes(component)) {
							lines.push(`skip unknown component ${component}`);
							continue;
						}
						// models 是多包叠加（8G/12G/32G 各不同）：不带 pack 时不再「默默取第一个包」
						// ——那等于给 8G 显卡塞 12G 的 core，下错 8.7GB 还得再删。
						if (pack === undefined) {
							const names = Object.keys(manifest?.components?.[component]?.packs ?? {});
							if (names.length > 1) {
								const catalog = packSummaries(manifest, component, layout, config)
									.map((row) => `${row.name}（${row.vram ?? "?"} 显存，${human(row.expectedBytes)}）`)
									.join(" / ");
								return {
									action,
									ok: false,
									message: `${component} requires pack=<name>; available: ${catalog}`,
									components: []
								};
							}
						}
						const entries = entriesOf(manifest, component, pack, layout, config);
						if (entries.length === 0) {
							lines.push(`${component}: no manifest entries (register them in models.manifest.json)`);
							continue;
						}
						const root = componentRoot(layout, component);
						const status = componentStatus(manifest, component, pack, layout, config, readState());
						if (action === "upgrade") {
							if (!status.installed) {
								lines.push(`${component}: not installed; installing${status.targetVersion ? ` v${status.targetVersion}` : ""}`);
							} else if (
								status.targetVersion !== null &&
								status.installedVersion !== null &&
								sameVersion(status.installedVersion, status.targetVersion) &&
								status.missing === 0
							) {
								// 用磁盘探测到的版本判断「已是目标版本」，不再只信 state 里的陈旧记录
								lines.push(`${component}: already at v${status.targetVersion}; nothing to upgrade`);
								continue;
							} else if (status.targetVersion === null && status.missing === 0) {
								lines.push(`${component}: installed but manifest has no version; use install to repair, upgrade skipped`);
								continue;
							} else {
								let link = false;
								try {
									link = lstatSync(root).isSymbolicLink();
								} catch {
									link = false;
								}
								if (link) {
									return {
										action,
										ok: false,
										message: `${component}: ${root} is a junction/symlink; refusing to upgrade in place. Point the setting at the real directory.`,
										components: []
									};
								}
							}
						}
						// 旧版本备份：引擎整目录、放大引擎按已解压目录、模型只备份将被替换的单个文件。
						// 模型同尺寸时还要比 sha256，否则“同路径同大小、内容已更新”的新版本会被跳过。
						const replaceTargets = new Set();
						if (action === "upgrade" && status.installed) {
							if (component === "engine") {
								replaceTargets.add(root);
							} else if (component === "upscale") {
								for (const entry of entries) {
									if (entry.checkPath === null) continue;
									const first = path.relative(root, entry.checkPath).split(path.sep)[0];
									if (first && first !== ".." && !path.isAbsolute(first)) replaceTargets.add(path.join(root, first));
								}
							} else {
								for (const entry of entries) {
									if (!existsSync(entry.dest)) continue;
									if (entry.sizeBytes === null) {
										replaceTargets.add(entry.dest);
										continue;
									}
									if (statSync(entry.dest).size !== entry.sizeBytes) {
										replaceTargets.add(entry.dest);
										continue;
									}
									if (entry.sha256 !== null) {
										const actual = await fileSha256(entry.dest);
										if (actual.toLowerCase() !== String(entry.sha256).toLowerCase()) replaceTargets.add(entry.dest);
									}
								}
							}
						}
						// 引擎升级前必须先停引擎：
						//  1) 备份是同盘 rename，目录里有运行中的 python.exe 会 EBUSY —— 旧代码在这里直接失败；
						//  2) 就算 rename 侥幸成功，解压新版本时旧进程还占着 python_embeded 里的文件，
						//     换完不重启就成了「磁盘新版本 / 运行中旧版本」的错乱状态。
						// 停/起都复用 comfy 工具的 control 实现，不在这里复制一套进程管理。
						let engineWasRunning = false;
						let engineProfile = "normal";
						let restartEngine = null;
						let gatewayStopped = false;
						if (action === "upgrade" && component === "engine") {
							// 先停网关：它用引擎目录里的 python.exe 跑，不停就 rename 不了（EPERM），
							// 而且换完 python_embeded 它的依赖也没了。
							gatewayStopped = await stopGatewayForUpgrade(layout, config, lines);
							const engineBaseUrl = text(config?.comfyBaseUrl);
							engineWasRunning = await engineHttpUp(engineBaseUrl);
							if (engineWasRunning) {
								const runtime = readJson(engineRuntimeStateFile(layout), null);
								if (typeof runtime?.profile === "string" && runtime.profile !== "") engineProfile = runtime.profile;
								const comfy = comfyToolOf(ctx);
								if (comfy === null) {
									return {
										action,
										ok: false,
										message:
											`${component}: the shared engine is responding at ${engineBaseUrl} but the comfy tool is not registered; ` +
											"stop the engine first (comfy action=control op=stop), then retry the upgrade",
										components: []
									};
								}
								lines.push(`engine running at ${engineBaseUrl}; stopping it before backup (profile ${engineProfile})`);
								await comfy.execute({ action: "control", op: "stop" }, { signal });
								restartEngine = async (reason) => {
									try {
										await comfy.execute({ action: "control", op: "start", profile: engineProfile }, { signal });
										lines.push(`engine restarted (${reason})`);
									} catch (error) {
										lines.push(
											`WARN engine restart after ${reason} failed: ${error?.message ?? error} — start it with comfy action=control op=start`
										);
									}
								};
							}
						}
						let backup = null;
						// 整目录替换前先把用户数据挪进临时区（自定义节点 / 模型注册表 / 工作流库），
						// 解压完再放回去；否则「升级成功」等于把用户能出图的环境换回了出厂空壳。
						let stagedEngineData = [];
						if (action === "upgrade" && component === "engine" && status.installed) {
							try {
								stagedEngineData = stageEngineUserData(layout);
							} catch (error) {
								if (restartEngine !== null) await restartEngine("upgrade aborted");
								return {
									action,
									ok: false,
									message:
										`${component}: cannot preserve user data (custom nodes / model registry) — nothing changed: ` +
										`${error?.message ?? error}`,
									components: []
								};
							}
							if (stagedEngineData.length > 0) {
								lines.push(`preserving engine user data: ${stagedEngineData.map((item) => item.rel).join(", ")}`);
							}
						}
						if (action === "upgrade" && status.installed && replaceTargets.size > 0) {
							try {
								backup = backupTargets(layout, component, [...replaceTargets], {
									version: status.installedVersion ?? status.targetVersion,
									pack: status.pack,
									kind: component === "models" ? "files" : "directory"
								});
							} catch (error) {
								// 备份没成功：先把已挪走的用户数据放回去，再报「什么都没改」
								if (stagedEngineData.length > 0) {
									try {
										restoreEngineUserData(stagedEngineData);
										cleanupEngineStaging(stagedEngineData);
									} catch {
										/* 放回失败时保留临时区，错误信息里会带路径 */
									}
									stagedEngineData = [];
								}
								if (restartEngine !== null) await restartEngine("upgrade aborted");
								return {
									action,
									ok: false,
									message: `${component}: backup failed, nothing changed — ${error?.message ?? error}`,
									components: []
								};
							}
							if (backup !== null) {
								lines.push(
									`backup ${component} v${backup.version ?? "?"} -> ${backup.dir} (${human(backup.bytes)}, ${backup.files} files)`
								);
							}
						}
						// 进度：字节级（下载器回调）+ 文件级，供设置页画进度条。
						// job.json 每秒最多写一次（下载回调可能每秒上百次），避免写盘拖慢下载。
						const totalBytes = entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
						const startedAt = new Date().toISOString();
						let finishedBytes = 0;
						let lastFlush = 0;
						let done = 0;
						const writeProgress = (current, extra = {}) => {
							const now = Date.now();
							if (now - lastFlush < 800 && extra.state === undefined) return;
							lastFlush = now;
							// ⚠️ 只有「当前文件已写字节」来自 extra，累计值必须在 spread 之后覆盖回去：
							// 之前写成 { ...writtenBytes, ...extra }，换文件时 extra.writtenBytes=0 会把
							// 已完成的字节数抹成 0 → 进度条每下完一个文件就回到起点（4 个文件时走到 1/4 又重来）。
							const { writtenBytes: currentFileBytes, ...rest } = extra;
							writeJob({
								action,
								component,
								pack: status.pack ?? null,
								state: "running",
								done: Math.min(done, entries.length),
								total: entries.length,
								fileIndex: Math.min(done + 1, entries.length),
								fileLabel: current?.label ?? null,
								totalBytes,
								startedAt,
								at: new Date().toISOString(),
								...rest,
								writtenBytes: finishedBytes + (currentFileBytes ?? 0)
							});
						};
						writeProgress(null, { state: "running", writtenBytes: 0, done: 0 });
						try {
							for (const entry of entries) {
								if (entry.url === null) {
									lines.push(`${component}/${entry.label}: no download URL for source "${config?.modelSource ?? "huggingface"}" (set modelPackBaseUrl or another source)`);
									continue;
								}
								let force = false;
								if (action === "upgrade") {
									if (component === "engine" || component === "upscale") force = true;
									else force = replaceTargets.has(entry.dest);
								}
								const res = await downloadTo(entry.url, entry.dest, {
									sizeBytes: entry.sizeBytes,
									sha256: entry.sha256,
									signal,
									force,
									proxyBase: text(config?.githubProxy),
									connections: Number(config?.downloadConnections ?? 4),
									onProgress: (p) => writeProgress(entry, { writtenBytes: p.written ?? 0 })
								});
								finishedBytes += res.skipped ? 0 : (res.bytes ?? entry.sizeBytes ?? 0);
								done += 1;
								writeProgress(entry, { state: "running", writtenBytes: 0 });
								lines.push(`${res.skipped ? "skip" : "ok"} ${component}/${entry.label} -> ${entry.dest}${res.skipped ? ` (${res.reason})` : ""}`);
								if (entry.extractTo !== null) {
									await extractArchive(entry.dest, entry.extractTo, entry.extractRename, entry);
									lines.push(`extract ${component}/${entry.label} -> ${entry.extractTo}`);
								}
							}
							// 整包替换把 python_embeded 也换了：先把网关依赖补装进新环境，
							// 再放回用户数据（补装失败会抛错 → 回滚，用户数据还在临时区）。
							if (component === "engine") await reinstallGatewayDeps(layout, lines);
							// 解压完把用户数据放回新引擎目录（自定义节点 / 模型注册表 / 工作流库）
							// 注意：stagedEngineData 保留到整个升级成功后再清临时区——回滚时还要用它把数据挪回去
							if (stagedEngineData.length > 0) {
								restoreEngineUserData(stagedEngineData);
								lines.push(`restored engine user data: ${stagedEngineData.map((item) => item.rel).join(", ")}`);
							}
							const installed = { ...(readState().installed ?? {}) };
							const engineVersionAfter = component === "engine" ? readEngineVersion(layout) : null;
							// 解压完必须核对磁盘版本：清单 sha256 对得上但内容版本不符（镜像给错包 /
							// 归档内层目录结构变了）时，不能默默记成目标版本。
							if (
								component === "engine" &&
								engineVersionAfter !== null &&
								status.targetVersion !== null &&
								!sameVersion(engineVersionAfter, status.targetVersion)
							) {
								lines.push(
									`WARN engine on disk reports v${engineVersionAfter} but manifest expects v${status.targetVersion}; keeping the backup at ${backup?.dir ?? "(none)"}`
								);
							}
							installed[component] = {
								version: status.targetVersion,
								engineVersion: component === "engine" ? readEngineVersion(layout) : undefined,
								pack: status.pack ?? null,
								at: new Date().toISOString()
							};
							writeState({ installed, lastInstallAt: new Date().toISOString(), lastAction: action });
							changed = true;
							// 换完文件再重启：运行中的进程仍是旧版本，不重启等于升级没生效
							if (restartEngine !== null) await restartEngine("upgrade finished");
							if (stagedEngineData.length > 0) cleanupEngineStaging(stagedEngineData);
							if (gatewayStopped) {
								lines.push("image gateway was stopped for the swap; it restarts automatically on the next generation");
							}
							if (backup !== null) {
								const pruned = pruneBackups(layout, component, keep);
								lines.push(
									`kept backup ${component}/${backup.id}; keepVersions=${keep}` +
										(pruned.length ? `, pruned ${pruned.length} older backup(s)` : "")
								);
							}
							writeJob({
								action,
								component,
								pack: status.pack ?? null,
								state: "done",
								done,
								total: entries.length,
								fileIndex: entries.length,
								writtenBytes: totalBytes,
								totalBytes,
								startedAt,
								finishedAt: new Date().toISOString(),
								at: new Date().toISOString()
							});
						} catch (error) {
							let rollbackNote = "";
							// 先把放回新目录的用户数据再收进临时区，避免回滚删新目录时一起删掉
							if (stagedEngineData.length > 0) {
								try {
									stashEngineUserDataForRollback(stagedEngineData);
								} catch (stashError) {
									rollbackNote += `; user data re-stash failed: ${stashError?.message ?? stashError}`;
								}
							}
							if (backup !== null) {
								try {
									restoreBackup(layout, backup);
									rollbackNote = "; rolled back to the previous version";
								} catch (restoreError) {
									rollbackNote = `; ROLLBACK FAILED: ${restoreError?.message ?? restoreError} (backup kept at ${backup.dir})`;
								}
							}
							// 回滚后同样要把临时保管的用户数据放回（引擎目录已恢复，路径又存在了）
							if (stagedEngineData.length > 0) {
								try {
									restoreEngineUserData(stagedEngineData.filter((item) => !item.restored));
									cleanupEngineStaging(stagedEngineData);
									rollbackNote += "; engine user data restored";
								} catch (restoreError) {
									rollbackNote +=
										`; USER DATA RESTORE FAILED: ${restoreError?.message ?? restoreError} ` +
										`(staging: ${stagedEngineData[0]?.staging ?? "?"})`;
								}
								stagedEngineData = [];
							}
							writeJob({ action, component, state: "failed", message: String(error?.message ?? error), at: new Date().toISOString() });
							lines.push(`FAIL ${component}: ${error?.message ?? error}${rollbackNote}`);
							// 升级失败也要把引擎拉回来：否则用户看到的是「升级失败 + 引擎悄悄停了」
							if (restartEngine !== null) await restartEngine("upgrade failed");
							throw new Error(lines.join("\n"));
						}
					}
					if (changed) writeState({ lastInstallAt: new Date().toISOString() });
					return { action, ok: true, message: lines.join("\n") || "nothing to do", components: [] };
				}

				throw new Error(`unknown action: ${action}`);
			}
		})
	);
}
