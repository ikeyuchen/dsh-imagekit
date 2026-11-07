/**
 * test-prompt-routing.mjs
 * =======================
 * 离线断言：参考图 × 模板 的路由决策（lib/generate/tools.js 的 resolveTemplateForRefs）。
 *
 * 背景：t2i 模板根本不吃 ref_images，网关会静默忽略——用户说“把这张图的猫改成狗”
 * 却生成一张无关新图。这条测试锁住三件事：
 *   1) 无参考图 → 模板原样不动；
 *   2) 有参考图 + 没显式指定模板 → 自动切到编辑模板；
 *   3) 有参考图 + 显式给了 t2i 模板 → 显式报错（不静默纠正用户意图）。
 */
import assert from "node:assert/strict";

const { resolveTemplateForRefs } = await import("../lib/generate/tools.js");

let passed = 0;
const check = (label, fn) => {
	fn();
	console.log(`  ✓ ${label}`);
	passed += 1;
};

console.log("resolveTemplateForRefs");

check("无参考图：模板保持不变", () => {
	const out = resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_t2i", explicitTemplate: undefined, refCount: 0 });
	assert.equal(out.template, "qwen_image_2_1_t2i");
	assert.equal(out.switched, false);
});

check("有参考图 + 未指定模板：自动切到编辑模板", () => {
	const out = resolveTemplateForRefs({ effectiveTemplate: undefined, explicitTemplate: undefined, refCount: 2 });
	assert.equal(out.template, "qwen_image_2_1_edit");
	assert.equal(out.switched, true);
});

check("有参考图 + 档位给了 t2i_turbo：也自动切到编辑模板", () => {
	const out = resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_t2i_turbo", explicitTemplate: undefined, refCount: 1 });
	assert.equal(out.template, "qwen_image_2_1_edit");
	assert.equal(out.switched, true);
});

check("有参考图 + 已是编辑模板：不切换", () => {
	const out = resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_edit3", explicitTemplate: "qwen_image_2_1_edit3", refCount: 1 });
	assert.equal(out.template, "qwen_image_2_1_edit3");
	assert.equal(out.switched, false);
});

check("有参考图 + 显式 t2i 模板：显式报错并给出改法", () => {
	assert.throws(
		() => resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_t2i", explicitTemplate: "qwen_image_2_1_t2i", refCount: 1 }),
		(err) => /ignores ref_images/.test(err.message) && err.message.includes("qwen_image_2_1_edit")
	);
});

check("turbo_official_t2i 同样被判为纯文生图", () => {
	assert.throws(
		() => resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_turbo_official_t2i", explicitTemplate: "qwen_image_2_1_turbo_official_t2i", refCount: 1 }),
		(err) => /ignores ref_images/.test(err.message)
	);
});

console.log(`\n✓ ${passed} 项断言通过`);
