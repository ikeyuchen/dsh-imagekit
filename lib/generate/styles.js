/**
 * 风格预设（style presets）—— v1.6.0
 * ======================================
 * 与 tiers.json（档位：尺寸/步数/模板）正交：档位决定「画多大、跑几步」，
 * 风格决定「一句话怎么说」。表外置在插件根 styles.json，增删风格 = 改 JSON，不动代码。
 *
 * 为什么是「一句骨架」而不是关键词表：Qwen-Image 2.1 是长描述模型，
 * 手册 §1 明确要求 60–150 词的连贯描述、不要堆标签；SDXL 时代那种
 * `cinematic lighting, 8k, masterpiece` 的词库搬过来会掉细节（quality 词对 2.1 无效）。
 * 所以每条风格 = 一句带 {prompt} 占位的完整骨架，和手册 §2「分类配方」同构。
 *
 * 纪律（与 tiers.js 同源）：未知风格、表损坏 → 显式报错带可用列表，
 * 绝不静默回退到「无风格」——静默回退等于让调用方以为预设生效了。
 *
 * 本模块零外部依赖，selftest 可单独加载做离线断言。
 */
import { readFileSync } from "node:fs";

/** 风格条目允许的字段（多一个就报错：拼错的键静默无效最难查）。 */
export const STYLE_FIELDS = ["description", "template", "negative", "tags"];
/** 单层名字：小写字母开头，只含小写字母/数字/下划线/连字符。 */
export const STYLE_NAME_RE = /^[a-z][a-z0-9_-]*$/;
/** 骨架里的替换占位符（沿用 Fooocus apply_style 的 `{prompt}` 约定）。 */
export const STYLE_PLACEHOLDER = "{prompt}";
/**
 * 「长提示词」阈值（汉字算 1 单元、英文词算 1 单元）。
 * 短句套整句骨架最顺；超过阈值的描述已经被用户写足了，再套前缀会出现
 * 「一张写实照片：一张写实照片…」这种重复，并挤压用户自己的首句。
 */
const LONG_PROMPT_UNITS = 120;
const MAX_TEMPLATE_CHARS = 400;

/** 把提示词折算成信息单元数：CJK 逐字计 1，其余按英文单词计 1。 */
export function promptUnits(text) {
	const str = String(text ?? "");
	const cjk = (str.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
	const latin = (str.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
	return cjk + latin;
}

/**
 * 读取并校验 styles.json。
 * 返回 { styles, error }：结构完好时 error 为 null；文件缺失/损坏/校验不过时
 * styles 为空表、error 带原因 —— 不抛错、也不静默当作「没有风格」：
 * 核心生成路径（不带 style 的调用）不受影响，带 style 的调用会拿到指明修法的显式错误。
 */
export function loadStyles(fileUrl) {
	try {
		const parsed = JSON.parse(readFileSync(fileUrl, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("root must be an object mapping style names to presets");
		}
		const names = Object.keys(parsed);
		if (names.length === 0) throw new Error("no styles defined");
		for (const [name, preset] of Object.entries(parsed)) {
			if (!STYLE_NAME_RE.test(name)) {
				throw new Error(`style "${name}" must be a bare lowercase name ([a-z][a-z0-9_-]*)`);
			}
			if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
				throw new Error(`style "${name}" must be an object`);
			}
			for (const [key, value] of Object.entries(preset)) {
				if (!STYLE_FIELDS.includes(key)) {
					throw new Error(`style "${name}" has unknown field "${key}" (allowed: ${STYLE_FIELDS.join(", ")})`);
				}
				if (key === "template") {
					if (typeof value !== "string" || value.trim() === "") {
						throw new Error(`style "${name}".template must be a non-empty string`);
					}
					if (!value.includes(STYLE_PLACEHOLDER)) {
						throw new Error(`style "${name}".template must contain ${STYLE_PLACEHOLDER} (where the caller's prompt goes)`);
					}
					if (value.length > MAX_TEMPLATE_CHARS) {
						throw new Error(`style "${name}".template is ${value.length} chars (max ${MAX_TEMPLATE_CHARS}): keep it one sentence`);
					}
					if (/[\r\n]/.test(value)) {
						throw new Error(`style "${name}".template must be a single line (no newlines in a prompt sentence)`);
					}
				} else if (key === "negative") {
					if (typeof value !== "string") throw new Error(`style "${name}".negative must be a string`);
				} else if (key === "description") {
					if (typeof value !== "string" || value.trim() === "") {
						throw new Error(`style "${name}".description must be a non-empty string`);
					}
				} else if (key === "tags") {
					if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
						throw new Error(`style "${name}".tags must be an array of non-empty strings`);
					}
				}
			}
		}
		return { styles: parsed, error: null };
	} catch (error) {
		return { styles: {}, error: String(error?.message ?? error) };
	}
}

/**
 * 把 {prompt} 套进风格骨架。
 * 短提示词 → 整句套（前缀 + 用户描述 + 后缀）；
 * 长提示词 → 只追加 {prompt} 之后的部分，不重复前缀、不挤压用户自己的开头；
 * 骨架没有后缀（以 {prompt} 结尾）时退回整句套，否则长提示词会完全丢掉风格。
 */
export function composeStyledPrompt(template, prompt) {
	const tpl = String(template ?? "");
	const body = String(prompt ?? "").trim();
	const at = tpl.indexOf(STYLE_PLACEHOLDER);
	const prefix = at === -1 ? "" : tpl.slice(0, at);
	const suffix = at === -1 ? "" : tpl.slice(at + STYLE_PLACEHOLDER.length);
	if (suffix.trim() === "" || promptUnits(body) <= LONG_PROMPT_UNITS) return `${prefix}${body}${suffix}`;
	return `${body}${suffix}`;
}

/**
 * 解析并应用 style：
 * 返回 { prompt, negative_prompt, style, style_negative_applied }。
 * 未传 style → 原样返回（prompt 不被任何东西包裹，这条路径不引入任何变化）。
 * cfg ≤ 1 时负条件被乘 0，风格自带的 negative 写了也不生效——照旧并入
 * negative_prompt（成本为零），但用 style_negative_applied=false 如实标注，
 * 免得调用方与用户以为它在起作用。
 */
export function resolveStyleArgs(styles, stylesError, { style, prompt, negative, cfg } = {}) {
	const raw = style;
	const base = { prompt, negative_prompt: negative ?? "", style: null, style_negative_applied: false };
	if (raw === undefined || raw === null) return base;
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error(
			`Invalid style ${JSON.stringify(raw)}: style must be a non-empty preset name` +
				(stylesError ? ` (styles.json failed to load: ${stylesError})` : ` (available: ${Object.keys(styles).join(", ") || "none"})`) +
				". No silent fallback."
		);
	}
	if (stylesError) {
		throw new Error(
			`style presets unavailable: styles.json failed to load (${stylesError}). ` +
				"Fix styles.json (plugin root) and restart DSH, or call without style."
		);
	}
	const preset = styles[raw];
	if (preset === undefined) {
		throw new Error(
			`Unknown style ${JSON.stringify(raw)}. Available styles: ${Object.keys(styles).join(", ") || "none"} ` +
				"(presets with their templates via image_service_status). No silent fallback."
		);
	}
	const styledPrompt = composeStyledPrompt(preset.template, prompt);
	const extra = typeof preset.negative === "string" ? preset.negative.trim() : "";
	const userNegative = typeof negative === "string" ? negative.trim() : "";
	let merged = userNegative;
	if (extra !== "") merged = merged === "" || merged.includes(extra) ? merged || extra : `${merged}, ${extra}`;
	// cfg 缺省按工具默认 1.0 算（CFGGuider 的 cfg=1 即无分类器引导，负条件不参与）
	const cfgValue = Number(cfg);
	const applies = Number.isFinite(cfgValue) ? cfgValue > 1 : false;
	return { prompt: styledPrompt, negative_prompt: merged, style: raw, style_negative_applied: applies };
}
