/**
 * 档位注册表（tier presets）—— v1.5.0
 * ==========================================
 * 借鉴 dsh-short-video-studio 的「能力注册表」架构：工具面只说 tier
 * （draft / standard / quality），不说模板名不说参数组合；具体映射放在插件根
 * 目录的 tiers.json —— 增删档位 = 改一份 JSON，不动代码（重启 DSH 生效）。
 *
 * 纪律（同源借鉴）：未知档位、档位表损坏 → 显式报错，绝不静默回退到别的档位。
 *
 * 本模块刻意零外部依赖（不 import dsh-tools / schemastery），
 * selftest 可单独加载做离线断言。
 */
import { readFileSync } from "node:fs";

/** 档位预设可声明、且会被展开进调用参数的字段。 */
export const TIER_FIELDS = ["template", "width", "height", "steps", "cfg"];
/** 仅展示用、不参与参数展开的字段。 */
const META_FIELDS = ["description"];
/**
 * 单层名字，杜绝路径穿越；并兑现错误信息一直声称的规则——
 * 不许 _api.json 后缀、不许前导/尾随/连续点号（裸 "." / ".." 自然被拒）。
 * 从模块导出，tools.js 的 assertTemplateName 复用同一份定义，不再手工拷贝第二份。
 */
export const TEMPLATE_NAME_RE = /^(?![.])(?!.*\.\.)(?!.*[.]$)[A-Za-z0-9._-]+(?<!_api\.json)$/;

/**
 * 读取并校验 tiers.json。
 * 返回 { tiers, error }：结构完好时 error 为 null；文件缺失/损坏/校验不过时
 * tiers 为空表、error 带原因 —— **不抛错、也不静默给默认档位**：核心生成路径
 * （不带 tier 的调用）不受影响，带 tier 的调用会拿到一条指明修法的显式错误。
 */
export function loadTiers(fileUrl) {
	try {
		const parsed = JSON.parse(readFileSync(fileUrl, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("root must be an object mapping tier names to presets");
		}
		if (Object.keys(parsed).length === 0) throw new Error("no tiers defined");
		for (const [name, preset] of Object.entries(parsed)) {
			if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
				throw new Error(`tier "${name}" must be an object`);
			}
			if (typeof preset.template !== "string" || !TEMPLATE_NAME_RE.test(preset.template)) {
				throw new Error(`tier "${name}" needs a valid "template" (bare name: [A-Za-z0-9._-], no path, no _api.json, no leading/trailing/double dots)`);
			}
			for (const [key, value] of Object.entries(preset)) {
				if (!TIER_FIELDS.includes(key) && !META_FIELDS.includes(key)) {
					throw new Error(
						`tier "${name}" has unknown field "${key}" (allowed: ${[...TIER_FIELDS, ...META_FIELDS].join(", ")})`
					);
				}
				if (TIER_FIELDS.includes(key) && key !== "template") {
					// loadTiers 是 tiers.json 的数据完整性闸门——只查 typeof 会放过
					// 0/负数/小数尺寸与 Infinity（1e400），这些值会无条件展开直达 API 边界
					const valid =
						key === "cfg"
							? typeof value === "number" && Number.isFinite(value) && value > 0
							: typeof value === "number" && Number.isInteger(value) && value > 0;
					if (!valid) {
						throw new Error(`tier "${name}".${key} must be ${key === "cfg" ? "a positive finite number" : "a positive integer"}`);
					}
				}
			}
		}
		return { tiers: parsed, error: null };
	} catch (error) {
		return { tiers: {}, error: String(error?.message ?? error) };
	}
}

/**
 * 把 args.tier 展开成具体参数。
 * 优先级（高 → 低）：**显式传参 > 档位预设 > 工具默认值**
 * （tier 是便捷预设不是笼子 —— 调用方仍可逐字段覆盖，如 tier:"draft" + steps:8）。
 *
 * 返回 { args: 展开后的参数（已删 tier 键）, tier: 档位名或 null, applied: 预设实际填充的字段 }。
 * applied 让「预设到底生效了什么」可取证（随结果返回、render 文本可见），不靠猜。
 */
export function resolveTierArgs(tiers, tiersError, args) {
	const raw = args?.tier;
	// 只有 undefined/null 表示「未传档位」——空串/非字符串是调用方 bug，
	// 静默当未传会掩盖它，还让 tier:"" 残留在下传参数里（模块纪律：绝不静默回退）
	if (raw === undefined || raw === null) return { args, tier: null, applied: [] };
	if (typeof raw !== "string" || raw === "") {
		throw new Error(
			`Invalid tier ${JSON.stringify(raw)}: tier must be a non-empty preset name` +
				(tiersError ? ` (tiers.json failed to load: ${tiersError})` : ` (available: ${Object.keys(tiers).join(", ") || "none"})`) +
				". No silent fallback."
		);
	}
	if (tiersError) {
		throw new Error(
			`tier presets unavailable: tiers.json failed to load (${tiersError}). ` +
				`Fix tiers.json (plugin root) and restart DSH, or call without tier using explicit template/steps/width/height.`
		);
	}
	const preset = tiers[raw];
	if (preset === undefined) {
		throw new Error(
			`Unknown tier ${JSON.stringify(raw)}. Available tiers: ${Object.keys(tiers).join(", ")} ` +
				`(presets with parameters via image_service_status). No silent fallback.`
		);
	}
	const resolved = { ...args };
	const applied = [];
	for (const field of TIER_FIELDS) {
		const given = args[field];
		if (given === undefined) {
			if (preset[field] !== undefined) {
				resolved[field] = preset[field];
				applied.push(field);
			}
		} else if (given === null) {
			// null 从来不是这些字段的合法值——视同未传，由预设填充；
			// 预设也没有就剔除，不让 width:null 绕过档位预设再把 null 原样下传
			if (preset[field] !== undefined) {
				resolved[field] = preset[field];
				applied.push(field);
			} else {
				delete resolved[field];
			}
		}
	}
	delete resolved.tier;
	return { args: resolved, tier: raw, applied };
}
