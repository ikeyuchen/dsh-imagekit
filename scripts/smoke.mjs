#!/usr/bin/env node
/**
 * 本地冒烟：在没有宿主的情况下加载插件入口、注册全部工具。
 *
 * 依赖 peer 包（默认不在 node_modules 里，需先装一次）：
 *   npm i --no-save @deepseek-ai/schemastery @deepseek-ai/dsh-tools
 *   node scripts/smoke.mjs
 *
 * 只验证「能加载、能注册、Config 有默认值」，不访问网络、不启动引擎。
 */
const tools = [];
const sections = [];
const ctx = {
  tools: {
    register: (def) => {
      tools.push(def);
      return () => {};
    },
    get: () => undefined,
  },
  systemPrompt: {
    section: (section) => {
      sections.push(section);
      return () => {};
    },
  },
  effect: () => {},
  logger: { warn: () => {}, info: () => {}, error: () => {} },
};

let mod;
try {
  mod = await import("../lib/index.js");
} catch (error) {
  console.error("✗ 无法加载 lib/index.js：" + String(error?.message ?? error));
  console.error("  先安装 peer 依赖： npm i --no-save @deepseek-ai/schemastery @deepseek-ai/dsh-tools");
  process.exit(1);
}

const { apply, Config, inject, name } = mod;
const config = Config({});
apply(ctx, config);

// volatile 字段在宿主侧解析为 { get() } 描述符，打印前拆包。
const unwrap = (value) =>
  value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;

// 四档工具清单：minimal（只够跑生图+放大）/ lean（默认，像素处理合并）/ standard / all
const PROFILES = {
  minimal: ["image_generate", "image_prompt_guide", "image_service_status", "image_upscale", "image_setup", "comfy"],
  lean: [
    "image_generate", "image_generate_raw", "image_workflow_inspect", "image_prompt_guide", "image_service_status",
    "image_process", "image_upscale", "image_setup", "comfy",
  ],
  standard: [
    "image_generate", "image_generate_raw", "image_workflow_inspect", "image_prompt_guide", "image_service_status",
    "image_resize_lanczos", "image_mark_region", "image_flatten_alpha", "anim_encode", "pose_check",
    "image_upscale", "image_setup", "comfy", "perf",
  ],
  all: [
    "image_generate", "image_generate_raw", "image_workflow_inspect", "image_prompt_guide", "image_service_status",
    "image_resize_lanczos", "image_mark_region", "image_flatten_alpha", "anim_encode", "pose_check",
    "image_upscale", "image_setup", "comfy", "perf", "env_probe", "preflight",
  ],
};
const expected = PROFILES[unwrap(config.toolsetProfile)] ?? PROFILES.standard;
const registered = tools.map((t) => t.name);
const missing = expected.filter((t) => !registered.includes(t));
const extra = registered.filter((t) => !expected.includes(t));

console.log(`entry name = ${name}`);
console.log(`inject     = ${inject.join(", ")}`);
console.log(`profile    = ${unwrap(config.toolsetProfile)}`);
console.log(`tools (${registered.length}) = ${registered.join(", ")}`);
console.log(`sections   = ${sections.map((s) => s.name).join(", ")}`);

if (missing.length || extra.length) {
  console.error(`\n✗ 工具清单不符：missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`);
  process.exit(1);
}
console.log(`\n✓ 冒烟通过：入口可加载，${registered.length} 个工具全部注册`);
