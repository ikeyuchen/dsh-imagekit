/**
 * dsh-imagekit / lib/env/index.js
 * ================================
 * 环境检测（从 dsh-plugin-guard 迁入）：env_probe + preflight。
 * 只保留「本机能力体检」与「重活前置闸门」，不再提供 repo_check / plugin_health / agent_capacity。
 */
import os from "node:os";
import path from "node:path";
import { registerEnvTools } from "./tools.js";

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

export const DEFAULT_ENV_DATA_DIR = path.join(DSH_HOME, "imagekit", "guard");
export const DEFAULT_PERF_DATA_DIR = path.join(DSH_HOME, "imagekit", "perf");

/** 默认引擎探测列表（与各服务默认端口对齐；旧 guard 里写死的引擎目录已过时）。 */
export const DEFAULT_ENGINES = [
	{
		name: "comfyui",
		url: "http://127.0.0.1:8188/system_stats",
		fix: "用 comfy{action:control,op:start} 启动引擎，或运行 ImageKit 的启动脚本"
	},
	{
		name: "image-studio-gateway",
		url: "http://127.0.0.1:8189/health",
		fix: "先启动生图网关（或运行 image_service_status 触发自愈）"
	},
	{
		name: "comfyui-object-info",
		url: "http://127.0.0.1:8188/object_info",
		fix: "同上：ComfyUI 引擎未就绪"
	}
];

/** 把 imagekit 的 Config 归一化成 env/preflight 模块需要的形状。 */
export function envConfigOf(config = {}) {
	return {
		...config,
		dataDir: String(config.envDataDir ?? "").trim() || DEFAULT_ENV_DATA_DIR,
		perfmonDataDir: String(config.perfDataDir ?? "").trim() || DEFAULT_PERF_DATA_DIR,
		nodePath: String(config.nodePath ?? "").trim(),
		pythonPath: String(config.pythonPath ?? "").trim(),
		pnpmPath: String(config.pnpmPath ?? "").trim(),
		enginePorts: Array.isArray(config.enginePorts) ? config.enginePorts : [8188, 8189, 16800],
		engines: Array.isArray(config.engines) && config.engines.length > 0 ? config.engines : DEFAULT_ENGINES,
		browserPaths: Array.isArray(config.browserPaths) ? config.browserPaths : []
	};
}

/** 注册环境检测工具。 */
export function applyEnv(ctx, config) {
	registerEnvTools(ctx, envConfigOf(config));
}
