/**
 * dsh-imagekit — 图像生成工坊（生成 / 处理 / 放大 / 引擎 / 性能）
 * ==================================================================
 * 独立发行版 0.0.1：把图像生成、像素处理、Vulkan 超分、ComfyUI 引擎管理
 * 与 GPU/VRAM 性能监测收敛到一个 DSH 插件包中，一次安装、一个工具集。
 *
 * 工具族：
 *   image     image_generate / image_generate_raw / image_workflow_inspect / image_prompt_guide / image_service_status
 *   process   image_resize_lanczos / image_mark_region / image_flatten_alpha / anim_encode / pose_check
 *   upscale   image_upscale
 *   engine    comfy（ComfyUI 共享引擎：状态 / 启停 / 显存释放 / 升级）
 *   perf      perf（GPU 专用/共享显存、按进程归因、CPU/内存、历史与打点）
 *
 * 工具集档位（Config.toolsetProfile）：
 *   minimal   只有两个功能能用的最小集：生图 + 提示词手册 + 放大 + 状态 + 组件安装 + 引擎开关（6 件）
 *   lean      standard 的全部能力，但像素处理合并成 image_process（10 件，默认）
 *   standard  + 任意工作流（raw/inspect）+ 像素处理 5 件 + perf（14 件）
 *   all       + env_probe + preflight（16 件）
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
import { apply as applyEngine, Config as EngineConfig, restartIfIdle } from "./engine/index.js";
import { apply as applyPerf, Config as PerfConfig } from "./perf/index.js";
import { registerSetupTools, resolveLayout } from "./setup.js";
import { applyEnv, DEFAULT_ENGINES, DEFAULT_ENV_DATA_DIR, DEFAULT_PERF_DATA_DIR } from "./env/index.js";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tool-image";
/** 依赖的宿主服务：工具注册器、系统提示组装、会话工作目录。 */
const inject = ["tools", "systemPrompt", "workingDirectory"];

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

const PROFILES = new Set(["minimal", "lean", "standard", "all"]);
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
	toolsetProfile: Schema.string().default("lean").volatile().description(
		"minimal：只留生图+放大（含状态/安装/引擎）；lean（默认）：standard 的全部能力，但像素处理合并成 image_process、不带 perf（少 5 份 schema）；standard：像素处理拆成独立工具，并带 perf（性能与显存面板）；all：再加环境检测（env_probe/preflight）"
	),
	gatewayUrl: Schema.string().default("http://127.0.0.1:8189").description("本地生图网关地址（默认 http://127.0.0.1:8189；仅编辑类模板需要）"),
	vramIdleFreeMinutes: Schema.number().default(10).min(0).description("空闲多少分钟后回收引擎显存：插件自己拉起的引擎到点重启（AIMDO 下 /free 释放不了地址空间），用户自己开的引擎只发 /free；0 = 不自动（默认 10）"),
	generationBackend: Schema.union(["auto", "direct", "gateway"])
		.default("auto")
		.volatile()
		.description("出图后端：auto（默认，网关不可用时自动用内置直连）/ direct（只用内置直连）/ gateway（只用外部网关）"),
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
	downloadConnections: Schema.union(["1", "2", "4", "8"])
		.default("4")
		.volatile()
		.description("大文件下载的分片连接数（1 = 单流；默认 4，实测约 1.4–3.8×；服务端不支持 Range 时自动回退单流）"),
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
	const profile = String(config?.toolsetProfile ?? "lean");
	if (!PROFILES.has(profile)) {
		throw new Error(`toolsetProfile must be one of ${[...PROFILES].join(", ")} (got ${JSON.stringify(profile)})`);
	}
	// 本插件是 Windows x64 向的：ComfyUI 便携引擎与超分二进制都是 .exe。
	// 其他平台不硬拦加载，但在这里说清楚，避免用户把 “引擎起不来” 当 bug 查。
	if (process.platform !== "win32") {
		ctx.logger?.warn?.(
			"dsh-imagekit targets Windows x64: the ComfyUI engine and Vulkan upscale binaries are Windows builds; generation/upscaling will fail on this platform."
		);
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

	// 引擎配置先建出来：生成工具的空闲回收要看它（只重启插件自己拉起的引擎）。
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
	const engineCfg = EngineConfig(engineRaw);

	// 两件核心功能在任何档位都在：生图（image_generate + image_service_status）与放大（image_upscale）。
	registerImageGenTools(
		ctx,
		{
			gatewayUrl,
			generationBackend: config.generationBackend,
			vramIdleFreeMinutes: config.vramIdleFreeMinutes,
			// 空闲回收默认只发 /free；插件自己拉起的引擎改为到点重启——AIMDO 的 VBAR 预留
			// 只有进程退出才归还，卸载等于没做（见 docs/CONFIGURATION.md 的已知问题）。
			idleRecycle: () => restartIfIdle(engineCfg),
			comfyBaseUrl: config.comfyBaseUrl,
			startTimeoutSeconds: 90,
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
			timeoutSeconds: config.processTimeoutSeconds,
			// lean：五件像素工具合并成一个 image_process（action 分发），减少常驻 schema。
			merge: profile === "lean"
		});
	}

	{
		// 引擎管理：与图像工具同包，保证 image_generate 总能按工具名 comfy 调用（任何档位都在）。
		applyEngine(ctx, engineCfg);
	}

	// 性能监测：设置页的「性能与显存」面板依赖 perf 工具。它服务于「重活前的显存体检」，
	// 与生图/像素处理无关，而 schema 常驻 210 token——默认档（lean）不注册，standard 起才带它，
	// 面板在缺这个工具时自己降级成一句提示，不报错。
	if (profile === "standard" || profile === "all") {
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
		// 只说「什么时候该想到我」。「调用提示词手册」已写在 image_generate 的描述里，
		// 「生成后复核图片」已写在它的结果文本里——同一句话在两处重复只是常驻成本。
		text: ({ scope }) => (ctx.tools.get("image_generate", scope) === undefined ? "" : "Local image generation/editing (Qwen-Image-2.1) is available when the deliverable is a picture.")
	});
}

export { Config, apply, inject, name };
