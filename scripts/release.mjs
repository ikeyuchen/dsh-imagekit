#!/usr/bin/env node
/**
 * release.mjs —— 发布：去掉「（未发布）」→ 改日期 → 验证 → 合成一笔并推送 GitHub。
 *
 * 存在的理由：`（未发布）` 靠人记不住。凡是发布要做的事都放这里，一条命令做完，
 * 不允许漏步骤。默认只**预演**（不改文件、不推送），加 `--push` 才真的执行。
 *
 *   npm run release                      # 预演：显示会改什么、会推什么
 *   npm run release -- --push            # 真发布：改 CHANGELOG → npm test → 合成一笔并推送
 *   npm run release -- --push -m "一句话说明"
 *
 * 前置条件（不满足直接失败，不静默带过）：
 *   - `CHANGELOG.md` 最新小节版本号 == `package.json` 的 version；
 *   - 该小节写着「（未发布）」（已带日期说明发布过了，无需再跑）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const doPush = argv.includes("--push");
const doCheck = argv.includes("--check");
const messageIndex = argv.findIndex((a) => a === "-m" || a === "--message");
const userMessage = messageIndex >= 0 ? String(argv[messageIndex + 1] ?? "").trim() : "";

const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};
const run = (cmd, args, { capture = true, shell = false } = {}) => {
	const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell, stdio: capture ? "pipe" : "inherit" });
	if (r.error) fail(`${cmd} 无法执行：${r.error.message}`);
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const must = (cmd, args, what) => {
	const r = run(cmd, args);
	if (r.code !== 0) fail(`${what}失败：\n${r.out.split("\n").slice(-12).join("\n")}`);
	return r.out;
};

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version ?? "");
const changelogPath = path.join(ROOT, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");

// 最新版本小节必须是第 2 行标题（第 1 个 `## `）。
const heading = /^(##\s+(\d+\.\d+\.\d+)\s*(?:（([^）]*)）)?\s*)$/m.exec(changelog);
if (heading === null) fail("CHANGELOG.md 找不到 `## x.y.z` 版本小节");
const [, oldHeading, headingVersion, headingTag] = heading;
if (headingVersion !== version) {
	fail(`CHANGELOG 最新小节是 ${headingVersion}，package.json 是 ${version}：发布时两处必须一起改`);
}
const tag = (headingTag ?? "").trim();
if (doCheck) {
	// 发布闸门（npm publish 走这里）：必须已经去掉「未发布」。
	if (tag === "未发布") {
		fail(`即将发布，但 CHANGELOG 最新小节仍写着「（未发布）」——先跑 npm run release -- --push`);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(tag)) fail(`CHANGELOG 最新小节缺少发布日期（当前「（${tag}）」）`);
	console.log(`✓ 可发布：${version}（${tag}）`);
	process.exit(0);
}
if (tag !== "未发布") {
	fail(`最新小节已经是「（${tag}）」：这个版本发布过了，先改 package.json 版本号并新开一节「（未发布）」`);
}

const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD（本地时区）
const newHeading = `## ${version}（${today}）`;
const nextChangelog = changelog.replace(heading[1], newHeading);
const releaseMessage = userMessage === "" ? `release: ${version}` : `release: ${version} ${userMessage}`;

console.log(`版本      ${version}`);
console.log(`标题      ${oldHeading.trim()}  →  ${newHeading}`);
console.log(`推送说明  ${releaseMessage}`);
if (!doPush) {
	console.log("\n预演模式：未改文件、未推送。确认无误后加 --push 执行。");
	process.exit(0);
}

// —— 1. 改标题（先写盘，测试跑的就是发布后的状态）——
writeFileSync(changelogPath, nextChangelog);
console.log(`\n✓ 已更新 CHANGELOG 标题为「${today}」`);

// —— 2. 发布前检查（AGENTS.md 要求）——
console.log("\n跑 npm test（含 test:docs）…");
// Windows 上 npm 是 .cmd 包装器，spawn 不能直接执行（EINVAL），必须经 shell。
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const test = run(npm, ["test"], { capture: false, shell: process.platform === "win32" });
if (test.code !== 0) fail(`npm test 未通过，已停下（CHANGELOG 标题已改，修完再跑一次）`);
console.log("✓ npm test 通过（含文档漂移）");

// —— 3. 把本地提交合成一笔，正常快进推送；不改写已推送的历史 ——
must("git", ["add", "-A"], "git add");
const dirty = run("git", ["status", "--porcelain"]);
if (dirty.out !== "") must("git", ["commit", "-m", releaseMessage], "git commit");
must("git", ["fetch", "origin"], "git fetch");

// 远端有新提交时先 rebase，保证压缩的只是本地未推送部分。
const base = run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
if (base.code !== 0) must("git", ["rebase", "origin/main"], "git rebase origin/main");

const ahead = Number(must("git", ["rev-list", "--count", "origin/main..HEAD"], "git rev-list").trim());
if (ahead === 0) {
	console.log("\n✓ 没有新提交，无需推送");
	process.exit(0);
}
must("git", ["reset", "--soft", "origin/main"], "git reset --soft origin/main");
must("git", ["commit", "-m", releaseMessage], "git commit");
console.log(`\n✓ 本地提交已合成一笔：${releaseMessage}`);

const push = run("git", ["push", "origin", "main"]);
if (push.code !== 0) {
	fail(
		`git push 被拒绝。先 git fetch origin && git rebase origin/main，再跑一次。\n${push.out.split("\n").slice(-6).join("\n")}`
	);
}
console.log("✓ 已推送 origin/main");

const latest = must("git", ["log", "--oneline", "-1", "origin/main"], "git log origin/main").trim();
console.log(`✓ 本次新增 1 条提交：${latest}`);
console.log("\n下一步（可选）：npm publish --access public");
