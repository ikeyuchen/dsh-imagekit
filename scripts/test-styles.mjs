/**
 * test-styles.mjs
 * ================
 * 离线断言：风格预设（lib/generate/styles.js + 插件根 styles.json）。
 *
 * 锁住四件事：
 *   1) 随包 styles.json 结构完好、每条都是一句带 {prompt} 的骨架（不是关键词表）；
 *   2) 表损坏/字段拼错/缺占位符 → 显式报错，绝不静默当「没有风格」；
 *   3) 短提示词整句套、长提示词只追加后缀（不重复前缀、不挤压用户原句）；
 *   4) 风格自带的负面词：cfg ≤ 1 时如实标注 style_negative_applied=false（负条件被乘 0）。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { loadStyles, composeStyledPrompt, resolveStyleArgs, promptUnits, STYLE_PLACEHOLDER } = await import("../lib/generate/styles.js");

let passed = 0;
const check = (label, fn) => {
	fn();
	console.log(`  ✓ ${label}`);
	passed += 1;
};

const stylesUrl = new URL("../styles.json", import.meta.url);
const { styles: PACK_STYLES, error: PACK_ERROR } = loadStyles(stylesUrl);

console.log("styles.json（随包表）");

check("随包表能加载且无错误", () => {
	assert.equal(PACK_ERROR, null);
	assert.ok(Object.keys(PACK_STYLES).length >= 7, `期望至少 7 条风格，实际 ${Object.keys(PACK_STYLES).length}`);
});

check("每条都有 description，且模板是单行、含 {prompt}、不超长", () => {
	for (const [name, preset] of Object.entries(PACK_STYLES)) {
		assert.equal(typeof preset.description, "string", `${name} 缺 description`);
		assert.ok(preset.description.trim() !== "", `${name}.description 为空`);
		assert.ok(preset.template.includes(STYLE_PLACEHOLDER), `${name}.template 缺占位符`);
		assert.ok(!/[\r\n]/.test(preset.template), `${name}.template 不是单行`);
		assert.ok(preset.template.length <= 400, `${name}.template 超长`);
	}
});

check("模板里不出现对 2.1 无效的质量词（8K / masterpiece / award-winning）", () => {
	for (const [name, preset] of Object.entries(PACK_STYLES)) {
		const text = `${preset.template} ${preset.negative ?? ""}`.toLowerCase();
		assert.ok(!/(8k|masterpiece|award-winning|best quality|ultra detailed)/.test(text), `${name} 含质量词`);
	}
});

check("每条风格挨个套一遍：占位符被替换干净、用户描述原样保留", () => {
	for (const [name, preset] of Object.entries(PACK_STYLES)) {
		const out = composeStyledPrompt(preset.template, "一只戴草帽的猫坐在窗台上");
		assert.ok(!out.includes(STYLE_PLACEHOLDER), `${name} 套完仍残留占位符`);
		assert.ok(out.includes("一只戴草帽的猫坐在窗台上"), `${name} 丢了用户描述`);
	}
});

check("两条画面工程化预设守住语义：clean-cel 分图层、design-dense 有前景遮挡", () => {
	assert.ok(/不出现笔触/.test(PACK_STYLES["clean-cel"].template), "clean-cel 缺「人物不出现笔触」");
	assert.ok(/背景/.test(PACK_STYLES["clean-cel"].template), "clean-cel 没把笔触留给背景");
	assert.ok(/前景/.test(PACK_STYLES["design-dense"].template), "design-dense 缺前景遮挡");
	assert.ok(/悬浮颗粒/.test(PACK_STYLES["design-dense"].template), "design-dense 缺空气层");
});

console.log("\nloadStyles（数据完整性闸门）");

const MAX_TMP = path.join(".verify-cache", "styles-test");
mkdirSync(MAX_TMP, { recursive: true });
const tmp = (name, content) => {
	const file = path.join(MAX_TMP, name);
	writeFileSync(file, content, "utf8");
	return path.resolve(file);
};

check("未知字段 → 报错（拼错的键不许静默无效）", () => {
	const { error } = loadStyles(tmp("unknown-field.json", JSON.stringify({ x: { description: "d", template: "{prompt}，光", templte: "y" } })));
	assert.match(error, /unknown field "templte"/);
});

check("缺 {prompt} 占位符 → 报错", () => {
	const { error } = loadStyles(tmp("no-placeholder.json", JSON.stringify({ x: { description: "d", template: "一张照片，自然光。" } })));
	assert.match(error, /must contain \{prompt\}/);
});

check("多行模板 → 报错（一句话不该换行）", () => {
	const { error } = loadStyles(tmp("multiline.json", JSON.stringify({ x: { description: "d", template: "第一行{prompt}\n第二行" } })));
	assert.match(error, /single line/);
});

check("空表 → 报错", () => {
	const { error } = loadStyles(tmp("empty.json", "{}"));
	assert.match(error, /no styles defined/);
});

check("允许的字段名大小写/下划线拼错也会被点出来", () => {
	const { error } = loadStyles(tmp("bad-name.json", JSON.stringify({ "Realistic": { description: "d", template: "{prompt}" } })));
	assert.match(error, /bare lowercase name/);
});

console.log("\ncomposeStyledPrompt（短句套整句 / 长句只追加后缀）");

const tpl = "一张写实照片：{prompt}，85mm 镜头与浅景深，自然光。";

check("短句：前缀 + 描述 + 后缀", () => {
	assert.equal(composeStyledPrompt(tpl, "一位修表匠在工作台前"), "一张写实照片：一位修表匠在工作台前，85mm 镜头与浅景深，自然光。");
});

check("长句（>120 单元）：不重复前缀，只追加后缀", () => {
	const long = "一位修表匠坐在靠窗的工作台前，右手捏着镊子调整游丝，桌上散落着齿轮、放大镜与一杯凉透的茶。".repeat(5);
	assert.ok(promptUnits(long) > 120, "测试用长句应超过阈值");
	const out = composeStyledPrompt(tpl, long);
	assert.ok(out.startsWith(long), "长句应保持用户原句开头");
	assert.ok(!out.startsWith("一张写实照片："), "长句不应再套前缀");
	assert.ok(out.endsWith("85mm 镜头与浅景深，自然光。"), "后缀应保留");
});

check("骨架以 {prompt} 结尾（无后缀）时，长句也整句套，不丢风格", () => {
	const bare = "水墨风格：{prompt}";
	const long = "山水".repeat(80);
	const out = composeStyledPrompt(bare, long);
	assert.ok(out.startsWith("水墨风格："), "无后缀时必须保留前缀，否则风格整个丢掉");
});

check("promptUnits：汉字逐字计、英文按词计", () => {
	assert.equal(promptUnits("窗边的猫"), 4);
	assert.equal(promptUnits("a cat by the window"), 5);
	assert.equal(promptUnits("窗边的猫 a cat"), 4 + 2);
});

console.log("\nresolveStyleArgs（应用与报错）");

const STYLES = { realistic: { description: "写实", template: tpl, negative: "插画感, 平涂" } };

check("未传 style：原样返回，prompt 不被包裹", () => {
	const out = resolveStyleArgs(STYLES, null, { prompt: "一只猫", negative: "模糊", cfg: 1 });
	assert.equal(out.prompt, "一只猫");
	assert.equal(out.negative_prompt, "模糊");
	assert.equal(out.style, null);
	assert.equal(out.style_negative_applied, false);
});

check("未知 style → 报错并列出可用风格（不静默回退）", () => {
	assert.throws(
		() => resolveStyleArgs(STYLES, null, { style: "cinematic", prompt: "一只猫" }),
		(error) => /Unknown style "cinematic"/.test(error.message) && /Available styles: realistic/.test(error.message) && /No silent fallback/.test(error.message)
	);
});

check("表损坏 + 显式 style → 报错指向 styles.json 的修法", () => {
	assert.throws(
		() => resolveStyleArgs({}, "boom", { style: "realistic", prompt: "一只猫" }),
		(error) => /styles.json failed to load \(boom\)/.test(error.message) && /restart DSH/.test(error.message)
	);
});

check("style 传空串/非字符串 → 报错（不当作未传）", () => {
	for (const bad of ["", "   ", 42, {}]) {
		assert.throws(() => resolveStyleArgs(STYLES, null, { style: bad, prompt: "一只猫" }), /Invalid style/);
	}
});

check("负面词合并：用户词在前，风格词在后", () => {
	const out = resolveStyleArgs(STYLES, null, { style: "realistic", prompt: "一只猫", negative: "手部畸形", cfg: 1 });
	assert.equal(out.negative_prompt, "手部畸形, 插画感, 平涂");
});

check("用户负面词已包含风格词时不重复拼接", () => {
	const out = resolveStyleArgs(STYLES, null, { style: "realistic", prompt: "一只猫", negative: "插画感, 平涂", cfg: 1 });
	assert.equal(out.negative_prompt, "插画感, 平涂");
});

check("cfg=1 → style_negative_applied=false（负条件被乘 0，不许假装生效）", () => {
	assert.equal(resolveStyleArgs(STYLES, null, { style: "realistic", prompt: "猫", cfg: 1 }).style_negative_applied, false);
	assert.equal(resolveStyleArgs(STYLES, null, { style: "realistic", prompt: "猫", cfg: undefined }).style_negative_applied, false);
});

check("cfg=2 → style_negative_applied=true", () => {
	assert.equal(resolveStyleArgs(STYLES, null, { style: "realistic", prompt: "猫", cfg: 2 }).style_negative_applied, true);
});

console.log(`\n✓ ${passed} 项断言通过`);
