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
 * 本模块不拥有 ComfyUI 进程，也不改用户的 extra_model_paths.yaml 之外的文件。
 */
import { createHash } from "node:crypto";
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
import { defaultAssetPaths as defaultPaths } from "./paths.js";

const MANIFEST_FILE = "models.manifest.json";
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

/**
 * 组件版本视图：
 *  - targetVersion：清单当前登记的版本（升级目标）
 *  - installedVersion：已安装版本（state 记录 / 引擎版本文件 / 清单探测）
 *  - updateAvailable：已安装且记录版本与清单不同，或有清单文件缺失
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
	const updateAvailable =
		installed &&
		(recorded !== null
			? targetVersion !== null && recorded.version !== targetVersion
			: missingCount > 0);
	return { targetVersion, installedVersion, versionSource, installed, updateAvailable };
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
	const order = [preferred, "sourceforge", "huggingface", "hf-mirror", "modelscope", "official"];
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
 * 下载单个文件到 dest，支持断点续传。
 * 返回 { downloaded, skipped, reason }；不抛网络错误以外的异常给调用方处理。
 */
export async function downloadTo(url, dest, { sizeBytes = null, sha256 = null, onProgress = null, signal = null, force = false } = {}) {
	mkdirSync(path.dirname(dest), { recursive: true });
	const partial = dest + ".partial";
	let start = 0;
	// force：升级时旧文件已进备份，无视已有目标重新拉取；.partial 仍可续传。
	if (force) rmSync(dest, { force: true });
	if (existsSync(partial)) start = statSync(partial).size;
	if (!force && existsSync(dest)) {
		const have = statSync(dest).size;
		if (sizeBytes !== null && have === sizeBytes) return { skipped: true, reason: "already downloaded (size matches)" };
		// 归档条目通常没有上游字节数；存在即视为已下载，解压步骤会再校验 checkPath。
		if (sizeBytes === null && sha256 === null) return { skipped: true, reason: "already downloaded (archive)" };
	}
	const headers = {};
	if (start > 0) headers.Range = `bytes=${start}-`;
	let res = await fetch(url, { headers, signal: signal ?? undefined, redirect: "follow" });
	// GitHub releases/download 不通时（限速/区域阻断/需鉴权）回退到官方 Releases API 直链。
	if (!res.ok && res.status !== 206 && GITHUB_RELEASE_RE.test(String(url))) {
		let fallback = null;
		try {
			fallback = await resolveGithubAsset(url, signal);
		} catch {
			fallback = null;
		}
		if (fallback !== null) {
			if (sizeBytes === null && fallback.sizeBytes !== null) sizeBytes = fallback.sizeBytes;
			res = await fetch(fallback.url, { headers: { ...fallback.headers, ...headers }, signal: signal ?? undefined, redirect: "follow" });
		}
	}
	if (!res.ok && res.status !== 206) {
		throw new Error(`download failed: HTTP ${res.status} for ${url}`);
	}
	// 服务器不支持 Range（返回 200 而非 206）时从头写，避免拼接出坏文件
	if (start > 0 && res.status === 200) {
		start = 0;
		rmSync(partial, { force: true });
	}
	const total = sizeBytes ?? (res.headers.get("content-length") ? start + Number(res.headers.get("content-length")) : null);
	let written = start;
	const sink = createWriteStream(partial, { flags: start > 0 ? "a" : "w" });
	await pipeline(
		Readable.fromWeb(res.body),
		async function* (source) {
			for await (const chunk of source) {
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
			throw new Error(`sha256 mismatch: got ${actual}, expected ${sha256} (partial removed)`);
		}
	}
	renameSync(partial, dest);
	return { skipped: false, bytes: written };
}

/** 找 7z：环境变量 > 常见安装路径 > PATH。 */
function find7z() {
	const candidates = [
		process.env.SEVEN_ZIP,
		"C:/Program Files/7-Zip/7z.exe",
		"C:/Program Files (x86)/7-Zip/7z.exe"
	].filter((value) => typeof value === "string" && value !== "");
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return "7z.exe";
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
	const sevenZip = find7z();
	const globs = entry.extractGlobs ?? [];
	const moves = entry.extractMove ?? [];
	if (globs.length > 0 || moves.length > 0) {
		const staging = path.join(extractDir, `.staging-${process.pid}-${Date.now()}`);
		mkdirSync(extractDir, { recursive: true });
		mkdirSync(staging, { recursive: true });
		try {
			await runProcess(sevenZip, ["x", archive, `-o${staging}`, "-y", "-bd", ...globs]);
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
	await runProcess(sevenZip, ["x", archive, `-o${extractDir}`, "-y", "-bd"]);
	if (renameSpec !== null && renameSpec !== undefined) {
		const from = path.join(extractDir, String(renameSpec.from));
		const to = path.join(extractDir, String(renameSpec.to));
		if (existsSync(from)) {
			if (existsSync(to)) throw new Error(`extract target already exists: ${to}`);
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
			if (installed[row.component] !== undefined) continue;
			installed[row.component] = {
				version: row.targetVersion,
				engineVersion: row.component === "engine" ? readEngineVersion(layout) : undefined,
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
			description: "Install and manage the engine, models and upscale packs.",
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
				pack: { type: "string", description: "models/upscale: pack name; models defaults to Config.modelPack (core/fast/lowvram/lowvram-fast/full)." },
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
			timeoutMs: 60000,
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
						const updateText = row.updateAvailable ? ` -> v${row.targetVersion}` : "";
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
						`outputDir: ${layout.outputDir ?? "(from Config.outputDir)"}`,
						"Downloads are explicit: run image_setup action=install component=models pack=core (needs network); " +
							"upgrade keeps a backup and auto-rolls back on failure; delete needs confirm=<component>; " +
							"delete backup=<id> removes an old version."
					);
					return { action, ok: true, message: renderStatus(lines), components: rows };
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
						const entries = entriesOf(manifest, component, pack, layout, config);
						if (entries.length === 0) {
							lines.push(`${component}: no manifest entries (register them in models.manifest.json)`);
							continue;
						}
						const root = componentRoot(layout, component);
						const status = componentStatus(manifest, component, pack, layout, config, readState());
						const recorded = readState().installed?.[component] ?? null;
						if (action === "upgrade") {
							if (!status.installed) {
								lines.push(`${component}: not installed; installing${status.targetVersion ? ` v${status.targetVersion}` : ""}`);
							} else if (status.targetVersion !== null && recorded?.version === status.targetVersion && status.missing === 0) {
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
						let backup = null;
						if (action === "upgrade" && status.installed && replaceTargets.size > 0) {
							try {
								backup = backupTargets(layout, component, [...replaceTargets], {
									version: status.installedVersion ?? status.targetVersion,
									pack: status.pack,
									kind: component === "models" ? "files" : "directory"
								});
							} catch (error) {
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
						writeJob({ action, component, state: "running", total: entries.length, done: 0, at: new Date().toISOString() });
						let done = 0;
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
									force
								});
								done += 1;
								writeJob({ action, component, state: "running", total: entries.length, done, at: new Date().toISOString() });
								lines.push(`${res.skipped ? "skip" : "ok"} ${component}/${entry.label} -> ${entry.dest}${res.skipped ? ` (${res.reason})` : ""}`);
								if (entry.extractTo !== null) {
									await extractArchive(entry.dest, entry.extractTo, entry.extractRename, entry);
									lines.push(`extract ${component}/${entry.label} -> ${entry.extractTo}`);
								}
							}
							const installed = { ...(readState().installed ?? {}) };
							installed[component] = {
								version: status.targetVersion,
								engineVersion: component === "engine" ? readEngineVersion(layout) : undefined,
								pack: status.pack ?? null,
								at: new Date().toISOString()
							};
							writeState({ installed, lastInstallAt: new Date().toISOString(), lastAction: action });
							changed = true;
							if (backup !== null) {
								const pruned = pruneBackups(layout, component, keep);
								lines.push(
									`kept backup ${component}/${backup.id}; keepVersions=${keep}` +
										(pruned.length ? `, pruned ${pruned.length} older backup(s)` : "")
								);
							}
							writeJob({ action, component, state: "done", total: entries.length, done, at: new Date().toISOString() });
						} catch (error) {
							let rollbackNote = "";
							if (backup !== null) {
								try {
									restoreBackup(layout, backup);
									rollbackNote = "; rolled back to the previous version";
								} catch (restoreError) {
									rollbackNote = `; ROLLBACK FAILED: ${restoreError?.message ?? restoreError} (backup kept at ${backup.dir})`;
								}
							}
							writeJob({ action, component, state: "failed", message: String(error?.message ?? error), at: new Date().toISOString() });
							lines.push(`FAIL ${component}: ${error?.message ?? error}${rollbackNote}`);
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
