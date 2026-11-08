/**
 * lib/paths.js —— 默认路径的唯一来源
 * =================================
 * 目标：让「默认装在哪」只在**一个地方**决定，且不再把某个盘符写死在多处代码/提示里。
 *
 * 优先级（前两者任一命中即可改变默认布局）：
 *   1. 环境变量 IMAGEKIT_INSTALL_ROOT —— 显式指定装在哪
 *   2. 有 D 盘用 D 盘，否则用 C 盘（Windows 之外的平台回落到用户主目录）
 *   3. 其余全部由 installRoot 派生：engine / models / upscale-engines / outputs / gateway
 *
 * 网关目录（gateway）特殊：它是本插件之外的独立服务，位置因人而异。按
 * 「环境变量 IMAGEKIT_GATEWAY_DIR → $DSH_HOME/imagekit/local.json 的 gatewayDir →
 *  <installRoot>/gateway」的顺序解析；代码里不写任何具体路径。
 */
import { existsSync, readFileSync } from "node:fs";
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

/** 盘符选择：Windows 上优先非系统盘（D 优先），其余平台用用户主目录。 */
function defaultDriveRoot() {
	if (!isWindows) return path.join(os.homedir(), "AI");
	const drive = ["D:", "C:"].find((d) => existsSync(`${d}/`)) ?? "C:";
	return `${drive}/AI`;
}

/** 工具分类根：`IMAGEKIT_INSTALL_ROOT` 可整体覆盖。 */
export const INSTALL_ROOT =
	process.env.IMAGEKIT_INSTALL_ROOT || `${defaultDriveRoot()}/Tools/ImageKit`;

/** 由 installRoot 派生的四个目录（均为默认值，可被 Config 覆盖）。 */
export const ENGINE_ROOT = `${INSTALL_ROOT}/engine/ComfyUI_windows_portable`;
export const MODELS_ROOT = `${INSTALL_ROOT}/models`;
export const UPSCALE_ROOT = `${INSTALL_ROOT}/upscale-engines/engines`;
export const OUTPUT_DIR = `${INSTALL_ROOT}/outputs`;

/** ComfyUI 便携版的 python 与日志位置（引擎根派生，不再单独写死）。 */
export const ENGINE_PYTHON = path.join(ENGINE_ROOT, "python_embeded", "python.exe");
export const ENGINE_LOG_DIR = path.join(INSTALL_ROOT, "engine", "logs");
export const ENGINE_START_BAT = path.join(INSTALL_ROOT, "engine", "start_comfyui.bat");

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

/** 供设置页「恢复默认」与 image_setup defaults 共用的一份快照。 */
export function defaultAssetPaths() {
	return {
		installRoot: INSTALL_ROOT,
		modelsRoot: MODELS_ROOT,
		engineRoot: ENGINE_ROOT,
		upscaleEnginesRoot: UPSCALE_ROOT,
		outputDir: OUTPUT_DIR,
	};
}
