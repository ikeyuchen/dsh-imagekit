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

const { resolveTemplateForRefs, readPromptGuide, promptGuideTopics, slicePromptGuide } = await import("../lib/generate/tools.js");

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

console.log("image_prompt_guide（随包手册）");

const guide = readPromptGuide();

check("手册随包存在且不是空壳", () => {
	assert.ok(guide.length > 3000, `len=${guide.length}`);
});

check("小节 ≥ 8 个且覆盖关键主题", () => {
	const topics = promptGuideTopics(guide);
	assert.ok(topics.length >= 8, `topics=${topics.length}`);
	for (const key of ["选档", "文字", "参考图编辑", "放大", "边界", "排查"]) {
		assert.ok(topics.some((t) => t.includes(key)), `缺少小节：${key}`);
	}
});

check("按关键字只返回命中小节", () => {
	const { content, matched } = slicePromptGuide(guide, "文字");
	assert.equal(matched, true);
	assert.ok(content.startsWith("## "));
	assert.ok(content.includes("幻觉字块"));
	assert.ok(!content.includes("## 7."));
});

check("未命中关键字回退全文（不报错也不空返回）", () => {
	const { content, matched } = slicePromptGuide(guide, "不存在的主题");
	assert.equal(matched, false);
	assert.equal(content, guide);
});

check("手册自包含：不引用 DSH 技能", () => {
	assert.ok(!/qwen-image-cookbook|SKILL\.md/.test(guide));
});

console.log("turbo 图构建（官方 8 步 / LoRA 回退）");

const { buildOfficialTurboT2IGraph, buildT2IGraph, OFFICIAL_TURBO_SIGMAS, OFFICIAL_TURBO_STEPS } = await import(
	"../lib/generate/direct.js"
);
const fakeModels = {
	unet: "base.safetensors",
	unetTurbo: "turbo.safetensors",
	clip: "clip.safetensors",
	clipType: "qwen_image",
	vae: "vae.safetensors",
	lora: "turbo-lora.safetensors"
};

check("官方 turbo 图：8 步 sigma 表 + CFGGuider + SamplerCustomAdvanced，且不挂 LoRA", () => {
	const g = buildOfficialTurboT2IGraph({ models: fakeModels, prompt: "x", width: 1056, height: 1056, seed: 1 });
	assert.equal(OFFICIAL_TURBO_SIGMAS.split(",").length, OFFICIAL_TURBO_STEPS + 1);
	assert.equal(g["7"].class_type, "CFGGuider");
	assert.equal(g["11"].class_type, "SamplerCustomAdvanced");
	assert.deepEqual(g["11"].inputs.latent_image, ["6", 0]);
	assert.equal(g["1"].inputs.unet_name, "turbo.safetensors");
	assert.ok(!Object.values(g).some((n) => n.class_type === "LoraLoaderModelOnly"), "官方协议不应挂 LoRA");
});

check("无 turbo 模型时回退 base + turbo LoRA", () => {
	const g = buildT2IGraph({
		models: { ...fakeModels, unetTurbo: null },
		prompt: "x",
		width: 512,
		height: 512,
		steps: 6,
		cfg: 1,
		seed: 1,
		turbo: true
	});
	assert.equal(g["1"].inputs.unet_name, "base.safetensors");
	const lora = Object.values(g).find((n) => n.class_type === "LoraLoaderModelOnly");
	assert.ok(lora, "应挂 LoraLoaderModelOnly");
});

console.log(`\n✓ ${passed} 项断言通过`);
