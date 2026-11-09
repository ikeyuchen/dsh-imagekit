#!/usr/bin/env node
/**
 * release-beta.mjs —— 发布开发版到 npm 的 beta dist-tag。
 *
 *   npm run release:beta                 # 预演：检查版本/日志/测试计划，不发布
 *   npm run release:beta -- --publish    # 真发布：npm publish --tag beta（npm 的 prepublishOnly 先跑 npm test）
 *   npm run release:beta -- --dry-run    # 只跑 npm publish --dry-run，不真正发布
 *
 * 规范（见 AGENTS.md / docs/RELEASING.md）：
 *   - 开发版版本号必须是 x.y.z-beta.N；
 *   - CHANGELOG 顶部小节必须同版本，并写发布日期 YYYY-MM-DD（不写「未发布」）；
 *   - 只打 beta tag，绝不改 latest；
 *   - 稳定版另行升版本、走 npm run release -- --push + npm publish --tag latest。
 *
 * 本脚本不推送 GitHub、不改写历史：beta 发布只动 npm 的 beta tag。
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const doPublish = argv.includes("--publish");
const dryRun = argv.includes("--dry-run");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version ?? "");
const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

const fail = (message) => {
	console.error(`✗ ${message}`);
	process.exit(1);
};
const run = (command, args, { capture = true } = {}) => {
	const result = spawnSync(command, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
		shell: process.platform === "win32"
	});
	if (result.error) fail(`${command} 无法执行：${result.error.message}`);
	return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
	fail(`开发版版本号必须是 x.y.z-beta.N，当前 ${JSON.stringify(version)}`);
}
const heading = /^##\s+(\d+\.\d+\.\d+-beta\.\d+)\s*（([^）]*)）/m.exec(changelog);
if (heading === null) fail("CHANGELOG 顶部找不到 `## x.y.z-beta.N（日期）` 小节");
if (heading[1] !== version) fail(`CHANGELOG 最新小节是 ${heading[1]}，package.json 是 ${version}`);
const date = heading[2].trim();
if (date === "未发布" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
	fail(`beta 小节要写发布日期 YYYY-MM-DD（当前「（${date}）」）`);
}

console.log(`版本      ${version}`);
console.log(`日志      ## ${version}（${date}）`);
console.log(`dist-tag  beta（不改 latest）`);

if (!doPublish && !dryRun) {
	console.log("\n预演模式：未发布。确认后加 --publish 真正发布。");
	process.exit(0);
}

// npm test 不在这里跑：package.json 的 prepublishOnly 已经包含它，
// 放在 npm publish 里跑可以覆盖所有发布入口（本脚本、本地手动 publish、CI 的 tag 发布），
// 脚本再跑一遍只会白白多花一整套自测的时间。
const publishArgs = ["publish", "--tag", "beta", "--access", "public"];
if (dryRun) publishArgs.push("--dry-run");
console.log(`\nnpm ${publishArgs.join(" ")}（prepublishOnly 会先跑 npm test）…`);
const publish = run(process.platform === "win32" ? "npm.cmd" : "npm", publishArgs, { capture: false });
if (publish.code !== 0) fail("npm publish 失败（若刚打印的是自测失败，先修测试再发）");

if (!dryRun) {
	// npm publish 返回成功不代表 registry 立刻可查：dist-tag 传播常有几秒到几分钟延迟。
	// 先查精确版本，再重试查 beta tag；不要因为一次 404 就误报发布失败。
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const check = async (spec) => {
		const result = run(npm, ["view", `dsh-imagekit@${spec}`, "version"]);
		return result.code === 0 ? result.out.trim() : null;
	};
	let published = await check(version);
	for (let attempt = 0; attempt < 12 && published !== version; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		published = await check(version);
	}
	if (published !== version) fail(`发布后核对失败：registry 仍查不到 ${version}`);
	let tagged = await check("beta");
	for (let attempt = 0; attempt < 12 && tagged !== version; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		tagged = await check("beta");
	}
	if (tagged !== version) fail(`版本已发布，但 beta dist-tag 仍指向 ${tagged ?? "(none)"}；稍后用 npm view dsh-imagekit@beta 复核`);
	console.log(`\n✓ 已发布 beta：${published}`);
	console.log("安装方式：dsh plugin add dsh-imagekit@beta");
	console.log("提示：本次发布未推送 GitHub；需要推送时按 AGENTS.md 先合成一笔再推。");
}
