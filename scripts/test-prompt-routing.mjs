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

const { resolveTemplateForRefs, applyDefaultTier, resolveSeed, assertImageSize, formatMetaLine, readPromptGuide, promptGuideTopics, slicePromptGuide, workflowSeeds, workflowDigest } = await import("../lib/generate/tools.js");

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

check("有参考图 + 未指定模板：自动切到编辑模板（单图）", () => {
	const out = resolveTemplateForRefs({ effectiveTemplate: undefined, explicitTemplate: undefined, refCount: 1 });
	assert.equal(out.template, "qwen_image_2_1_edit");
	assert.equal(out.switched, true);
});

check("3 张参考图 → edit3，4 张以上 → edit6", () => {
	assert.equal(resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_t2i", explicitTemplate: undefined, refCount: 3 }).template, "qwen_image_2_1_edit3");
	assert.equal(resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_t2i", explicitTemplate: undefined, refCount: 4 }).template, "qwen_image_2_1_edit6");
});

check("denoise < 1 + 单图 → i2i（只有 i2i 模板吃 denoise）", () => {
	const out = resolveTemplateForRefs({ effectiveTemplate: "qwen_image_2_1_t2i", explicitTemplate: undefined, refCount: 1, denoise: 0.8 });
	assert.equal(out.template, "qwen_image_2_1_i2i");
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

check("未命中关键字不再回退全文（避免 14 倍上下文）", () => {
	const { content, matched } = slicePromptGuide(guide, "不存在的主题");
	assert.equal(matched, false);
	assert.equal(content, "");
});

check("英文/近义 section 关键字能命中中文小节", () => {
	for (const [key, expected] of [
		["text", "## 3."],
		["edit", "## 4."],
		["upscale", "## 5."],
		["limits", "## 7."],
		["troubleshoot", "## 8."],
		["tier", "## 0."],
		["写实", "## 2."],
		["poster", "## 2."],
		["物料", "## 3."],
		["分镜", "## 11."],
		["storyboard", "## 11."]
	]) {
		const { content, matched } = slicePromptGuide(guide, key);
		assert.equal(matched, true, `section ${key} should match`);
		assert.ok(content.startsWith(expected), `section ${key} should start with ${expected}, got ${content.split("\n")[0]}`);
	}
});

check("省略 section 仍返回全文（显式全量路径保留）", () => {
	const { content, matched } = slicePromptGuide(guide, "");
	assert.equal(matched, false);
	assert.equal(content, guide);
});

check("多个 section 一次取多节（任务横跨两节时不必分两次调用）", () => {
	const { content, matched } = slicePromptGuide(guide, "edit,text");
	assert.equal(matched, true);
	assert.ok(content.includes("## 3."), "应含文字渲染节");
	assert.ok(content.includes("## 4."), "应含参考图编辑节");
	// 文档顺序：3 在 4 之前，且不夹带其它小节
	assert.ok(content.indexOf("## 3.") < content.indexOf("## 4."));
	assert.ok(!content.includes("## 5."));
});

check("显存类关键字（oom / 显存）能命中排查节", () => {
	for (const key of ["oom", "显存", "out of memory"]) {
		const { content, matched } = slicePromptGuide(guide, key);
		assert.equal(matched, true, `section ${key} should match`);
		assert.ok(content.startsWith("## 8."), `section ${key} → 排查速查, got ${content.split("\n")[0]}`);
	}
});

console.log("raw 工作流取证（seed / 指纹）");

check("workflowSeeds：读回 KSampler.seed 与 RandomNoise.noise_seed，忽略非 seed 字段", () => {
	const graph = {
		"3": { class_type: "KSampler", inputs: { seed: 42, steps: 25, sampler_name: "euler" } },
		"4": { class_type: "RandomNoise", inputs: { noise_seed: 7 } },
		"5": { class_type: "CLIPTextEncode", inputs: { text: "seed" } },
		"6": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024 } }
	};
	const seeds = workflowSeeds(graph);
	assert.equal(seeds.length, 2);
	assert.deepEqual(seeds.map((s) => s.value).sort((a, b) => a - b), [7, 42]);
	assert.ok(seeds.some((s) => s.node === "4" && s.field === "noise_seed"));
	assert.equal(workflowSeeds({}).length, 0);
});

check("workflowDigest：键序不同 → 同指纹；值不同 → 指纹变", () => {
	const a = { "1": { class_type: "KSampler", inputs: { seed: 1, model: ["2", 0] } }, "2": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x" } } };
	const b = { "2": { inputs: { ckpt_name: "x" }, class_type: "CheckpointLoaderSimple" }, "1": { inputs: { model: ["2", 0], seed: 1 }, class_type: "KSampler" } };
	const c = { ...a, "1": { class_type: "KSampler", inputs: { seed: 2, model: ["2", 0] } } };
	assert.equal(workflowDigest(a), workflowDigest(b));
	assert.notEqual(workflowDigest(a), workflowDigest(c));
	assert.match(workflowDigest(a), /^[0-9a-f]{16}$/);
});

check("默认档位：省略 tier → standard；显式档位不被改写", () => {
	assert.equal(applyDefaultTier({ prompt: "x" }).tier, "standard");
	assert.equal(applyDefaultTier({ prompt: "x", tier: "draft" }).tier, "draft");
	assert.equal(applyDefaultTier({ prompt: "x", tier: null }).tier, "standard");
});

check("seed：-1/缺失转成确定值，显式值保留", () => {
	assert.ok(Number.isInteger(resolveSeed(-1)) && resolveSeed(-1) >= 0);
	assert.ok(Number.isInteger(resolveSeed(undefined)) && resolveSeed(undefined) >= 0);
	assert.equal(resolveSeed(42), 42);
});

check("尺寸闸门：32 倍数放行，1080 与 0 报错", () => {
	assert.doesNotThrow(() => assertImageSize(1536, "width"));
	assert.doesNotThrow(() => assertImageSize(undefined, "width"));
	assert.throws(() => assertImageSize(1080, "height"), /multiple of 32/);
	assert.throws(() => assertImageSize(0, "width"), /positive integer/);
});

check("模型可见 render 的 meta 行包含 seed/尺寸/步数/模板", () => {
	const line = formatMetaLine({ seed: 1165651769, width: 1536, height: 1536, steps: 25, cfg: 1, template: "qwen_image_2_1_t2i", backend: "direct" });
	for (const part of ["seed=1165651769", "size=1536x1536", "steps=25", "cfg=1", "template=qwen_image_2_1_t2i", "backend=direct"]) {
		assert.ok(line.includes(part), `missing ${part} in ${line}`);
	}
	assert.ok(formatMetaLine({ seed: 1, resolution: 1056, steps: 8, cfg: 1, template: "qwen_image_2_1_i2i" }).includes("resolution=1056"));
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
