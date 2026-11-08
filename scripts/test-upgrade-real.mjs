#!/usr/bin/env node
/**
 * test-upgrade-real.mjs —— 真实大文件的安装/升级回归（**默认关闭**）。
 *
 *   IMAGEKIT_E2E=1 npm run test:e2e                    # 真实联网下载（默认 upscale，约 190 MB）
 *   IMAGEKIT_E2E=1 IMAGEKIT_E2E_UPGRADE=1 npm run test:e2e
 *   IMAGEKIT_E2E=1 IMAGEKIT_E2E_LOCAL_ARCHIVES=<目录> IMAGEKIT_E2E_UPGRADE=1 npm run test:e2e
 *
 * 三种取包方式：
 *   1. 默认走清单里的官方 URL（联网）；
 *   2. `IMAGEKIT_E2E_LOCAL_ARCHIVES=<目录>`：目录里放**真实上游归档**（文件名与清单 URL 末段一致），
 *      脚本起一个本地 HTTP 服务（支持 Range）供下载——完全离线，但走的仍是真实的
 *      sizeBytes + sha256 校验、真实解压、真实 state/备份逻辑。想离线复跑就用这个；
 *   3. `IMAGEKIT_E2E_COMPONENT=engine|models` 换组件（2 GB / 17 GB，只在你真要验那条链路时用）。
 *
 * 覆盖：安装 → sha256 → 解压 → status → verify；`IMAGEKIT_E2E_UPGRADE=1` 还会把 state 版本改旧，
 * 走一遍「同盘备份 → 重新下载（归档已存在时复用）→ 新版本落盘 → 再 verify」。
 * 脚本全程写临时目录，默认跑完删除（`IMAGEKIT_E2E_KEEP=1` 保留以便排查）。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.IMAGEKIT_E2E !== "1") {
	console.log("跳过真实下载回归：设 IMAGEKIT_E2E=1 才启用（默认关，避免每次 npm test 拉大文件）。");
	console.log(
		"用法：IMAGEKIT_E2E=1 npm run test:e2e [IMAGEKIT_E2E_COMPONENT=upscale|engine|models] " +
			"[IMAGEKIT_E2E_UPGRADE=1] [IMAGEKIT_E2E_LOCAL_ARCHIVES=<dir>] [IMAGEKIT_E2E_KEEP=1]"
	);
	process.exit(0);
}

const component = String(process.env.IMAGEKIT_E2E_COMPONENT ?? "upscale");
const withUpgrade = process.env.IMAGEKIT_E2E_UPGRADE === "1";
const localArchives = String(process.env.IMAGEKIT_E2E_LOCAL_ARCHIVES ?? "").trim();
const { registerSetupTools } = await import(new URL("../lib/setup.js", import.meta.url).href);

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

/** 本地归档服务：把真实上游归档按清单 URL 的末段名提供出去，支持 Range（下载器要多连接）。 */
let archiveServer = null;
let pluginRoot = ROOT;
const startArchiveServer = async () => {
	const dirFiles = new Map();
	for (const name of (await import("node:fs")).readdirSync(localArchives)) dirFiles.set(name, path.join(localArchives, name));
	archiveServer = createServer((req, res) => {
		const name = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\//, ""));
		const file = dirFiles.get(name);
		if (file === undefined) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end(`not found: ${name}`);
			return;
		}
		const bytes = readFileSync(file);
		const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ""));
		const start = m ? Number(m[1]) : 0;
		const end = m && m[2] !== "" ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
		const slice = bytes.subarray(start, end + 1);
		res.writeHead(start > 0 || m ? 206 : 200, {
			"content-type": "application/octet-stream",
			"content-length": String(slice.length),
			...(m ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
			"accept-ranges": "bytes"
		});
		res.end(slice);
	});
	await new Promise((resolve) => archiveServer.listen(0, "127.0.0.1", resolve));
	const port = archiveServer.address().port;
	pluginRoot = path.join(root, "plugin");
	mkdirSync(pluginRoot, { recursive: true });
	const manifest = JSON.parse(readFileSync(path.join(ROOT, "models.manifest.json"), "utf8"));
	const files = manifest.components?.[component]?.packs ? Object.values(manifest.components[component].packs).flatMap((pack) => pack.files ?? []) : [];
	if (files.length === 0) throw new Error(`manifest 里没有 component ${component} 的文件`);
	for (const file of files) {
		const original = String(file.sources?.official ?? "");
		const name = path.basename(new URL(original).pathname);
		if (!dirFiles.has(name)) throw new Error(`本地归档目录缺 ${name}（清单来源：${original}）`);
		file.sources = { official: `http://127.0.0.1:${port}/${name}` };
	}
	writeFileSync(path.join(pluginRoot, "models.manifest.json"), JSON.stringify(manifest, null, 2));
	log("本地归档服务", `http://127.0.0.1:${port}（${files.length} 个文件，仍按清单 sha256 校验）`);
};

let tool = null;
try {
	if (localArchives !== "") {
		if (!existsSync(localArchives)) throw new Error(`IMAGEKIT_E2E_LOCAL_ARCHIVES 目录不存在：${localArchives}`);
		await startArchiveServer();
	}
	registerSetupTools(
		{ tools: { register: (t) => { tool = t; return () => {}; }, get: () => undefined }, effect: () => {}, inject: undefined },
		{ pluginRoot, config }
	);
	if (tool === null) throw new Error("image_setup 没注册出来");
	const call = (args) => tool.execute(args, {});

	console.log(`=== 真实下载回归：component=${component}（临时目录 ${root}）===`);
	const installArgs = { action: "install", component };
	if (component === "models") installArgs.pack = process.env.IMAGEKIT_E2E_PACK ?? "core";
	log("1/4 安装（下载 + sha256 + 解压）");
	await withRetry("install", () => call(installArgs));
	log("安装完成", `${((Date.now() - t0) / 1000).toFixed(1)} s`);

	log("2/4 status");
	const status = await call({ action: "status", component });
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

	if (withUpgrade) {
		log("4/4 升级（state 版本改旧 → 备份 → 重新下载/复用归档 → 新版本落盘）");
		const stateFile = path.join(root, ".imagekit", "state.json");
		if (!existsSync(stateFile)) throw new Error("state.json 没有落盘");
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		const comp = state?.installed?.[component];
		if (comp === undefined) throw new Error(`state.json 缺 installed.${component}：${JSON.stringify(state).slice(0, 300)}`);
		const before = comp.version;
		comp.version = "0.0.0";
		writeFileSync(stateFile, JSON.stringify(state, null, 2));
		await withRetry("upgrade", () => call({ action: "upgrade", component }));
		const after = JSON.parse(readFileSync(stateFile, "utf8"))?.installed?.[component];
		if (after === undefined || after.version === "0.0.0") throw new Error("upgrade 后 state 版本没有更新");
		const recheck = await call({ action: "verify", component });
		if (/fail|error/i.test(JSON.stringify(recheck))) throw new Error(`升级后 verify 异常：${JSON.stringify(recheck).slice(0, 300)}`);
		log("升级完成", `v0.0.0 → v${after.version}（原 ${before ?? "?"}），升级后 verify 通过`);
	}

	console.log(
		`\n✓ 真实下载回归通过（${component}${withUpgrade ? " + upgrade" : ""}${localArchives !== "" ? "（本地归档）" : ""}，` +
			`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s）`
	);
} finally {
	archiveServer?.closeAllConnections?.();
	archiveServer?.close();
	if (process.env.IMAGEKIT_E2E_KEEP === "1") console.log(`  · 保留临时目录：${root}`);
	else rmSync(root, { recursive: true, force: true });
}
