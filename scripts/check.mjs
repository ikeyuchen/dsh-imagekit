#!/usr/bin/env node
/**
 * dsh-imagekit 发布前静态检查（无宿主依赖、可在 CI 跑）。
 * 只验证包结构/语法/清单/patch 一致性，不启动引擎、不访问网络。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const pass = [];
const ok = (msg) => pass.push(msg);
const fail = (msg) => failures.push(msg);
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => existsSync(path.join(ROOT, rel));

const pkg = JSON.parse(read("package.json"));
if (pkg.name !== "dsh-imagekit") fail(`package name 应为 dsh-imagekit，实际 ${pkg.name}`);
else ok("package name = dsh-imagekit");
// 版本号随发布递增，这里只校验形状（x.y.z 或 x.y.z-beta.N），不写死具体值
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(String(pkg.version ?? ""))) fail(`版本号应为 x.y.z 或 x.y.z-beta.N（当前 ${pkg.version}）`);
else ok(`version = ${pkg.version}`);
if (pkg.private === true) fail("发布包不应 private:true");
else ok("private 未启用");
if (pkg.publishConfig?.access !== "public") fail("publishConfig.access 应为 public");
else ok("publishConfig.access = public");
if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail("缺少 files 白名单");
else ok("files 白名单存在");

const required = [
  "lib/index.js",
  "lib/generate/gateway.js",
  "lib/generate/tiers.js",
  "lib/generate/tools.js",
  "lib/process.js",
  "lib/upscale.js",
  "lib/engine/index.js",
  "lib/perf/index.js",
  "lib/perf/worker-entry.mjs",
  "lib/setup.js",
  "lib/env/index.js",
  "lib/env/tools.js",
  "lib/client.js",
  "models.manifest.json",
  "scripts/pixels.py",
  "tiers.json",
  "cordis.patch.yml",
  "locale/zh.json",
  "locale/en.json",
  "icon.svg",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/PROMPTS-CORE.md",
  "docs/RELEASING.md",
  "THIRD_PARTY.md"
];
for (const rel of required) {
  if (!exists(rel)) fail(`缺少必需文件: ${rel}`);
}
if (required.every(exists)) ok(`必需文件齐全（${required.length} 项）`);

const patch = read("cordis.patch.yml");
if (!/^\s*-\s*id:\s*tool-image\s*$/m.test(patch)) fail("cordis.patch.yml 缺少 id: tool-image");
else ok("patch id = tool-image");
if (!/^\s*name:\s*['\"]?dsh-imagekit['\"]?\s*$/m.test(patch)) fail("cordis.patch.yml 的 name 不是 dsh-imagekit");
else ok("patch name = dsh-imagekit");

const jsFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "data" || entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (/\.(?:js|mjs)$/.test(entry.name)) jsFiles.push(abs);
  }
};
walk(path.join(ROOT, "lib"));
// scripts/ 里的自测与发布脚本同样是发布物的一部分（prepublishOnly 会跑它们），语法错误不该等到运行时才发现
walk(path.join(ROOT, "scripts"));
for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) fail(`语法检查失败 ${path.relative(ROOT, file)}: ${res.stderr.trim().split("\n")[0]}`);
}
if (jsFiles.length) ok(`语法检查通过（${jsFiles.length} 个 JS/MJS）`);

// 本地开发目录（peer-shim 产生的 node_modules、运行数据 data/）允许存在，
// 但不允许被 git 跟踪；npm 侧由 files 白名单兜底。
const tracked = spawnSync("git", ["ls-files", "--", "node_modules", "data"], { cwd: ROOT, encoding: "utf8" });
if (tracked.status === 0) {
  const leaked = tracked.stdout.trim();
  if (leaked !== "") fail(`node_modules/ 或 data/ 被 git 跟踪（应从索引移除）：\n${leaked.split("\n").slice(0, 5).join("\n")}`);
  else ok("node_modules/ 与 data/ 未进 git 索引");
} else {
  ok("git 不可用，跳过跟踪检查");
}

const totalBytes = (dir) => {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) n += totalBytes(abs);
    else n += statSync(abs).size;
  }
  return n;
};
ok(`lib/ 大小 ${(totalBytes(path.join(ROOT, "lib")) / 1024).toFixed(1)} KB`);

if (failures.length) {
  console.error("\n✗ 发布检查失败：");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("\n✓ dsh-imagekit 发布检查通过");
for (const p of pass) console.log(" - " + p);
