/**
 * lib/paths.js —— 默认路径的唯一来源
 * =================================
 * 目标：让「默认装在哪」只在**一个地方**决定，且不再把某个盘符写死在多处代码/提示里。
 *
 * 优先级：
 *   1. 环境变量 IMAGEKIT_INSTALL_ROOT —— 显式指定装在哪
 *   2. 旧版默认目录（D:/AI/Tools/ImageKit 或 C:/AI/Tools/ImageKit）存在时沿用
 *   3. 否则用当前用户数据目录：Windows `%LOCALAPPDATA%\\dsh-imagekit`，其余平台 `$XDG_DATA_HOME/dsh-imagekit`
 *   4. 其余全部由 installRoot 派生：engine / models / upscale-engines / outputs / gateway
 *
 * 引擎目录（engine）特殊：用户机器上往往**已经有一份 ComfyUI**（5 GB 上下），
 * 再下一份 1.9 GB 的便携引擎纯属浪费。按「IMAGEKIT_ENGINE_DIR → 默认根已就位 →
 * 探测到的既有安装 → 默认根（作为安装目标）」解析；探测只做有界扫描，不遍历全盘。
 *
 * 网关目录（gateway）特殊：它是本插件之外的独立服务，位置因人而异。按
 * 「环境变量 IMAGEKIT_GATEWAY_DIR → $DSH_HOME/imagekit/local.json 的 gatewayDir →
 *  <installRoot>/gateway」的顺序解析；代码里不写任何具体路径。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
/** 本机私有配置（不进版本库）：{ gatewayDir?: string } */
const LOCAL_CONFIG_FILE = path.join(DSH_HOME, "imagekit", "local.json");

/** 读本机私有配置；损坏/缺失一律忽略，绝不因此中断。 */
function readLocalConfig() {
	try {
		const raw = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

/**
 * 新默认根：放在当前用户的数据目录，不再猜盘符、也不出现「作者机器」的味道。
 * Windows `%LOCALAPPDATA%\\dsh-imagekit`，其余平台 `$XDG_DATA_HOME/dsh-imagekit`。
 */
function userDataRoot() {
	if (isWindows) {
		const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
		return path.join(base, "dsh-imagekit");
	}
	return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "dsh-imagekit");
}

/** 旧默认根（0.0.2 及之前）：已经装过的机器继续用它，避免升级后模型“消失”。 */
function legacyRoot() {
	const candidates = isWindows
		? ["D:/AI/Tools/ImageKit", "C:/AI/Tools/ImageKit"]
		: [path.join(os.homedir(), "AI", "Tools", "ImageKit")];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 工具分类根来源：env / legacy / default，便于设置页说明“为什么是这个路径”。 */
export const INSTALL_ROOT_SOURCE = process.env.IMAGEKIT_INSTALL_ROOT
	? "env"
	: legacyRoot() !== null
		? "legacy"
		: "default";

/** 工具分类根：`IMAGEKIT_INSTALL_ROOT` 可整体覆盖；旧路径存在时继续沿用。 */
export const INSTALL_ROOT =
	process.env.IMAGEKIT_INSTALL_ROOT || legacyRoot() || userDataRoot();

/* ------------------------------------------------------------------ */
/* 既有 ComfyUI 探测（不下载就能用上用户本机已有的那份）                  */
/* ------------------------------------------------------------------ */

/** ComfyUI 便携版：自带 python_embeded 与 ComfyUI/main.py，插件可直接启动。 */
function isPortableComfyUi(dir) {
	return existsSync(path.join(dir, "python_embeded", "python.exe")) && existsSync(path.join(dir, "ComfyUI", "main.py"));
}

/** 任意 ComfyUI 树（源码/venv/git clone）：只有 ComfyUI/main.py，引擎需用户自己起。 */
function isComfyUiTree(dir) {
	return existsSync(path.join(dir, "ComfyUI", "main.py"));
}

/** 本机固定盘符（不调 wmic/powershell：26 次 stat 比起进程便宜，也不阻塞事件循环）。 */
function windowsDriveRoots() {
	if (!isWindows) return [];
	const roots = [];
	for (let code = 0x41; code <= 0x5a; code += 1) {
		const root = `${String.fromCharCode(code)}:/`;
		try {
			if (existsSync(root)) roots.push(root);
		} catch {
			/* 无权限/不可用盘符：跳过 */
		}
	}
	return roots;
}

/** 有界候选：环境变量、installRoot 内、家目录/桌面/下载、各盘根与 AI/Tools 下的一层。 */
function comfyUiCandidates() {
	const home = os.homedir();
	const dirs = [
		process.env.IMAGEKIT_ENGINE_DIR,
		process.env.COMFYUI_DIR,
		process.env.COMFYUI_PATH,
		path.join(INSTALL_ROOT, "engine", "ComfyUI_windows_portable"),
		path.join(INSTALL_ROOT, "engine", "ComfyUI"),
		path.join(home, "ComfyUI_windows_portable"),
		path.join(home, "ComfyUI"),
		path.join(home, "Desktop", "ComfyUI_windows_portable"),
		path.join(home, "Downloads", "ComfyUI_windows_portable"),
		path.join(home, "Documents", "ComfyUI_windows_portable"),
		path.join(home, "AI", "ComfyUI_windows_portable"),
		path.join(home, "AI", "ComfyUI")
	];
	for (const root of windowsDriveRoots()) {
		dirs.push(
			path.join(root, "ComfyUI_windows_portable"),
			path.join(root, "ComfyUI"),
			path.join(root, "AI", "ComfyUI_windows_portable"),
			path.join(root, "AI", "Tools", "ComfyUI_windows_portable")
		);
	}
	return dirs.filter((dir) => typeof dir === "string" && dir !== "");
}

/** 去重（Windows 大小写不敏感）并按「便携版优先」排序；只返回真实存在的。 */
let detectedCache;
export function detectComfyUiInstalls() {
	if (detectedCache !== undefined) return detectedCache;
	const seen = new Set();
	const found = [];
	for (const dir of comfyUiCandidates()) {
		const resolved = path.resolve(dir);
		const key = isWindows ? resolved.toLowerCase() : resolved;
		if (seen.has(key)) continue;
		seen.add(key);
		let portable = false;
		let tree = false;
		try {
			portable = isPortableComfyUi(resolved);
			tree = portable || isComfyUiTree(resolved);
		} catch {
			continue;
		}
		if (!tree) continue;
		found.push({ path: resolved, kind: portable ? "portable" : "source" });
	}
	found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "portable" ? -1 : 1));
	detectedCache = found;
	return found;
}

/** 默认引擎位置（也是 image_setup 的安装目标）。 */
export const DEFAULT_ENGINE_ROOT = `${INSTALL_ROOT}/engine/ComfyUI_windows_portable`;

/**
 * 引擎根解析：显式环境变量 > 默认位置已就位 > 探测到的便携版 > 默认位置（待安装）。
 * 只在「默认位置没有引擎」时才扫盘，正常安装过引擎的机器不付这个成本。
 */
function resolveEngineRoot() {
	if (process.env.IMAGEKIT_ENGINE_DIR) return { root: process.env.IMAGEKIT_ENGINE_DIR, source: "env" };
	if (isPortableComfyUi(DEFAULT_ENGINE_ROOT)) return { root: DEFAULT_ENGINE_ROOT, source: INSTALL_ROOT_SOURCE };
	const detected = detectComfyUiInstalls().find((item) => item.kind === "portable");
	if (detected) return { root: detected.path, source: "detected" };
	return { root: DEFAULT_ENGINE_ROOT, source: INSTALL_ROOT_SOURCE };
}

const engineRootResolved = resolveEngineRoot();

/** 工具分类根与引擎根的来源：env / legacy / default / detected，便于设置页解释“为什么是这个路径”。 */
export const ENGINE_ROOT = engineRootResolved.root;
export const ENGINE_ROOT_SOURCE = engineRootResolved.source;

/** 由 installRoot 派生的四个目录（均为默认值，可被 Config 覆盖）。 */
export const MODELS_ROOT = `${INSTALL_ROOT}/models`;
export const UPSCALE_ROOT = `${INSTALL_ROOT}/upscale-engines/engines`;
export const OUTPUT_DIR = `${INSTALL_ROOT}/outputs`;

/** ComfyUI 便携版的 python 与日志位置（引擎根派生，不再单独写死）。 */
export const ENGINE_PYTHON = path.join(ENGINE_ROOT, "python_embeded", "python.exe");
export const ENGINE_LOG_DIR = path.join(INSTALL_ROOT, "engine", "logs");
export const ENGINE_START_BAT = path.join(INSTALL_ROOT, "engine", "start_comfyui.bat");

/**
 * 引擎日志候选（按优先级）：插件拉起的进程写前两个；用户自己启动的引擎
 * 只可能在 ComfyUI 自己的 user 目录里留 log，后两个是兜底。
 */
export function engineLogCandidates(engineRoot = ENGINE_ROOT) {
	return [
		path.join(ENGINE_LOG_DIR, "engine.err.log"),
		path.join(ENGINE_LOG_DIR, "engine.log"),
		path.join(engineRoot, "ComfyUI", "user", "comfyui.log"),
		path.join(engineRoot, "user", "comfyui.log")
	];
}

/**
 * DSH 自带 Python 候选：`$DSH_HOME/dsh-runtimes/<runtime>/dependencies/python/python.exe`。
 * 它装好了 Pillow/numpy，像素工具不必要求用户另装一套 Python。目录名字随运行时版本变，
 * 所以逐个探而不是写死。
 */
export function bundledPythonCandidates() {
	const out = [];
	if (process.env.DSH_PYTHON) out.push(process.env.DSH_PYTHON);
	const runtimes = path.join(DSH_HOME, "dsh-runtimes");
	let names = [];
	try {
		names = readdirSync(runtimes);
	} catch {
		names = [];
	}
	for (const name of names) out.push(path.join(runtimes, name, "dependencies", "python", "python.exe"));
	return out.filter((candidate) => existsSync(candidate));
}

/**
 * 网关目录：显式环境变量优先；否则依次探测「新布局」「历史布局」；
 * 两者都不存在时返回新布局（调用方据此给出可执行的修复提示）。
 */
export function resolveGatewayDir() {
	const fromEnv = process.env.IMAGEKIT_GATEWAY_DIR;
	if (fromEnv) return fromEnv;
	const fromLocal = readLocalConfig().gatewayDir;
	if (typeof fromLocal === "string" && fromLocal !== "" && existsSync(fromLocal)) return fromLocal;
	return path.join(INSTALL_ROOT, "gateway");
}

/** 网关日志目录：默认取网关目录的同级 logs。 */
export function resolveGatewayLogDir(gatewayDir = resolveGatewayDir()) {
	return process.env.IMAGEKIT_GATEWAY_LOG_DIR || path.join(path.dirname(gatewayDir), "logs");
}

/** 子进程的 HF 镜像变量：仅在用户显式选择 hf-mirror（或自己设了 HF_ENDPOINT）时注入，
 *  避免把「官方源」的下载偷偷改到第三方镜像。 */
export function hfEndpointEnv(config) {
	const explicit = process.env.HF_ENDPOINT;
	if (typeof explicit === "string" && explicit !== "") return { HF_ENDPOINT: explicit };
	return config?.modelSource === "hf-mirror" ? { HF_ENDPOINT: "https://hf-mirror.com" } : {};
}

/**
 * 建好安装根与四个派生目录。设置页一打开就能看到真实存在的路径，
 * 不用等第一次下载才隐式创建。返回实际创建的目录（已存在的不重复建）。
 */
export function ensureInstallDirs(root = INSTALL_ROOT) {
	const dirs = [root, path.join(root, "engine"), path.join(root, "models"), path.join(root, "upscale-engines"), path.join(root, "outputs"), path.join(root, ".imagekit")];
	const created = [];
	for (const dir of dirs) {
		if (existsSync(dir)) continue;
		mkdirSync(dir, { recursive: true });
		created.push(dir);
	}
	return created;
}

/** 供设置页「恢复默认」与 image_setup defaults 共用的一份快照。 */
export function defaultAssetPaths() {
	return {
		installRoot: INSTALL_ROOT,
		installRootSource: INSTALL_ROOT_SOURCE,
		engineRoot: ENGINE_ROOT,
		engineRootSource: ENGINE_ROOT_SOURCE,
		defaultEngineRoot: DEFAULT_ENGINE_ROOT,
		detectedEngines: detectComfyUiInstalls(),
		modelsRoot: MODELS_ROOT,
		upscaleEnginesRoot: UPSCALE_ROOT,
		outputDir: OUTPUT_DIR,
	};
}
