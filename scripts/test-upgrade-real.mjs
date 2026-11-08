#!/usr/bin/env node
/**
 * test-upgrade-real.mjs —— 真实大文件的安装/升级/回滚回归（**默认关闭**）。
 *
 *   IMAGEKIT_E2E=1 npm run test:e2e
 *   IMAGEKIT_E2E=1 IMAGEKIT_E2E_COMPONENT=upscale npm run test:e2e
 *   IMAGEKIT_E2E=1 IMAGEKIT_E2E_UPGRADE=1 npm run test:e2e   # 额外跑一次升级（会下载两遍）
 *
 * 默认组件 `upscale`（4 个上游包，合计约 190 MB）。`engine` 是 2 GB、`models` 是 17 GB，
 * 只在你明确要验证那条链路时指定。脚本全程写临时目录，跑完删除，不碰本机安装。
 *
 * 路线图“引擎/放大升级尚未跑真实大文件回归”的收尾：这条命令手动触发一次真实下载，
 * 依次验证 sha256 校验、解压、state 落盘、verify 全绿；加 IMAGEKIT_E2E_UPGRADE=1
 * 还会把 state 版本改旧，走一遍「同盘备份 → 重新下载 → 新版本落盘」。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.IMAGEKIT_E2E !== "1") {
	console.log("跳过真实下载回归：设 IMAGEKIT_E2E=1 才启用（默认关，避免每次 npm test 拉大文件）。");
	console.log("用法：IMAGEKIT_E2E=1 npm run test:e2e [IMAGEKIT_E2E_COMPONENT=upscale|engine|models] [IMAGEKIT_E2E_UPGRADE=1]");
	process.exit(0);
}

const component = String(process.env.IMAGEKIT_E2E_COMPONENT ?? "upscale");
const withUpgrade = process.env.IMAGEKIT_E2E_UPGRADE === "1";
const { registerSetupTools, resolveLayout } = await import(new URL("../lib/setup.js", import.meta.url).href);

const root = mkdtempSync(path.join(tmpdir(), `imagekit-e2e-${component}-`));
const config = {
	installRoot: root,
	engineRoot: path.join(root, "engine", "ComfyUI_windows_portable"),
	modelsRoot: path.join(root, "models"),
	upscaleEnginesRoot: path.join(root, "upscale-engines", "engines"),
	outputDir: path.join(root, "outputs"),
	modelSource: "huggingface",
	upscaleSource: "official",
	keepVersions: "1",
	downloadConnections: "4",
	autoDownload: "off",
	autoCheckUpdates: "on"
};
const layout = resolveLayout(config);
const stateFile = path.join(layout.stateDir, "state.json");

let tool = null;
registerSetupTools(
	{ tools: { register: (t) => { tool = t; return () => {}; }, get: () => undefined }, effect: () => {}, inject: undefined },
	{ pluginRoot: ROOT, config }
);
if (tool === null) {
	console.error("✗ image_setup 没注册出来");
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
}
const call = (args) => tool.execute(args, {});

const t0 = Date.now();
const log = (label, extra = "") => console.log(`  · ${label}${extra ? ` — ${extra}` : ""}`);
/** 上游 5xx / 断网是常态（GitHub Releases 直链时好时坏）：只对这类错误重试。 */
const transient = (error) => /HTTP 5\d\d|fetch failed|timeout|ECONN|ETIMEDOUT|socket/i.test(String(error?.message ?? error));
const withRetry = async (label, fn, attempts = 3) => {
	for (let i = 1; ; i += 1) {
		try {
			return await fn();
		} catch (error) {
			if (i >= attempts || !transient(error)) throw error;
			console.log(`  ! ${label} 第 ${i} 次失败（${String(error?.message ?? error).split("\n")[0].slice(0, 120)}），10s 后重试`);
			await new Promise((r) => setTimeout(r, 10000));
		}
	}
};

try {
	console.log(`=== 真实下载回归：component=${component}（临时目录 ${root}）===`);

	const installArgs = { action: "install", component };
	if (component === "models") installArgs.pack = process.env.IMAGEKIT_E2E_PACK ?? "core";
	log("1/4 安装（真实下载 + sha256 + 解压）");
	await withRetry("install", () => call(installArgs));
	log("安装完成", `${((Date.now() - t0) / 1000).toFixed(1)} s`);

	log("2/4 status");
	const status = await call({ action: "status", component });
	const statusText = JSON.stringify(status);
	if (!statusText.includes(component)) throw new Error(`status 里没有 ${component}: ${statusText.slice(0, 400)}`);
	const row = (status.components ?? []).find((c) => c.component === component);
	if (row === undefined) throw new Error(`status.components 缺 ${component}`);
	if (!row.installed) throw new Error(`${component} 安装后 status 仍显示未安装`);
	if (Number(row.missing ?? 0) !== 0) throw new Error(`${component} 安装后仍有 ${row.missing} 个文件缺失`);
	log("status 正常", `version=${row.installedVersion ?? "(none)"} missing=${row.missing ?? 0}`);

	log("3/4 verify（重算 checkPath，不起引擎）");
	const verified = await call({ action: "verify", component });
	const verifyText = JSON.stringify(verified);
	if (/fail|error|missing/i.test(verifyText) && !/"ok"\s*:\s*true/.test(verifyText)) {
		throw new Error(`verify 返回异常：${verifyText.slice(0, 400)}`);
	}
	log("verify 通过");
	if (!existsSync(stateFile)) throw new Error("state.json 没有落盘");
	log("state.json 已落盘", stateFile);

	if (withUpgrade) {
		log("4/4 升级（把 state 版本改旧，走备份 → 重新下载）");
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		const comp = state?.installed?.[component];
		if (comp === undefined) throw new Error(`state.json 缺 installed.${component}：${JSON.stringify(state).slice(0, 300)}`);
		const before = { ...comp };
		comp.version = "0.0.0";
		writeFileSync(stateFile, JSON.stringify(state, null, 2));
		const upgraded = await withRetry("upgrade", () => call({ action: "upgrade", component }));
		const upgradedText = JSON.stringify(upgraded);
		if (!upgradedText.includes(component)) throw new Error(`upgrade 返回异常：${upgradedText.slice(0, 400)}`);
		const after = JSON.parse(readFileSync(stateFile, "utf8"))?.installed?.[component];
		if (after === undefined || after.version === "0.0.0") throw new Error("upgrade 后 state 版本没有更新");
		log("升级完成", `v0.0.0 → v${after.version}（原 ${before.version ?? "?"}）`);
	}

	console.log(`\n✓ 真实下载回归通过（${component}${withUpgrade ? " + upgrade" : ""}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s）`);
} finally {
	if (process.env.IMAGEKIT_E2E_KEEP === "1") console.log(`  · 保留临时目录：${root}`);
	else rmSync(root, { recursive: true, force: true });
}
