/**
 * dsh-imagekit — 图像生成工坊（生成 / 处理 / 放大 / 引擎 / 性能）
 * ==================================================================
 * 独立发行版 0.0.1：把图像生成、像素处理、Vulkan 超分、ComfyUI 引擎管理
 * 与 GPU/VRAM 性能监测收敛到一个 DSH 插件包中，一次安装、一个工具集。
 *
 * 工具族：
 *   image     image_generate / image_generate_raw / image_workflow_inspect / image_service_status
 *   process   image_resize_lanczos / image_mark_region / image_flatten_alpha / anim_encode / pose_check
 *   upscale   image_upscale
 *   engine    comfy（ComfyUI 共享引擎：状态 / 启停 / 显存释放 / 升级）
 *   perf      perf（GPU 专用/共享显存、按进程归因、CPU/内存、历史与打点）
 *
 * 工具集档位（Config.toolsetProfile）：
 *   minimal   只有两个功能能用的最小集：生图 + 放大 + 状态 + 组件安装 + 引擎开关（5 件）
 *   standard  + 任意工作流（raw/inspect）+ 像素处理 5 件 + perf（默认）
 *   all       + env_probe + preflight（15 件）
 *
 * 设计纪律：apply() 不联网、不加载 Pillow/ffmpeg/Vulkan；重依赖都在各工具
 * 的 execute 内部惰性使用，任何工具失败不得拖垮其它工具。
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { ENGINE_ROOT, INSTALL_ROOT, MODELS_ROOT, OUTPUT_DIR, UPSCALE_ROOT } from "./paths.js";
import { registerImageGenTools } from "./generate/tools.js";
import { register as registerProcessTools } from "./process.js";
import { register as registerUpscaleTools } from "./upscale.js";
import { apply as applyEngine, Config as EngineConfig } from "./engine/index.js";
import { apply as applyPerf, Config as PerfConfig } from "./perf/index.js";
import { registerSetupTools, resolveLayout } from "./setup.js";
import { applyEnv, DEFAULT_ENGINES, DEFAULT_ENV_DATA_DIR, DEFAULT_PERF_DATA_DIR } from "./env/index.js";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tool-image";
/** 依赖的宿主服务：工具注册器与系统提示组装。 */
const inject = ["tools", "systemPrompt"];

/** volatile 字段在宿主侧解析成 { get() } 描述符；读值时统一拆包。 */
const VOLATILE_KEYS = [
	"toolsetProfile",
	"outputDir",
	"installRoot",
	"modelsRoot",
	"engineRoot",
	"upscaleEnginesRoot",
	"modelSource",
	"modelPackBaseUrl",
	"upscaleSource",
	"autoDownload",
	"autoCheckUpdates",
	"keepVersions"
];

function unwrapVolatile(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}

function normalizeConfig(raw) {
	const out = { ...raw };
	for (const key of VOLATILE_KEYS) out[key] = unwrapVolatile(raw?.[key]);
	return out;
}

const PROFILES = new Set(["minimal", "standard", "all"]);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
void resolveLayout;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// 工具分类根与派生目录：统一由 lib/paths.js 决定（IMAGEKIT_INSTALL_ROOT 可覆盖），
// 这里不再出现任何写死的盘符路径。
const DEFAULT_INSTALL_ROOT = INSTALL_ROOT;
const DEFAULT_ENGINE_ROOT = ENGINE_ROOT;
const DEFAULT_MODELS_ROOT = MODELS_ROOT;
const DEFAULT_UPSCALE_ROOT = UPSCALE_ROOT;
const DEFAULT_PERF_DATA = DEFAULT_PERF_DATA_DIR;
const DEFAULT_OUTPUT_DIR = OUTPUT_DIR;

/** 引擎状态/日志默认放在引擎根的父目录（便携版布局：<ComfyUI>/ComfyUI_windows_portable）。 */
function engineHomeOf(engineRoot) {
	return path.dirname(String(engineRoot).replace(/[\\/]+$/, "")) || ".";
}

const Config = Schema.object({
	toolsetProfile: Schema.string().default("standard").volatile().description(
		"minimal：只留生图+放大（含状态/安装/引擎）；standard（默认）：再加任意工作流与像素处理；all：再加性能与环境检测"
	),
	gatewayUrl: Schema.string().default("http://127.0.0.1:8189").description("本地生图网关地址（默认 http://127.0.0.1:8189）"),
	generateTimeoutSeconds: Schema.number().default(900).min(30).description("单次生图调用上限秒数（默认 900）"),
	selfHealWaitSeconds: Schema.number().default(420).min(30).description("引擎自愈等待上限秒数（默认 420）"),
	pythonCommand: Schema.string().default("").description(
		"像素处理用的 Python 解释器（默认空 = 依次探测 python / py；需已装 Pillow，pose_check 另需 numpy）"
	),
	processTimeoutSeconds: Schema.number().default(120).min(10).description("单次像素操作上限秒数（默认 120）"),
	upscaleEnginesRoot: Schema.string().default(DEFAULT_UPSCALE_ROOT).volatile().description(
		"放大引擎根目录（默认 <installRoot>/upscale-engines/engines）"
	),
	upscaleTimeoutSeconds: Schema.number().default(600).min(30).description("单次放大调用上限秒数（默认 600）"),
	upscaleGpuDevice: Schema.number().default(0).min(0).step(1).description("Vulkan 设备号（默认 0）"),
	installRoot: Schema.string().default(DEFAULT_INSTALL_ROOT).volatile().description("工具分类根目录：引擎/模型/放大引擎都在其下（默认由 lib/paths.js 决定，可用 IMAGEKIT_INSTALL_ROOT 覆盖）"),
	outputDir: Schema.string()
		.default(DEFAULT_OUTPUT_DIR)
		.volatile()
		.description("生成图片的输出目录（默认 <installRoot>/outputs）；不传 save_to 时所有结果落这里"),
	modelsRoot: Schema.string().default(DEFAULT_MODELS_ROOT).volatile().description("生图模型目录；默认 <installRoot>/models"),
	modelSource: Schema.union(["huggingface", "hf-mirror", "modelscope", "custom"])
		.default("huggingface")
		.volatile()
		.description("模型下载源：huggingface（默认）/ hf-mirror（第三方镜像）/ modelscope / custom（配合 modelPackBaseUrl）"),
	modelPackBaseUrl: Schema.string().default("").volatile().description("自定义/自建镜像根 URL（modelSource=custom 时使用）"),
	githubProxy: Schema.string()
		.default("")
		.volatile()
		.description(
			"GitHub 下载代理（空 = 不用；例：https://ghfast.top/）。仅在官方路径都不通时兜底，" +
				"只代理 github.com 链接，仍按清单 sha256 校验；代理只影响可达性，本机实测并不加速"
		),
	upscaleSource: Schema.union(["official", "sourceforge", "custom"])
		.default("official")
		.volatile()
		.description("放大引擎下载源：official（GitHub）/ sourceforge（SourceForge 镜像）/ custom"),
	autoDownload: Schema.union(["on", "off"]).default("off").volatile().description("是否允许在生图前自动下载缺失组件（默认 off）"),
	autoCheckUpdates: Schema.union(["on", "off"]).default("on").volatile().description("是否在插件详情页提示组件更新"),
	keepVersions: Schema.union(["0", "1", "2"]).default("1").volatile().description("升级后保留的旧版本备份数（clean 时清理）"),
	engineRoot: Schema.string().default(DEFAULT_ENGINE_ROOT).volatile().description("ComfyUI 便携版引擎根目录"),
	comfyBaseUrl: Schema.string().default("http://127.0.0.1:8188").description("ComfyUI HTTP 地址"),
	comfyRegistryYaml: Schema.string().default("").description("模型注册表覆盖路径（空 = <engineRoot>\\ComfyUI\\extra_model_paths.yaml）"),
	perfDataDir: Schema.string().default(DEFAULT_PERF_DATA).description("性能采样数据目录（默认 $DSH_HOME/imagekit/perf）"),
	perfMode: Schema.string().default("inline").description("性能采样模式：inline（宿主兼容，默认）/ worker（独立线程）"),
	// 环境检测（从 dsh-plugin-guard 迁入）：env_probe / preflight
	envDataDir: Schema.string().default(DEFAULT_ENV_DATA_DIR).description("env_probe/preflight 数据目录（preflight 打点记录；默认 $DSH_HOME/imagekit/guard）"),
	nodePath: Schema.string().default("").description("Node 解释器绝对路径（空 = 从 PATH 探测）"),
	pythonPath: Schema.string().default("").description("Python 解释器绝对路径（空 = 从 PATH 探测）"),
	pnpmPath: Schema.string().default("").description("pnpm 入口路径（空 = 从 PATH 探测）"),
	enginePorts: Schema.array(Schema.number())
		.default([8188, 8189, 16800])
		.description("env_probe/preflight 视为「本机引擎」的端口（默认 8188 ComfyUI / 8189 网关 / 16800 Motrix）"),
	engines: Schema.array(
		Schema.object({
			name: Schema.string().required(),
			url: Schema.string().required(),
			fix: Schema.string()
		})
	)
		.default(DEFAULT_ENGINES)
		.description("env_probe/preflight 探测的 HTTP 引擎（name + url + 可选 fix）"),
	browserPaths: Schema.array(Schema.string()).default([]).description("env_probe browsers 检查的额外浏览器路径")
});

function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig ?? {});
	const profile = String(config?.toolsetProfile ?? "standard");
	if (!PROFILES.has(profile)) {
		throw new Error(`toolsetProfile must be one of ${[...PROFILES].join(", ")} (got ${JSON.stringify(profile)})`);
	}

	// 生成工具：网关地址/超时在加载时响亮校验。
	const gatewayUrl = String(config?.gatewayUrl ?? "").replace(/\/+$/, "");
	if (!/^https?:\/\/[^\s/]+/.test(gatewayUrl)) {
		throw new Error(`gatewayUrl must be an http(s) URL like http://127.0.0.1:8189 (got ${JSON.stringify(config?.gatewayUrl)})`);
	}
	const genTimeoutMs = Number(config?.generateTimeoutSeconds) * 1000;
	if (!Number.isFinite(genTimeoutMs) || genTimeoutMs <= 0) {
		throw new Error(`generateTimeoutSeconds must resolve to a positive number (got ${JSON.stringify(config?.generateTimeoutSeconds)})`);
	}

	// 两件核心功能在任何档位都在：生图（image_generate + image_service_status）与放大（image_upscale）。
	registerImageGenTools(
		ctx,
		{
			gatewayUrl,
			timeoutSeconds: config.generateTimeoutSeconds,
			selfHealWaitSeconds: config.selfHealWaitSeconds,
			outputDir: config.outputDir
		},
		genTimeoutMs,
		{ includeAdvanced: profile !== "minimal" }
	);

	registerUpscaleTools(ctx, {
		enginesRoot: config.upscaleEnginesRoot,
		timeoutSeconds: config.upscaleTimeoutSeconds,
		gpuDevice: config.upscaleGpuDevice,
		outputDir: config.outputDir
	});

	// 资源管理：装模型/装放大引擎是“用这两个功能”的前置，minimal 也保留。
	registerSetupTools(ctx, { pluginRoot: PLUGIN_ROOT, config });

	if (profile !== "minimal") {
		registerProcessTools(ctx, {
			pythonCommand: config.pythonCommand ?? "",
			timeoutSeconds: config.processTimeoutSeconds
		});
	}

	{
		// 引擎管理：与图像工具同包，保证 image_generate 总能按工具名 comfy 调用（任何档位都在）。
		const engineRoot = String(config.engineRoot ?? DEFAULT_ENGINE_ROOT);
		const engineHome = engineHomeOf(engineRoot);
		const engineRaw = {
			engineRoot,
			baseUrl: config.comfyBaseUrl,
			stateFile: path.join(engineHome, "engine-state.json"),
			logsDir: path.join(engineHome, "logs"),
			startTimeoutSeconds: 90
		};
		const registryYaml = String(config.comfyRegistryYaml ?? "").trim();
		if (registryYaml !== "") engineRaw.registryYaml = registryYaml;
		applyEngine(ctx, EngineConfig(engineRaw));
	}

	// 性能监测：设置页的「性能与显存」面板依赖 perf 工具，因此 standard 起就注册（minimal 不注册）。
	if (profile !== "minimal") {
		applyPerf(ctx, PerfConfig({
			dataDir: String(config.perfDataDir ?? DEFAULT_PERF_DATA),
			mode: String(config.perfMode ?? "inline")
		}));
	}

	if (profile === "all") {
		// 环境检测：本机能力体检（env_probe）+ 重活前置闸门（preflight）。
		applyEnv(ctx, config);
	}

	ctx.systemPrompt.section({
		name: "tool:image",
		order: 2060,
		text: ({ scope }) => (ctx.tools.get("image_generate", scope) === undefined ? "" : "Local image generation via Qwen-Image-2.1; load the qwen-image-cookbook skill before non-trivial prompts.")
	});
}

export { Config, apply, inject, name };
