/**
 * dsh-plugin-image-gen / lib/tools.js
 * ===================================
 * 模型可见工具的注册体（从 lib/index.js 拆出）：
 * image_generate / image_workflow_inspect / image_generate_raw / image_prompt_guide / image_service_status。
 * 引擎/网关自愈与 HTTP 客户端在 ./gateway.js；档位表在 ../tiers.json（经 ./tiers.js 加载）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TEMPLATE_NAME_RE, loadTiers, resolveTierArgs } from "./tiers.js";
import {
	GATEWAY_LOG_DIR,
	GATEWAY_WAIT_MS,
	callGateway,
	callGatewaySoft,
	ensureBackendReady,
	gatewayHealth,
	rethrowIfAborted,
	sleepAbortable,
	tailFile,
} from "./gateway.js";
import { DIRECT_TEMPLATES, freeModels, generateDirect, generateGraphDirect } from "./direct.js";
import { ENGINE_ROOT, detectComfyUiInstalls, engineLogCandidates } from "../paths.js";

/** 引擎日志尾：插件落盘优先，其次 ComfyUI 自己的 user/comfyui.log。 */
function engineLogTail(lines) {
	for (const file of engineLogCandidates(ENGINE_ROOT)) {
		const text = tailFile(file, lines);
		if (text) return text;
	}
	return "";
}

/** 并发去重表：移到插件实例作用域（见 registerImageGenTools）——模块级共享状态
 *  会让多实例/HMR 替换后彼此串台，违反防御模式「共享状态必须挂在服务/实例上」。 */

/**
 * 档位注册表（v1.5.0）：draft / standard / quality 预设外置在插件根 tiers.json，
 * 增删档位 = 改 JSON 不改代码（重启 DSH 生效）。加载失败不抛错也不给默认档位——
 * 带 tier 的调用会拿到指明修法的显式错误，核心生成路径不受影响（见 lib/tiers.js）。
 */
const { tiers: TIERS, error: TIERS_LOAD_ERROR } = loadTiers(new URL("../../tiers.json", import.meta.url));

/**
 * 与 image_generate 完全一致的默认参数：预览/提交都对得上，不让两边默认值悄悄跑偏。
 * 默认值单点维护——默认模板名与编辑参数一并入表，请求体/meta 都从这里取；
 * 去重键已由请求体派生（P0），三处不再各自硬编码一份（否则改一处漏两处，去重等价性同遭破坏）。
 */
const DEFAULT_TEMPLATE = "qwen_image_2_1_t2i";
/**
 * 省略 tier 时的默认档位。与 README / USAGE / 内置手册里「standard 默认 1536²」
 * 的说法保持一致；此前代码默认 1024²，文档默认 1536²，属于静默不一致。
 */
const DEFAULT_TIER = "standard";
/** 省略 tier 时补上默认档位；显式档位（含空串等非法值）原样交给 resolveTierArgs 校验。 */
export function applyDefaultTier(args) {
	return args?.tier === undefined || args?.tier === null ? { ...args, tier: DEFAULT_TIER } : args;
}
/** seed=-1（或缺失）时由插件先决定实际 seed，直连与网关共用，结果 meta 才有可复现值。 */
export function resolveSeed(value) {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : Math.floor(Math.random() * 4294967295);
}
/** 宽高/编辑画布必须是 32 的倍数；比让 ComfyUI 报晦涩节点错误更早、更清楚。 */
export function assertImageSize(value, name) {
	if (value === undefined || value === null) return;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
	}
	if (value % 32 !== 0) {
		throw new Error(`${name} must be a multiple of 32 px (got ${value}); round it, e.g. 1920x1088 instead of 1920x1080`);
	}
	if (value > 4096) {
		throw new Error(`${name} ${value} exceeds the supported 4096 px single-side limit`);
	}
}
/** 相对 save_to 以会话工作目录为基准，而不是宿主进程 cwd（实测两者可能不同）。 */
async function workingDirOf(ctx, exec) {
	try {
		const service = ctx?.get?.("workingDirectory") ?? ctx?.workingDirectory;
		if (service !== undefined && service !== null) {
			if (typeof service.ensure === "function") {
				const resolved = await service.ensure(exec?.agent, exec?.signal);
				const dir = resolved?.path ?? resolved?.directory ?? resolved?.cwd ?? resolved;
				if (typeof dir === "string" && dir !== "") return dir;
			}
			if (typeof service.get === "function") {
				// 0.2.x 的签名是 get(session)；宿主没暴露 session 时退回 agent，免得丢掉 defaultDirectory。
				const resolved = await service.get(exec?.agent?.session ?? exec?.agent);
				const dir = resolved?.path ?? resolved?.directory ?? resolved?.cwd ?? resolved;
				if (typeof dir === "string" && dir !== "") return dir;
			}
			if (typeof service.defaultDirectory === "string" && service.defaultDirectory !== "") return service.defaultDirectory;
		}
		const legacy = exec?.workingDirectory;
		const dir = legacy?.ensure?.() ?? legacy?.get?.();
		return typeof dir === "string" && dir !== "" ? dir : process.cwd();
	} catch {
		return process.cwd();
	}
}

/**
 * 选择出图后端：
 *  - `generationBackend=direct`：只用内置直连（不碰网关）；
 *  - `gateway`：只用外部网关（保行为不变）；
 *  - `auto`（默认）：网关在线就走网关，离线就用内置直连（免去用户自备网关）。
 * 内置直连只覆盖文生图模板；编辑类模板仍需要网关，此时明确报错而不是静默降级。
 */
const TURBO_TEMPLATES_LOCAL = new Set(["qwen_image_2_1_t2i_turbo", "turbo_official_t2i", "t2i_turbo"]);

async function pickBackend(config, template, signal) {
	const mode = String(config.generationBackend ?? "auto");
	const templateName = String(template ?? DEFAULT_TEMPLATE);
	if (mode === "direct") return "direct";
	if (mode === "gateway") return "gateway";
	let health = "gateway-down";
	try {
		health = await gatewayHealth(config.gatewayUrl, signal);
	} catch (error) {
		rethrowIfAborted(error, signal);
		health = "gateway-down";
	}
	if (health !== "gateway-down") return "gateway";
	if (!DIRECT_TEMPLATES.has(templateName)) {
		throw new Error(
			`template "${templateName}" needs the external image gateway (${config.gatewayUrl}), which is unreachable, and the built-in backend only covers ${[...DIRECT_TEMPLATES].join(", ")}. ` +
				"Either start that gateway, or use a text-to-image template (tier=draft/standard/quality)."
		);
	}
	return "direct";
}

const EDIT_TEMPLATE = "qwen_image_2_1_edit";
const GEN_DEFAULTS = { width: 1536, height: 1536, steps: 25, cfg: 1.0, seed: -1, batch_size: 1 };
const EDIT_DEFAULTS = { resolution: 1056, denoise: 1.0 };

/**
 * 编辑类模板（不含 t2i）：这类模板的图里带着 `__IMAGE1__` / `__IMAGE2__` 占位符，
 * 没有参考图就拼不出起始图——网关那边只会回一句 400「模板占位符 __IMAGE1__ 没有对应参数」。
 * 在本地提前拦下，错误信息里直接给修法。
 */
const NEEDS_REF_IMAGE_RE = /(^|[_-])(edit\d*|i2i)($|[_-])/i;
const templateNeedsRefImage = (template) =>
	typeof template === "string" && NEEDS_REF_IMAGE_RE.test(template) && !/t2i/i.test(template);

/**
 * 参考图必须配 edit/i2i 模板（t2i 根本不吃 ref_images，网关会直接忽略）。
 * 过去的失败模式：用户说“把这张图里的猫改成狗”，模型传了 ref_images 却用默认 t2i，
 * 结果参考图被静默丢弃、生成一张无关新图。这里给出明确决策：
 *   - 没显式指定 template（或档位给的是 t2i 系） → 自动改走编辑模板；
 *     · denoise<1 + 单图 → i2i（只有 i2i 模板吃 __DENOISE__，edit 写死 1.0）
 *     · 多图 → edit3/edit6（网关的多图模板，直连忽略模板名、按张数拼节点）
 *   - 用户显式给了 t2i 模板 → 报错并指明改法（不静默纠正用户意图）。
 * 导出供离线测试使用（不依赖 cordis 上下文）。
 */
export function resolveTemplateForRefs({ effectiveTemplate, explicitTemplate, refCount, denoise }) {
	if (!refCount) return { template: effectiveTemplate, switched: false };
	const tpl = effectiveTemplate ?? DEFAULT_TEMPLATE;
	const isTextOnly = tpl.includes("t2i");
	if (!isTextOnly) return { template: tpl, switched: false };
	if (typeof explicitTemplate === "string" && explicitTemplate !== "") {
		throw new Error(
			`template "${explicitTemplate}" is text-to-image and ignores ref_images. ` +
				`For image editing pass template: "${EDIT_TEMPLATE}" (or "qwen_image_2_1_edit3" / "qwen_image_2_1_edit6" / "qwen_image_2_1_i2i"), or drop template to let it pick the edit path automatically.`
		);
	}
	const partialRedraw = Number.isFinite(Number(denoise)) && Number(denoise) > 0 && Number(denoise) < 1;
	if (partialRedraw && refCount === 1) return { template: "qwen_image_2_1_i2i", switched: true };
	if (refCount >= 4) return { template: "qwen_image_2_1_edit6", switched: true };
	if (refCount >= 2) return { template: "qwen_image_2_1_edit3", switched: true };
	return { template: EDIT_TEMPLATE, switched: true };
}

/** 拼 `/debug/workflow/{name}` 的查询串（网关默认值是 steps=20/cfg=4.0，与本插件不同，所以显式传）。 */
function templatePreviewQuery(args) {
	return new URLSearchParams({
		prompt: args.prompt ?? "debug",
		width: String(args.width ?? GEN_DEFAULTS.width),
		height: String(args.height ?? GEN_DEFAULTS.height),
		steps: String(args.steps ?? GEN_DEFAULTS.steps),
		cfg: String(args.cfg ?? GEN_DEFAULTS.cfg),
		seed: String(args.seed ?? GEN_DEFAULTS.seed),
		batch_size: String(args.batch_size ?? GEN_DEFAULTS.batch_size),
		negative_prompt: args.negative_prompt ?? ""
	}).toString();
}

/**
 * 模板名只允许单层名字：网关侧只取 basename，这里也堵住穿越写法。
 * 复用 tiers.js 导出的同一份 TEMPLATE_NAME_RE（此前是手工拷贝的第二份，
 * 两处独立维护必然漂移）；错误信息也不再硬编码盘上路径，指向可发现的网关 workflows 目录。
 */
function assertTemplateName(name) {
	if (!TEMPLATE_NAME_RE.test(String(name))) {
		throw new Error(
			`Invalid template name ${JSON.stringify(name)}: only a bare name under the gateway workflows directory is allowed (no path, no _api.json, no leading/trailing/double dots).`
		);
	}
}

/** 递归找出仍未被替换的 __PLACEHOLDER__（模板文件里就是这些标记，直接提交必报 invalid_input_type）。 */
function findPlaceholders(value) {
	const found = new Set();
	const walk = (v) => {
		if (typeof v === "string") {
			for (const m of v.match(/__[A-Z0-9_]+__/g) ?? []) found.add(m);
			return;
		}
		if (Array.isArray(v)) {
			v.forEach(walk);
			return;
		}
		if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(value);
	return [...found];
}

/** API 格式图的节点清单（节点 id 是顶层键，节点体带 class_type）。 */
function graphNodes(graph) {
	return Object.entries(graph ?? {})
		.filter(([, v]) => v && typeof v === "object" && typeof v.class_type === "string")
		.map(([id, v]) => ({ id, class_type: v.class_type }));
}

/**
 * 把生成结果图片落到输出目录，返回 { savedTo, saved, saveError }。
 *
 * - `saveTo` 给了：只把第一张拷到指定位置（目录尾斜杠保留原文件名），维持旧语义；
 * - 没给 `saveTo`：**把所有图都拷进 Config.outputDir**，同名自动加 -1/-2 后缀，不覆盖；
 * - `outputDir` 也没配（旧部署）：保持原行为（图留在引擎输出目录），不报错。
 *
 * 数分钟生成成功后，保存失败不能把整个调用炸掉——降级为 save_error，
 * 网关侧文件名/字节数仍在。
 */
export async function saveImages(sources, saveTo, outputDir, baseDir = process.cwd()) {
	if (sources.length === 0) return {};
	try {
		if (saveTo) {
			let dest = path.resolve(baseDir, saveTo);
			if (/[\\/]$/.test(saveTo)) dest = path.join(dest, path.basename(sources[0].filename));
			await mkdir(path.dirname(dest), { recursive: true });
			await copyFile(sources[0].filename, dest);
			return { savedTo: dest };
		}
		if (!outputDir) return {};
		const dir = path.resolve(baseDir, outputDir);
		await mkdir(dir, { recursive: true });
		const saved = [];
		for (const source of sources) {
			const name = path.basename(String(source.filename ?? "image.png"));
			const ext = path.extname(name);
			const stem = path.basename(name, ext) || "image";
			// 同名不覆盖：已存在就加 -1/-2 后缀（同批次重跑、不同批次同序号都很常见）。
			let dest = path.join(dir, name);
			if (existsSync(dest)) {
				let index = 1;
				while (index < 1000) {
					const candidate = path.join(dir, `${stem}-${index}${ext}`);
					if (!existsSync(candidate)) {
						dest = candidate;
						break;
					}
					index += 1;
				}
			}
			await copyFile(source.filename, dest);
			saved.push(dest);
		}
		return { savedTo: saved[0], saved };
	} catch (error) {
		return { saveError: `saving to ${saveTo || outputDir} failed: ${String(error?.message ?? error).slice(0, 160)}` };
	}
}

function fmtMB(bytes) {
	const n = Number(bytes);
	return Number.isFinite(n) && n >= 0 ? `${(n / 1048576).toFixed(2)} MB` : "? MB";
}

/**
 * 内置提示词手册：随包分发的 `docs/PROMPTS-CORE.md`，由 image_prompt_guide 按需返回。
 * 按需读盘 + 进程内缓存（按 mtime 失效，改完文档不必重启 DSH）——手册不进常驻上下文，
 * apply() 阶段也不碰文件系统。
 */
const PROMPT_GUIDE_URL = new URL("../../docs/PROMPTS-CORE.md", import.meta.url);
let promptGuideCache = null;

/** 读手册正文；文件缺失就抛错（打包漏文件是发布事故，必须响亮）。 */
export function readPromptGuide() {
	try {
		const mtimeMs = statSync(PROMPT_GUIDE_URL).mtimeMs;
		if (promptGuideCache !== null && promptGuideCache.mtimeMs === mtimeMs) return promptGuideCache.text;
		promptGuideCache = { mtimeMs, text: readFileSync(PROMPT_GUIDE_URL, "utf8") };
		return promptGuideCache.text;
	} catch (error) {
		throw new Error(`prompt handbook missing at ${PROMPT_GUIDE_URL.href}: ${error?.message ?? error}`);
	}
}

/** 手册小节标题（`## ` 开头）。 */
export function promptGuideTopics(markdown) {
	return [...String(markdown).matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

/**
 * 小节别名：模型常用英文/内容词提问（text/edit/upscale/写实/海报），
 * 标题却是中文主题词。没有别名时这些查询会静默回退整本手册（实测 2303 tokA vs 163）。
 * 每组第一个是标题里的中文关键词；其余是允许的英文/近义写法。
 */
const SECTION_ALIAS_GROUPS = [
	["文字", "文字渲染", "text", "text rendering", "typography", "font", "文字排版"],
	["编辑", "参考图", "参考图编辑", "edit", "editing", "reference", "ref", "i2i", "denoise", "局部"],
	["放大", "超分", "后处理", "upscale", "upscaling", "super resolution", "sr"],
	["边界", "能力边界", "limit", "limits", "capability", "capabilities", "boundary"],
	["排查", "排障", "速查", "troubleshoot", "troubleshooting", "debug", "symptoms"],
	["选档", "档位", "tier", "tiers", "preset", "presets"],
	["分类配方", "配方", "风格", "recipe", "recipes", "style", "styles", "photo", "realistic", "poster", "anime", "3d", "product", "sticker", "icon", "写实", "海报", "二次元", "产品", "透明", "图标"],
	["动图", "多帧", "animation", "anim", "frame", "frames", "gif", "webp"],
	["实验", "方法", "上限", "experiment", "experiments", "method", "methods", "seed", "测试"],
	["不该用", "什么时候不该用", "when not to use", "not for", "negative capability"],
	["写法", "骨架", "prompt", "writing", "caption"],
];

function expandSectionKeywords(section) {
	const raw = String(section ?? "").trim();
	const key = raw.toLowerCase();
	const group = SECTION_ALIAS_GROUPS.find((items) => items.some((item) => item.toLowerCase() === key));
	return group ?? [raw];
}

/** 按关键字取小节：命中标题返回该节；未命中返回空内容（不再静默回退全文）。 */
export function slicePromptGuide(markdown, section) {
	const md = String(markdown);
	const raw = String(section ?? "").trim();
	if (raw === "") return { content: md, matched: false };
	const keys = expandSectionKeywords(raw);
	const blocks = md.split(/^## /m).map((block, index) => (index === 0 ? block : `## ${block}`));
	const hit = blocks.find((block) => {
		if (!block.startsWith("## ")) return false;
		const heading = block.split("\n", 1)[0].toLowerCase();
		return keys.some((key) => heading.includes(key.toLowerCase()));
	});
	return hit ? { content: hit.trimEnd(), matched: true } : { content: "", matched: false };
}

/** 模型可见的结果元数据行：seed/尺寸/步数必须能被 agent 读到，否则复现闭环断裂。 */
export function formatMetaLine(meta) {
	if (!meta || typeof meta !== "object") return "";
	const size = meta.resolution ? `resolution=${meta.resolution}` : `size=${meta.width ?? "?"}x${meta.height ?? "?"}`;
	return `; seed=${meta.seed ?? "?"} ${size} steps=${meta.steps ?? "?"} cfg=${meta.cfg ?? "?"} template=${meta.template ?? "?"}` +
		(meta.backend ? ` backend=${meta.backend}` : "");
}

/** 注册全部工具。genTimeoutMs 由 apply 按 Config.timeoutSeconds 换算后传入。 */
export function registerImageGenTools(ctx, config, genTimeoutMs, options = {}) {
	const includeAdvanced = options.includeAdvanced !== false;
	/** 并发去重表（本插件实例拥有）：完全相同的生成请求复用同一次执行。 */
	const inflightGenerations = new Map();
	// 工具硬超时必须盖住最坏链路——网关等待上限 GATEWAY_WAIT_MS(120s) +
	// 引擎冷启动 selfHealWaitSeconds（默认 420s）+ 提交 60s + 轮询余量 60s + 探测间隔松弛
	//（gatewayHealth 每轮最坏 ~24s）。固定 240s 富余在冷启动场景下会被宿主先杀：精心构造的
	// 「任务可能仍在跑，去 GET /result/{id}」恢复提示反而没机会出现，且以 AbortError 形式
	// 失败更难排查。selfHealWaitSeconds 兜底 420 与 Schema 默认一致（经 index.js 归一化时恒有值）。
	const healWaitMs =
		Number.isFinite(config.selfHealWaitSeconds) && config.selfHealWaitSeconds > 0 ? config.selfHealWaitSeconds * 1000 : 420000;
	const toolDeadlineMs = genTimeoutMs + GATEWAY_WAIT_MS + healWaitMs + 240000;
	// 后台分支需要回调自身（去掉 run_in_background 后跑同步体）。
	let imageTool;
	ctx.tools.register(imageTool = defineTool({
		name: "image_generate",
		description:
			"Generate or edit an image (local Qwen-Image-2.1); returns PNG paths. " +
			"Call image_prompt_guide first when the image needs exact on-image text/labels or a specific style.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description:
					"One coherent paragraph, not keywords: subject→setting→style→light; concrete colors/counts; quote on-image text. Edits: state what changes and what stays. zh or en; 'transparent' for alpha."
			},
			tier: {
				type: "string",
				description: "Omit = standard (1536², 25 steps); draft = fast turbo (needs fast pack); quality = 2K/40."
			},
			template: {
				type: "string",
				description: "Default qwen_image_2_1_t2i; edits use *_edit* / *i2i* (see image_service_status)."
			},
			width: { type: "integer", description: "Width px, multiple of 32 (default 1536)." },
			height: { type: "integer", description: "Height px, multiple of 32 (default 1536)." },
			steps: { type: "integer", description: "Sampling steps (default 25)." },
			seed: { type: "integer", description: "-1 random (default); actual seed is returned in meta." },
			batch_size: { type: "integer", description: "Images per call 1-8 (default 1)." },
			ref_images: {
				type: "array",
				items: { type: "string" },
				description: "Absolute paths, addressed as <image1>... (max 10); switches to the edit template."
			},
			save_to: {
				type: "string",
				description: "First image destination (trailing / keeps name; relative to cwd); omit = output dir for all."
			},
			run_in_background: { type: "boolean", description: "Return jobId at once; read with job_output." },
			unload_after: { type: "boolean", description: "Free engine VRAM after this call." },
			cfg: {
				type: "number",
				description: "Sampler CFG (default 1.0); 2.0 helps dense small text."
			},
			negative_prompt: {
				type: "string",
				description: "What to avoid (e.g. dense text posters)."
			},
			resolution: {
				type: "integer",
				description: "Edit canvas budget (default 1056); ignored by t2i."
			},
			denoise: {
				type: "number",
				description:
					"i2i strength 0-1 with exactly ONE ref: 0.4-0.6 polish; 0.7-0.9 keeps structure, repaints the rest; 1.0/omit = full repaint (edit) or ignored (t2i)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					prompt_id: { type: "string", required: true },
					images: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								filename: { type: "string" },
								url: { type: "string" },
								bytes: { type: "number" }
							}
						}
					},
					meta: { type: "object", additionalProperties: true, required: true },
					saved_to: { type: "string" },
					tier: { type: "string" },
					tier_applied: { type: "array", items: { type: "string" } }
				}
			},
			render: (_args, value) => (value?.kind === "background"
				? [{ type: "text", text: `started background job ${value.jobId}${value.label ? ` (${value.label})` : ""}; read with job_output, cancel with job_kill` }]
				: [{
				type: "text",
				text:
					`Generated ${value.images?.length ?? 0} image(s): ` +
					(value.images ?? []).map((i) => `${i.filename} (${fmtMB(i.bytes)})`).join(", ") +
					(value.tier ? `; tier=${value.tier}${value.tier_applied?.length ? ` (${value.tier_applied.join("+")} from preset)` : ""}` : "") +
					(value.meta
						? formatMetaLine(value.meta)
						: "") +
					(value.saved?.length ? `; saved: ${value.saved.join(", ")}` : value.saved_to ? `; copied to ${value.saved_to}` : "") +
					(value.save_error ? `; save FAILED: ${value.save_error}` : "") +
					(value.preflight?.engine_thermal ? `; engine ${value.preflight.engine_thermal}` : "") +
					(value.reused_inflight ? "; reused an identical in-flight generation (no duplicate engine call)" : "") +
					(value.preflight?.actions?.length ? `; auto-recovery: ${value.preflight.actions.join("; ")}` : "") +
					(value.preflight && (value.preflight.queue_running > 0 || value.preflight.queue_pending > 0)
						? `; queue before this job: ${value.preflight.queue_running} running, ${value.preflight.queue_pending} pending`
						: "") +
					"; review before delivery: inspect the image (read_image) for text/attribute errors; retry with the same seed if it drifted"
			}])
		},
		timeoutMs: toolDeadlineMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (args.run_in_background === true) {
				const jobs = ctx?.get?.("jobs");
				if (jobs === null || jobs === undefined || typeof jobs.start !== "function") {
					throw new Error("run_in_background needs the jobs runtime: load dsh-jobs-local + dsh-tool-jobs, or drop the flag");
				}
				const label = `image_generate ${String(args.prompt ?? "").slice(0, 60)}`;
				const controller = new AbortController();
				let cancelReason = null;
				const jobId = jobs.start({
					kind: "image_generate",
					label,
					owner: exec?.agent?.session?.id ?? exec?.agent?.sessionId,
					...(typeof exec?.callId === "string"
						? { toolCall: { callId: exec.callId, rootCallId: exec.parentCallId ?? exec.callId } } : {}),
					run(handle) {
						const done = (async () => {
							try {
								const result = await imageTool.execute({ ...args, run_in_background: false }, {
									...exec,
									signal: AbortSignal.any([exec.signal, controller.signal].filter(Boolean)),
								});
								handle.append(JSON.stringify(result));
								return { status: "completed", result: JSON.stringify(result) };
							} catch (error) {
								return { status: cancelReason !== null ? "killed" : "failed", detail: String(error?.message ?? error) };
							}
						})();
						return {
							cancel(reason) {
								cancelReason = typeof reason === "string" && reason !== "" ? reason : "cancelled";
								controller.abort(cancelReason);
							},
							done,
						};
					},
				});
				return { kind: "background", jobId: String(jobId), label, prompt_id: `job:${jobId}`, images: [], meta: { background: true } };
			}
			// —— 档位展开（显式传参 > 档位预设 > 默认值；未知档位/表损坏显式报错，不静默回退）——
			// 宿主可能冻结工具参数；未传档位时 resolveTierArgs 原样返回该对象，
			// 后面“自动切编辑模板”要写 template——不先拷贝就会报
			// “Cannot add property template, object is not extensible”。
			// 档位表损坏时不注入默认档，保证「不带 tier 的核心生成路径」仍能出图；
			// 显式传 tier 的调用仍会拿到指明修法的错误。
			const { args: effRaw, tier, applied } = resolveTierArgs(TIERS, TIERS_LOAD_ERROR, TIERS_LOAD_ERROR ? args : applyDefaultTier(args));
			const eff = { ...effRaw };
			// —— 空 prompt 闸门：schema 的 required 只管「传了没有」，空串与纯空白照样能过。
			// 送进引擎的结果是一张与意图无关的图，调用方却收到「成功」——静默劣化最难查，就地拦住。
			if (typeof eff.prompt !== "string" || eff.prompt.trim() === "") {
				throw new Error(
					`prompt must be a non-empty string describing the image (got ${eff.prompt === "" ? "an empty string" : JSON.stringify(eff.prompt)}). ` +
						"Say what the picture shows: subject, setting, style, light. No silent fallback."
				);
			}
			// —— 参考图 × 模板闸门：t2i 模板不消化 ref_images，见 resolveTemplateForRefs 注释 ——
			// 非字符串条目一律响亮报错：静默过滤会让「参考图没生效」变成一个更远的谜题——
			// 参数看着都对、产出却和预期无关，还得多轮试错才定位到“那张图被悄悄丢了”。
			const rawRefs = eff.ref_images === undefined || eff.ref_images === null ? [] : eff.ref_images;
			if (!Array.isArray(rawRefs)) {
				throw new Error(`ref_images must be an array of absolute image paths (got ${JSON.stringify(rawRefs)})`);
			}
			const badRefIndex = rawRefs.findIndex((p) => typeof p !== "string" || p.trim() === "");
			if (badRefIndex !== -1) {
				const bad = rawRefs[badRefIndex];
				throw new Error(
					`ref_images[${badRefIndex}] must be a non-empty absolute path string (got ${bad === "" ? "an empty string" : JSON.stringify(bad)}). ` +
						"Point it at the image file itself, not at an object or a directory."
				);
			}
			const refCount = rawRefs.length;
			// 编辑类模板却一张参考图都没有：网关侧只会回 400「模板占位符 __IMAGE1__ 没有对应参数」，
			// 直连也拼不出起始图。在本地就把「缺什么、怎么补」说清楚。
			if (refCount === 0 && templateNeedsRefImage(eff.template)) {
				throw new Error(
					`template "${eff.template}" is an image-editing template and needs at least one ref image, but none were given. ` +
						'Pass ref_images: ["<absolute path>"] (address it as <image1> in the prompt), ' +
						"or drop template to generate text-to-image. No silent fallback."
				);
			}
			const tplChoice = resolveTemplateForRefs({
				effectiveTemplate: eff.template,
				explicitTemplate: typeof args.template === "string" ? args.template : undefined,
				refCount,
				denoise: Number(eff.denoise ?? EDIT_DEFAULTS.denoise)
			});
			if (tplChoice.switched) eff.template = tplChoice.template;
			// —— 防重复调用：完全相同的请求并发到达时，复用同一次生成 ——
			//    （按展开后的参数去重：tier=standard 与显式等价参数命中同一次执行）
			//    去重键必须覆盖全部会改变产出的字段（resolution/denoise/ref_images
			//    也在请求体里）——直接由请求体派生，杜绝键与 body 再漂移
			const requestBody = {
				prompt: eff.prompt,
				template: eff.template ?? DEFAULT_TEMPLATE,
				width: eff.width ?? GEN_DEFAULTS.width,
				height: eff.height ?? GEN_DEFAULTS.height,
				steps: eff.steps ?? GEN_DEFAULTS.steps,
				cfg: eff.cfg ?? GEN_DEFAULTS.cfg,
				seed: eff.seed ?? GEN_DEFAULTS.seed,
				negative_prompt: eff.negative_prompt ?? "",
				batch_size: eff.batch_size ?? GEN_DEFAULTS.batch_size,
				resolution: eff.resolution ?? EDIT_DEFAULTS.resolution,
				denoise: eff.denoise ?? EDIT_DEFAULTS.denoise,
				ref_images: eff.ref_images ?? []
			};
			// 提交前把参数收敛成可执行值：尺寸/步数/seed 的非法输入在这里显式失败，
			// 不留给 ComfyUI 报晦涩节点错误，也不让 meta 记录一个假值。
			assertImageSize(requestBody.width, "width");
			assertImageSize(requestBody.height, "height");
			assertImageSize(requestBody.resolution, "resolution");
			if (!Number.isInteger(requestBody.batch_size) || requestBody.batch_size < 1 || requestBody.batch_size > 8) {
				throw new Error(`batch_size must be an integer 1-8 (got ${JSON.stringify(requestBody.batch_size)})`);
			}
			requestBody.seed = resolveSeed(requestBody.seed);
			// denoise < 1 是部分重绘（直连走 VAEEncode，网关走 i2i 模板）：只能拿一张初始图。
			const denoiseValue = Number(requestBody.denoise);
			if (Number.isFinite(denoiseValue) && denoiseValue > 0 && denoiseValue < 1 && (requestBody.ref_images?.length ?? 0) !== 1) {
				throw new Error(
					`denoise ${denoiseValue} (partial redraw) needs exactly one ref image as the init image; got ${requestBody.ref_images?.length ?? 0}`
				);
			}
			const dedupKey = JSON.stringify(requestBody);
			const makeJob = () => (async () => {
				const backend = await pickBackend(config, eff.template, exec?.signal);
				if (backend === "direct") {
					// 内置直连：不需要网关，也不需要 Python；只要求本机 ComfyUI 引擎与模型
					const direct = await generateDirect(
						{ baseUrl: String(config.comfyBaseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, ""), timeoutSeconds: config.timeoutSeconds, startTimeoutSeconds: config.startTimeoutSeconds, idleFreeMinutes: config.vramIdleFreeMinutes, idleRecycle: config.idleRecycle },
						ctx,
						{
							prompt: requestBody.prompt,
							negativePrompt: requestBody.negative_prompt,
							width: requestBody.width,
							height: requestBody.height,
							steps: requestBody.steps,
							cfg: requestBody.cfg,
							seed: requestBody.seed,
							batchSize: requestBody.batch_size,
							refImages: Array.isArray(requestBody.ref_images) ? requestBody.ref_images : [],
							resolution: requestBody.resolution,
							denoise: requestBody.denoise,
							turbo: TURBO_TEMPLATES_LOCAL.has(String(eff.template ?? DEFAULT_TEMPLATE))
						},
						{ signal: exec?.signal }
					);
					let directUnload = {};
					if (eff.unload_after) {
						try {
							const freed = await freeModels(String(config.comfyBaseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, ""), { signal: exec?.signal });
							directUnload = { vram_freed_at: freed.freed_at };
						} catch (error) {
							rethrowIfAborted(error, exec?.signal);
							directUnload = { vram_free_error: String(error?.message ?? error).slice(0, 200) };
						}
					}
					const { savedTo, saved, saveError } = await saveImages(direct.images, eff.save_to, config.outputDir, await workingDirOf(ctx, exec));
					const meta = {
						template: eff.template ?? DEFAULT_TEMPLATE,
						width: requestBody.width,
						height: requestBody.height,
						steps: direct.steps ?? requestBody.steps,
						cfg: requestBody.cfg,
						seed: requestBody.seed,
						backend: "direct",
						...(requestBody.ref_images?.length ? { ref_count: requestBody.ref_images.length, resolution: requestBody.resolution } : {})
					};
					return {
						prompt_id: direct.prompt_id,
						images: direct.images,
						backend: "direct",
						...(direct.engine_started ? { engine_started: true } : {}),
						...(direct.mode ? { mode: direct.mode } : {}),
						...directUnload,
						meta,
						...(savedTo ? { saved_to: savedTo } : {}),
						...(saved?.length ? { saved } : {}),
						...(saveError ? { save_error: saveError } : {}),
						...(tier ? { tier, tier_applied: applied } : {})
					};
				}
				const preflight = await ensureBackendReady(config, ctx, exec?.signal);
				const body = { ...requestBody, unload_after: eff.unload_after ?? false, timeout: config.timeoutSeconds };
				// v1.5.2：改为「异步提交 + 短轮询」（镜像 image_generate_raw 的已验证模式）。
				// 旧的单请求长等待（POST /generate 同步版）会被 HTTP 客户端的 300s
				// HeadersTimeout 硬限打断：>5 分钟的任务（如 4MP 编辑）实际成功但客户端报失败。
				const submitted = await callGateway(config.gatewayUrl, "/generate/async", { method: "POST", body, timeoutMs: 60000, signal: exec?.signal });
				const promptId = submitted?.prompt_id;
				if (!promptId) throw new Error(`Gateway /generate/async did not return a prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);
				const deadline = Date.now() + genTimeoutMs + 60000;
				let result = null;
				let lastStatus = "pending";
				let netErrors = 0;
				while (Date.now() < deadline) {
					await sleepAbortable(2000, exec?.signal);
					let res;
					try {
						res = await callGatewaySoft(config.gatewayUrl, `/result/${promptId}`, { timeoutMs: 20000, signal: exec?.signal });
						netErrors = 0;
					} catch (error) {
						rethrowIfAborted(error, exec?.signal);
						// 任务已提交、引擎还在跑——轮询期的瞬时网络故障（连接抖动/重置、
						// 单次 20s 超时）不该当场判死整个调用；连续多次才放弃（404=未产出的语义不变）
						if (++netErrors >= 5) throw error;
						continue;
					}
					if (res.status === 404) { lastStatus = "pending"; continue; } // 404 = 还在队列/执行中，不是错误
					if (!res.ok) {
						// 引擎侧结构化错误（含 node id）原样透出，与同步版语义一致
						throw new Error(`Gateway GET /result/${promptId} -> HTTP ${res.status}: ${JSON.stringify(res.json?.detail ?? res.text).slice(0, 2000)}`);
					}
					if (res.json?.images?.length) { result = res.json; break; }
					lastStatus = res.json?.status ?? "running";
					// 网关已报 completed 却没有图 = 终态无产出——立即带原因失败，
					// 不空转到整个轮询预算耗尽才报「no image within Ns」
					if (res.json?.status === "completed") {
						throw new Error(
							`Generation ${promptId} reached terminal state "completed" with no images. ` +
								`The workflow produced no output — inspect it with image_workflow_inspect, or GET /result/${promptId} on the gateway.`
						);
					}
				}
				if (result === null) {
					throw new Error(
						`Generation submitted (prompt_id ${promptId}) but no image within ${Math.round((genTimeoutMs + 60000) / 1000)}s (last status: ${lastStatus}). ` +
							`The job may still finish later — GET /result/${promptId} on the gateway, or check the queue with comfy(action=status).`
					);
				}
				// unload_after：异步端点不收（立即返回无法在完成时机释放），插件拿到结果后代劳
				let unloadInfo = {};
				if (eff.unload_after) {
					try {
					const freed = await callGateway(config.gatewayUrl, "/free", { method: "POST", timeoutMs: 60000, signal: exec?.signal });
					unloadInfo = { vram_freed_at: freed?.freed_at ?? null };
					} catch (e) {
					rethrowIfAborted(e, exec?.signal);
					unloadInfo = { vram_free_error: String(e?.message ?? e).slice(0, 200) }; // 释放失败不影响已成功的结果
					}
				}
				// 保存失败降级为 save_error 字段，不丢已成功的生成结果
				const { savedTo, saved, saveError } = await saveImages(result.images ?? [], eff.save_to, config.outputDir, await workingDirOf(ctx, exec));
				// /result 不带 meta（同步版有）——插件自建同形 meta，对外契约不变（#223：默认值单点取）
				const meta = {
					template: eff.template ?? DEFAULT_TEMPLATE,
					width: requestBody.width,
					height: requestBody.height,
					steps: requestBody.steps,
					cfg: requestBody.cfg,
					seed: requestBody.seed,
					backend: "gateway",
					...(requestBody.ref_images?.length ? { ref_count: requestBody.ref_images.length, resolution: requestBody.resolution } : {})
				};
				// tier/tier_applied：预设生效了什么直接可取证（render 文本同样可见）
				return {
					...result,
					prompt_id: promptId,
					backend: "gateway",
					meta,
					...unloadInfo,
					...(savedTo ? { saved_to: savedTo } : {}),
					...(saved?.length ? { saved } : {}),
					...(saveError ? { save_error: saveError } : {}),
					preflight,
					...(tier ? { tier, tier_applied: applied } : {})
				};
			})();
			let job = inflightGenerations.get(dedupKey);
			if (job) {
				let shared = null;
				try {
					const leader = await job;
					shared = { ...leader };
					delete shared.saved_to; // 领头的 save_to 不是搭车方的执行记录
				} catch (error) {
					// 搭车不能被领头者的取消连坐——自己未取消时不能跟着失败
					rethrowIfAborted(error, exec?.signal);
					if (error?.name === "AbortError") {
						job = makeJob(); // 领头被取消而自己没有 → 落下去自己重新建单（用自己的 exec.signal）
					} else {
						// 领头者的真实失败：透出但标记来源（不吞、也不盲目重试引擎错误）
						throw new Error(`piggybacked in-flight generation failed (leader error): ${String(error?.message ?? error).slice(0, 400)}`);
					}
				}
				if (shared) {
					// unload_after 也是每个调用方自己的意图——搭车方拿到结果后自己代劳
					let unloadInfo = {};
					if (eff.unload_after) {
						try {
							const freed = await callGateway(config.gatewayUrl, "/free", { method: "POST", timeoutMs: 60000, signal: exec?.signal });
							unloadInfo = { vram_freed_at: freed?.freed_at ?? null };
						} catch (e) {
							rethrowIfAborted(e, exec?.signal);
							unloadInfo = { vram_free_error: String(e?.message ?? e).slice(0, 200) };
						}
					}
					const { savedTo, saved, saveError } = await saveImages(shared.images ?? [], eff.save_to, config.outputDir, await workingDirOf(ctx, exec));
					return {
						...shared,
						...unloadInfo,
						reused_inflight: true,
						...(savedTo ? { saved_to: savedTo } : {}),
						...(saved?.length ? { saved } : {}),
						...(saveError ? { save_error: saveError } : {})
					};
				}
			} else {
				job = makeJob();
			}
			inflightGenerations.set(dedupKey, job);
			try {
				return await job;
			} finally {
				// 只清理仍是自己那次执行的登记（键可能已被后来者替换，不能误删）
				if (inflightGenerations.get(dedupKey) === job) inflightGenerations.delete(dedupKey);
			}
		}
	}));

	if (includeAdvanced) {
		ctx.tools.register(defineTool({
			name: "image_workflow_inspect",
			description: "Show the ComfyUI workflow a gateway template submits (gateway only).",
			parameters: {
				template: {
					type: "string",
					required: true,
					description: "Template name (bare, no _api.json)."
				},
				prompt: { type: "string", description: "Substituted into the preview (default \"debug\")." },
				width: { type: "integer", description: "Same as image_generate (1536)." },
				height: { type: "integer", description: "Same as image_generate (1536)." },
				steps: { type: "integer", description: "Same as image_generate (25)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					properties: {
						template: { type: "string", required: true },
						nodeCount: { type: "number", required: true },
						nodes: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: true,
								properties: { id: { type: "string" }, class_type: { type: "string" } }
							}
						},
						graph: { type: "object", additionalProperties: true, required: true },
						placeholdersRemaining: { type: "array", items: { type: "string" }, required: true },
						previewParams: { type: "object", additionalProperties: true, required: true }
					}
				},
				render: (_args, value) => {
					// render 是**模型可见通道**（宿主按 render 呈现结果）：graph 必须在这里逐字出现，
					// 否则“pass it as workflow”就是空话——实测探针指出：只写进 output 的字段模型看不到。
					const graphJson = JSON.stringify(value.graph ?? {}, null, 1);
					const graphBlock = graphJson.length > 8000
						? `(graph too large to inline: ${graphJson.length} chars —用 from_template + node_overrides，不要整图传递)`
						: graphJson;
					return [{
						type: "text",
						text:
							`Template ${value.template}: ${value.nodeCount} nodes -> ` +
							value.nodes.map((n) => `${n.id}:${n.class_type}`).join(", ") +
							`\npreviewParams: ${JSON.stringify(value.previewParams)}` +
							`\nunresolved placeholders: ${value.placeholdersRemaining.length ? value.placeholdersRemaining.join(", ") : "none"}` +
							`\ngraph（原样给 image_generate_raw 的 workflow，或用 from_template + node_overrides 按节点改）:\n${graphBlock}`
					}];
				}
			},
			timeoutMs: 30000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				assertTemplateName(args.template);
				const state = await gatewayHealth(config.gatewayUrl, exec?.signal);
				if (state === "gateway-down") {
					throw new Error(
						`image_workflow_inspect resolves gateway templates at ${config.gatewayUrl}, which is unreachable. ` +
							`Built-in direct templates (${[...DIRECT_TEMPLATES].join(", ")}) are composed in code; ` +
							"for offline custom graphs, pass a full `workflow` to image_generate_raw instead."
					);
				}
				const graph = await callGateway(
					config.gatewayUrl,
					`/debug/workflow/${encodeURIComponent(args.template)}?${templatePreviewQuery(args)}`,
					{ timeoutMs: 20000, signal: exec?.signal }
				);
				const nodes = graphNodes(graph);
				return {
					template: args.template,
					nodeCount: nodes.length,
					nodes,
					graph,
					placeholdersRemaining: findPlaceholders(graph),
					previewParams: {
						prompt: args.prompt ?? "debug",
						width: args.width ?? GEN_DEFAULTS.width,
						height: args.height ?? GEN_DEFAULTS.height,
						steps: args.steps ?? GEN_DEFAULTS.steps,
						cfg: args.cfg ?? GEN_DEFAULTS.cfg,
						seed: args.seed ?? GEN_DEFAULTS.seed,
						batch_size: args.batch_size ?? GEN_DEFAULTS.batch_size
					}
				};
			}
		}));

		ctx.tools.register(defineTool({
			name: "image_generate_raw",
			description: "Run a ComfyUI API workflow; inline graphs use the direct backend, from_template needs the gateway.",
			parameters: {
				from_template: {
					type: "string",
					description: "Template name; exactly one of from_template / workflow."
				},
				workflow: {
					type: "object",
					additionalProperties: true,
					description:
						"Full API graph (node id -> node object)."
				},
				node_overrides: {
					type: "object",
					additionalProperties: true,
					description:
						"Per-node patch: {\"6\":{\"inputs\":{...}}}; inputs merge."
				},
				prompt: { type: "string", description: "Same as image_generate." },
				width: { type: "integer", description: "Template substitution / preview default 1536." },
				height: { type: "integer", description: "Template substitution / preview default 1536." },
				steps: { type: "integer", description: "Default 25." },
				cfg: { type: "number", description: "Default 1.0." },
				seed: { type: "integer", description: "Default -1 (random)." },
				poll_seconds: {
					type: "integer",
					description: "Wait bound for /result (default 900)."
				},
				save_to: {
					type: "string",
					description: "Optional destination; omit to save all images into the configured output dir."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					properties: {
						prompt_id: { type: "string", required: true },
						images: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									filename: { type: "string" },
									url: { type: "string" },
									bytes: { type: "number" }
								}
							}
						},
						meta: { type: "object", additionalProperties: true, required: true },
						preflight: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text:
						`Generated ${value.images?.length ?? 0} image(s) via raw workflow (${value.meta?.source ?? "?"}, ${value.meta?.node_count ?? "?"} nodes` +
						(value.meta?.overrides_applied?.length ? `, overrides: ${value.meta.overrides_applied.join(",")}` : "") +
						`): ` + (value.images ?? []).map((i) => `${i.filename} (${fmtMB(i.bytes)})`).join(", ") +
						`; prompt_id=${value.prompt_id}` +
						// preflight 也要看得见：一切正常时原来什么都不印，验证者无法确认它真的返回了
						(value.preflight
							? `; queue before: ${value.preflight.queue_running ?? "?"} running / ${value.preflight.queue_pending ?? "?"} pending, free VRAM ${value.preflight.vram_free_gb ?? "?"}GB` +
								(value.preflight.engine_thermal ? `; engine ${value.preflight.engine_thermal}` : "")
							: "; preflight: none") +
						(value.preflight?.actions?.length ? `; auto-recovery: ${value.preflight.actions.join("; ")}` : "") +
						`; meta: ${JSON.stringify(value.meta)}`
				}]
			},
			timeoutMs: toolDeadlineMs,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const hasTemplate = typeof args.from_template === "string" && args.from_template !== "";
				const hasWorkflow = args.workflow !== undefined && args.workflow !== null;
				if (hasTemplate === hasWorkflow) {
					throw new Error(
						"Provide exactly one of `from_template` (resolve a gateway template) or `workflow` (a full API graph); " +
							`got ${hasTemplate ? "both" : "neither"}. Tip: image_workflow_inspect returns a ready-to-use graph.`
					);
				}
				// from_template 需要网关解析占位符；离线时直接说清楚，不让 callGateway 抛网络错误。
				if (hasTemplate) {
					if (String(config.generationBackend ?? "auto") === "direct") {
						throw new Error(
							"from_template resolves a gateway template, but generationBackend=direct forbids the gateway; " +
								"pass a full API graph via `workflow`, or set generationBackend=auto/gateway."
						);
					}
					const state = await gatewayHealth(config.gatewayUrl, exec?.signal);
					if (state === "gateway-down") {
						throw new Error(
							`from_template needs the external image gateway (${config.gatewayUrl}) because templates live there; ` +
								"for offline use pass a full API graph via `workflow` (built-in direct backend submits it to ComfyUI)."
						);
					}
				}

				// 1) 解析图
				let graph;
				let source;
				if (hasTemplate) {
					assertTemplateName(args.from_template);
					graph = await callGateway(
						config.gatewayUrl,
						`/debug/workflow/${encodeURIComponent(args.from_template)}?${templatePreviewQuery(args)}`,
						{ timeoutMs: 20000, signal: exec?.signal }
					);
					source = `template:${args.from_template}`;
				} else {
					if (typeof args.workflow !== "object" || Array.isArray(args.workflow)) {
						throw new Error("`workflow` must be an object keyed by node id (API format), e.g. the graph from image_workflow_inspect.");
					}
					graph = JSON.parse(JSON.stringify(args.workflow));
					source = "inline graph";
				}

				// 2) 按节点打补丁（巡检 → 改 → 提交 的便利路径）
				const overridesApplied = [];
				for (const [id, patch] of Object.entries(args.node_overrides ?? {})) {
					const node = graph[id];
					if (!node || typeof node !== "object") {
						throw new Error(
							`node_overrides refers to node "${id}", which is not in the graph. Available ids: ${Object.keys(graph).slice(0, 20).join(", ")}`
						);
					}
					if (patch && typeof patch === "object") {
						if (patch.inputs && typeof patch.inputs === "object") node.inputs = { ...(node.inputs ?? {}), ...patch.inputs };
						for (const [k, v] of Object.entries(patch)) if (k !== "inputs") node[k] = v;
						overridesApplied.push(id);
					}
				}

				// 3) 提交前自检：空图 / 残留占位符都会在引擎侧报晦涩错误，这里直接说清楚
				const nodes = graphNodes(graph);
				if (nodes.length === 0) {
					throw new Error("The workflow has no nodes with class_type — an API-format graph is required (image_workflow_inspect returns one).");
				}
				const placeholders = findPlaceholders(graph);
				if (placeholders.length > 0) {
					throw new Error(
						`The workflow still contains unresolved placeholders (${placeholders.join(", ")}) — those are template markers, not values. ` +
							`Use from_template (the gateway substitutes them), or take the resolved graph from image_workflow_inspect.`
					);
				}

				// 4) 内联图在离线/直连模式下直接提交 ComfyUI，不再依赖外部网关。
				// 复用 pickBackend 的判定（direct / gateway / auto），不要假设配置值一定是
				// 规范字符串——宿主配置代理或未知值曾让 raw 在网关离线时仍走 ensureBackendReady。
				if (!hasTemplate && (await pickBackend(config, "qwen_image_2_1_t2i", exec?.signal)) === "direct") {
					const startedAt = Date.now();
					const direct = await generateGraphDirect(
						{
							baseUrl: String(config.comfyBaseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, ""),
							startTimeoutSeconds: config.startTimeoutSeconds,
							idleFreeMinutes: config.vramIdleFreeMinutes,
							idleRecycle: config.idleRecycle
						},
						ctx,
						graph,
						{ signal: exec?.signal, timeoutMs: (args.poll_seconds ?? config.timeoutSeconds) * 1000 }
					);
					const { savedTo, saved, saveError } = await saveImages(direct.images, args.save_to, config.outputDir, await workingDirOf(ctx, exec));
					return {
						prompt_id: direct.prompt_id,
						images: direct.images,
						backend: "direct",
						...(savedTo ? { saved_to: savedTo } : {}),
						...(saved?.length ? { saved } : {}),
						...(saveError ? { save_error: saveError } : {}),
						meta: {
							source,
							template: null,
							node_count: nodes.length,
							overrides_applied: overridesApplied,
							placeholders_checked: true,
							backend: "direct",
							elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
						},
						preflight: null
					};
				}

				// 5) 预检/自愈（引擎或网关掉线时隐藏拉起）
				const preflight = await ensureBackendReady(config, ctx, exec?.signal);

				// 6) 提交（/raw 只回 prompt_id，图要自己轮询）
				const startedAt = Date.now();
				const submitted = await callGateway(config.gatewayUrl, "/raw", {
					method: "POST",
					body: graph,
					timeoutMs: 60000,
					signal: exec?.signal
				});
				const promptId = submitted?.prompt_id;
				if (!promptId) throw new Error(`Gateway /raw did not return a prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);

				// 7) 轮询结果（404 = 还没产出；404 不是错误，所以走 callGatewaySoft）
				const budgetMs = (args.poll_seconds ?? config.timeoutSeconds) * 1000;
				const deadline = Date.now() + budgetMs;
				let images = null;
				let lastStatus = "pending";
				let netErrors = 0;
				while (Date.now() < deadline) {
					await sleepAbortable(2000, exec?.signal);
					let res;
					try {
						res = await callGatewaySoft(config.gatewayUrl, `/result/${promptId}`, { timeoutMs: 20000, signal: exec?.signal });
						netErrors = 0;
					} catch (error) {
						rethrowIfAborted(error, exec?.signal);
						// 与 image_generate 同款——轮询网络抖动容忍连续少量失败，
						// 别把还在引擎里跑的任务判死（图片经此路径不可再取）
						if (++netErrors >= 5) throw error;
						continue;
					}
					if (res.status === 404) {
						lastStatus = "pending";
						continue;
					}
					if (!res.ok) {
						// ComfyUI 的 node_errors 就在 detail 里：原样透出，AI 能自己改图
						throw new Error(`Gateway GET /result/${promptId} -> HTTP ${res.status}: ${JSON.stringify(res.json?.detail ?? res.text).slice(0, 2000)}`);
					}
					if (res.json?.images?.length) {
						images = res.json.images;
						break;
					}
					lastStatus = res.json?.status ?? "running";
					// completed 且无图 = 终态——带原因立即失败，不空转整个 poll_seconds
					if (res.json?.status === "completed") {
						throw new Error(
							`Workflow ${promptId} reached terminal state "completed" with no images. ` +
								`The graph produced no output — check SaveImage/output nodes, or GET /result/${promptId} on the gateway.`
						);
					}
				}
				if (images === null) {
					throw new Error(
						`Workflow submitted (prompt_id ${promptId}) but no image within ${Math.round(budgetMs / 1000)}s (last status: ${lastStatus}). ` +
							`Raise poll_seconds for slow graphs; check the queue with comfy(action=status); the job may still finish later — GET /result/${promptId} on the gateway.`
					);
				}

				// 与 image_generate 同款：未指定 save_to 时把结果落进 Config.outputDir。
				const { savedTo, saved, saveError } = await saveImages(images, args.save_to, config.outputDir, await workingDirOf(ctx, exec));
				return {
					prompt_id: promptId,
					images,
					backend: "gateway",
					...(savedTo ? { saved_to: savedTo } : {}),
					...(saved?.length ? { saved } : {}),
					...(saveError ? { save_error: saveError } : {}),
					meta: {
						source,
						template: hasTemplate ? args.from_template : null,
						node_count: nodes.length,
						overrides_applied: overridesApplied,
						placeholders_checked: true,
						backend: "gateway",
						elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
					},
					preflight
				};
			}
		}));
	}

	ctx.tools.register(defineTool({
		name: "image_service_status",
		description: "Backend status: gateway, queue, VRAM, templates, tiers.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					gatewayUrl: { type: "string", required: true },
					up: { type: "boolean", required: true },
					error: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
					queue: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true },
				workflows: { type: "array", items: { type: "string" }, required: true },
				tiers: { type: "object", additionalProperties: true, required: true },
				diagnostics: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.up
					? `Gateway ${value.gatewayUrl}: up; running=${value.queue?.queue_running}, pending=${value.queue?.queue_pending}, ` +
						`free VRAM=${value.queue?.vram?.free_vram_gb ?? "?"}GB, ComfyUI ${value.queue?.comfyui_version ?? "?"}, ` +
						`templates: ${(value.workflows ?? []).join(", ")}; tiers: ${Object.keys(value.tiers ?? {}).join(", ") || "(none)"}` +
						(value.diagnostics?.tierError ? ` [tier table ERROR: ${value.diagnostics.tierError}]` : "")
					// 网关是可选组件：先说「不需要它也能出图」，再报它掉了——
					// 旧文案以 “Gateway DOWN” 开头，用户第一眼以为整个生图挂了。
					: `Built-in direct backend: text-to-image and reference-image editing work without the gateway ` +
						`(templates: ${(value.direct_templates ?? []).join(", ") || "(none)"}).\n` +
						`Gateway ${value.gatewayUrl} (optional; only legacy prompt-enhancer/ControlNet/VNCCS templates need it): DOWN (${value.error})\n` +
						`  tiers (local presets): ${Object.keys(value.tiers ?? {}).join(", ") || "(none)"}\n` +
						`  engine: ${value.engine_up === true ? "up" : value.engine_installed === false ? `NOT INSTALLED @ ${value.engine_root ?? ENGINE_ROOT}` : "down"}\n` +
						`  ${value.note ?? ""}\n` +
						`  gateway log tail: ${value.diagnostics?.gatewayLogTail || "(none)"}\n` +
						`  engine log tail: ${value.diagnostics?.engineLogTail || "(none — logs are written only when this plugin starts the engine)"}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(_args, exec) {
			// 没有窗口可看，所以状态工具自己把日志尾部带上；容器差异在下面 catch 里降级返回。
			const diagnostics = {
				gatewayLogTail: tailFile(path.join(GATEWAY_LOG_DIR, "gateway.err.log"), 6) || tailFile(path.join(GATEWAY_LOG_DIR, "gateway.log"), 6) || null,
				engineLogTail: engineLogTail(6) || null,
				// 档位表损坏时随 status 透出（可诊断），不带 tier 的生成不受影响
				tierError: TIERS_LOAD_ERROR
			};
			try {
				const [queue, workflows] = await Promise.all([
					callGateway(config.gatewayUrl, "/status", { timeoutMs: 15000, signal: exec?.signal }),
					callGateway(config.gatewayUrl, "/workflows", { timeoutMs: 15000, signal: exec?.signal })
				]);
				return { gatewayUrl: config.gatewayUrl, up: true, error: null, queue, workflows: workflows.workflows ?? [], tiers: TIERS, diagnostics };
			} catch (error) {
				// 取消必须原样上抛（官方硬性规则）；真实故障则降级成「可诊断的结果」而不是抛错。
				rethrowIfAborted(error, exec?.signal);
				// 网关不在时，插件自带的内置直连仍能出图——状态里必须说清楚，
				// 否则用户会以为整个生图功能挂了。
				let engineUp = false;
				try {
					const res = await fetch(`${String(config.comfyBaseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, "")}/system_stats`, {
						signal: AbortSignal.any([AbortSignal.timeout(3000), ...(exec?.signal ? [exec.signal] : [])])
					});
					engineUp = res.ok;
				} catch {
					engineUp = false;
				}
				const engineInstalled = existsSync(path.join(ENGINE_ROOT, "python_embeded", "python.exe"));
				const detected = engineInstalled ? [] : detectComfyUiInstalls();
				return {
					gatewayUrl: config.gatewayUrl,
					up: false,
					error: String(error?.message ?? error).slice(0, 400),
					queue: null,
					workflows: [],
					tiers: TIERS,
					tiers_source: "local",
					backend: "direct",
					engine_up: engineUp,
					engine_installed: engineInstalled,
					engine_root: ENGINE_ROOT,
					detected_engines: detected,
					direct_templates: [...DIRECT_TEMPLATES],
					note: engineUp
						? "ComfyUI engine is up; only the optional gateway is missing."
						: engineInstalled
							? "ComfyUI engine is installed but not responding: start it with comfy (action=control, op=start)."
							: `ComfyUI engine is not installed${detected.length > 0 ? ` — an existing ComfyUI was found at ${detected.map((item) => item.path).join(", ")} (set engineRoot / IMAGEKIT_ENGINE_DIR to reuse it, no download)` : ""}. Install it with image_setup (action=install, component=engine) or point baseUrl at a ComfyUI you start yourself.`,
					diagnostics
				};
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "image_prompt_guide",
		description:
			"Shipped prompt handbook: tiers, styles, on-image text, edits, upscale, limits.",
		parameters: {
			section: {
				type: "string",
				description: "Optional keyword (zh or en, e.g. text/edit/upscale); omit = whole handbook."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					section: { type: "string", required: true },
					requested: { type: "string", required: true },
					matched: { type: "boolean", required: true },
					topics: { type: "array", items: { type: "string" }, required: true },
					content: { type: "string", required: true },
					unavailable_tools: { type: "array", items: { type: "string" }, required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text:
					`sections: ${(value.topics ?? []).join(" · ")}` +
					(value.matched
						? `\n(returned: ${value.section})`
						: value.requested
							? `\n(no section matched "${value.requested}"; no body returned — pick one of the sections above, or call without section for the full handbook)`
							: "") +
					(value.unavailable_tools?.length
						? `\n\n[minimal profile] these tools are not registered (need standard/all): ${value.unavailable_tools.join(", ")}`
						: "") +
					`\n\n${value.content}`
			}]
		},
		timeoutMs: 10000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const markdown = readPromptGuide();
			const topics = promptGuideTopics(markdown);
			const { content, matched } = slicePromptGuide(markdown, args?.section);
			const unavailableTools = includeAdvanced
				? []
				: ["image_generate_raw", "image_workflow_inspect", "image_resize_lanczos", "image_flatten_alpha", "image_mark_region", "anim_encode", "pose_check"];
			return {
				section: matched ? String(args.section).trim() : "",
				requested: String(args?.section ?? "").trim(),
				matched,
				topics,
				content,
				unavailable_tools: unavailableTools
			};
		}
	}));
}
