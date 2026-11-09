#!/usr/bin/env node
/**
 * test-tool-guards.mjs —— 三个此前没有自动化覆盖的模块的「校验与错误路径」自测（离线）。
 *
 * 覆盖：
 *   lib/process.js      5 个像素工具：参数校验（exactly one / frames / durations）与输入错误
 *   lib/upscale.js      image_upscale：引擎名 / 倍率 / 降噪档 / 输入内容 / 引擎缺失的报错
 *   lib/engine/index.js comfy：action=control 缺 op、未知 action
 *
 * 为什么只测错误路径：真正执行需要 Vulkan 引擎、Python+Pillow 或运行中的 ComfyUI，CI 里都没有。
 * 但「参数非法时是否响亮报错、绝不静默降级」是纯逻辑，可以在任意 Windows 机器上验证，
 * 也正好覆盖之前零测试的 image_upscale 与像素工具入口。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "docs", "icon.png"); // 真实 PNG，供 checkInput / 文件头嗅探用
const tmp = mkdtempSync(path.join(tmpdir(), "imagekit-guards-"));
const missing = path.join(tmp, "nope.png");
const notImage = path.join(tmp, "note.dat"); // 扩展名不认识 → 触发文件头嗅探失败
const emptyEngines = path.join(tmp, "engines");
writeFileSync(notImage, "this is not an image\n");

let passed = 0;
const check = async (label, fn) => {
  await fn();
  console.log(`  ✓ ${label}`);
  passed += 1;
};

/** 用假 ctx 注册工具，返回 name -> defineTool 定义 */
const collect = (register, config) => {
  const tools = [];
  const ctx = {
    tools: {
      register: (def) => {
        tools.push(def);
        return () => {};
      },
      get: () => undefined,
    },
  };
  register(ctx, config);
  return new Map(tools.map((t) => [t.name, t]));
};

console.log("lib/process.js — 像素工具参数校验");
{
  const { register } = await import("../lib/process.js");
  const tools = collect(register, { pythonCommand: "", timeoutSeconds: 600 });
  assert.equal(tools.size, 5, `像素工具应为 5 个，实际 ${tools.size}`);
  const resize = tools.get("image_resize_lanczos");
  const mark = tools.get("image_mark_region");
  const flatten = tools.get("image_flatten_alpha");
  const anim = tools.get("anim_encode");
  const pose = tools.get("pose_check");

  await check("resize：width / height / percent 必须且只能给一个", async () => {
    await assert.rejects(() => resize.execute({ input_path: FIXTURE }), /exactly ONE of width \/ height \/ percent/);
    await assert.rejects(
      () => resize.execute({ input_path: FIXTURE, width: 64, percent: 50 }),
      /exactly ONE of width \/ height \/ percent/
    );
  });

  await check("resize：输入文件不存在时明确报错（不进入 python）", async () => {
    await assert.rejects(() => resize.execute({ input_path: missing, width: 64 }), /Input image not found/);
  });

  await check("mark_region / flatten_alpha：输入文件不存在时明确报错", async () => {
    await assert.rejects(
      () => mark.execute({ input_path: missing, cx: 1, cy: 1, radius: 8 }),
      /Input image not found/
    );
    await assert.rejects(() => flatten.execute({ input_path: missing }), /Input image not found/);
  });

  await check("anim_encode：帧数不足 / 帧缺失 / 时长数量不匹配 / 时长非整数", async () => {
    await assert.rejects(() => anim.execute({ frames: [FIXTURE] }), /frames must be an array of >= 2 image paths/);
    await assert.rejects(
      () => anim.execute({ frames: [FIXTURE, path.join(tmp, "missing-frame.png")] }),
      /Frame not found/
    );
    await assert.rejects(
      () => anim.execute({ frames: [FIXTURE, FIXTURE], durations_ms: "100,200,300" }),
      /entries but frames/
    );
    await assert.rejects(
      () => anim.execute({ frames: [FIXTURE, FIXTURE], durations_ms: "fast,slow" }),
      /durations_ms must be integers/
    );
  });

  await check("pose_check：两张输入图缺失时报错", async () => {
    await assert.rejects(
      () => pose.execute({ character_image: missing, skeleton_image: missing }),
      /Input image not found/
    );
  });
}

console.log("\nlib/upscale.js — image_upscale 参数与引擎校验");
{
  const { register } = await import("../lib/upscale.js");
  const up = collect(register, { enginesRoot: emptyEngines, timeoutSeconds: 600 }).get("image_upscale");

  if (process.platform !== "win32") {
    // 插件本身只支持 Windows：非 Windows 上正确的行为就是明确拒绝，而不是静默降级
    await check("非 Windows 平台：image_upscale 明确拒绝执行", async () => {
      await assert.rejects(() => up.execute({ input_path: FIXTURE }), /Windows x64 only/);
    });
  } else {
    await check("未知引擎名在参数校验层就被拒绝（列全部合法引擎）", async () => {
      // defineTool 在 execute 前按 schema 校验 enum，非法引擎名到不了 JS 分支——这正是要保证的行为
      await assert.rejects(() => up.execute({ input_path: FIXTURE, engine: "nope" }), /"engine" must be one of/);
    });

    await check("引擎不支持的倍率报错（不静默换档）", async () => {
      await assert.rejects(
        () => up.execute({ input_path: FIXTURE, engine: "cugan", scale: 5 }),
        /does not support scale x5/
      );
    });

    await check("倍率不支持的降噪档报错", async () => {
      // cugan x3 只允许 denoise 0/3
      await assert.rejects(
        () => up.execute({ input_path: FIXTURE, engine: "cugan", scale: 3, denoise: 2 }),
        /at x3 supports denoise 0\/3, got 2/
      );
    });

    await check("输入文件不存在报错", async () => {
      await assert.rejects(() => up.execute({ input_path: missing }), /Input image not found/);
    });

    await check("扩展名与文件头都不是图片时报错", async () => {
      await assert.rejects(() => up.execute({ input_path: notImage }), /Unrecognized image content/);
    });

    await check("引擎未安装时指出安装入口（image_setup）", async () => {
      await assert.rejects(
        () => up.execute({ input_path: FIXTURE, engine: "cugan", scale: 2 }),
        /Engine executable not found[\s\S]*image_setup/
      );
    });
  }
}

console.log("\nlib/engine/index.js — comfy 网关参数校验");
{
  const { apply, Config } = await import("../lib/engine/index.js");
  const tools = [];
  const ctx = {
    tools: {
      register: (def) => {
        tools.push(def);
        return () => {};
      },
      get: () => undefined,
    },
    systemPrompt: { section: () => () => {} },
    effect: () => () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  apply(ctx, Config({ engineRoot: path.join(tmp, "ComfyUI_windows_portable"), baseUrl: "http://127.0.0.1:18188" }));
  const comfy = new Map(tools.map((t) => [t.name, t])).get("comfy");
  assert.ok(comfy, "comfy 工具未注册");

  await check("action=control 缺少 op 时报错", async () => {
    await assert.rejects(() => comfy.execute({ action: "control" }), /requires op/);
  });

  await check("未知 action 在参数校验层被拒绝", async () => {
    await assert.rejects(() => comfy.execute({ action: "bogus" }), /"action" must be one of/);
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ 工具校验自测通过（${passed} 项）`);
