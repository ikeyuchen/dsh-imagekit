/**
 * 离线自测：默认路径、既有 ComfyUI 复用、DSH 自带 Python、引擎未安装的报错。
 * 这些是「换台机器就装不通」的高频坑（协作者报告 BUG-3 / BUG-4 / ISSUE-6），
 * 全部只碰 _tmp 里的假目录，不下载、不联网、不启动任何进程。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "_tmp", "paths-fixture");

/** 造一个「看起来像」ComfyUI 便携版的目录（只建两个被判定的文件）。 */
function makeComfyUi(dir) {
	mkdirSync(path.join(dir, "python_embeded"), { recursive: true });
	mkdirSync(path.join(dir, "ComfyUI", "user"), { recursive: true });
	writeFileSync(path.join(dir, "python_embeded", "python.exe"), "", "utf8");
	writeFileSync(path.join(dir, "ComfyUI", "main.py"), "# stub\n", "utf8");
	return dir;
}

let checks = 0;
function ok(label) {
	checks += 1;
	console.log(`✓ ${label}`);
}

async function main() {
	rmSync(FIXTURE, { recursive: true, force: true });
	const engine = makeComfyUi(path.join(FIXTURE, "existing", "ComfyUI_windows_portable"));
	const bundledPython = path.join(FIXTURE, "dsh", "dsh-runtimes", "r1", "dependencies", "python", "python.exe");
	mkdirSync(path.dirname(bundledPython), { recursive: true });
	writeFileSync(bundledPython, "", "utf8");
	// 一个名字像 ComfyUI、内容不对的目录：不能被当成可用引擎
	const fakeDir = path.join(FIXTURE, "fake", "ComfyUI");
	mkdirSync(fakeDir, { recursive: true });

	// paths.js 在模块加载时解析环境，因此先设环境再动态 import
	process.env.IMAGEKIT_INSTALL_ROOT = path.join(FIXTURE, "root");
	process.env.IMAGEKIT_ENGINE_DIR = engine;
	process.env.DSH_HOME = path.join(FIXTURE, "dsh");

	const paths = await import("../lib/paths.js");

	assert.equal(paths.INSTALL_ROOT, path.join(FIXTURE, "root"));
	ok("IMAGEKIT_INSTALL_ROOT 覆盖安装根");

	assert.equal(paths.ENGINE_ROOT, engine);
	assert.equal(paths.ENGINE_ROOT_SOURCE, "env");
	ok("IMAGEKIT_ENGINE_DIR 覆盖引擎根并标记来源");

	assert.equal(paths.ENGINE_PYTHON, path.join(engine, "python_embeded", "python.exe"));
	ok("引擎 python 路径由引擎根派生");

	assert.equal(path.resolve(paths.DEFAULT_ENGINE_ROOT), path.join(FIXTURE, "root", "engine", "ComfyUI_windows_portable"));
	ok("默认引擎位置仍是 installRoot 下（安装目标不被复用路径污染）");

	const detected = paths.detectComfyUiInstalls();
	const pathsDetected = detected.map((item) => path.resolve(item.path));
	assert.ok(pathsDetected.includes(path.resolve(engine)), "环境变量指定的既有安装应被探测到");
	assert.ok(!pathsDetected.includes(path.resolve(fakeDir)), "只有名字像、没有 ComfyUI/main.py 的目录不算引擎");
	assert.ok(detected.every((item) => item.kind === "portable" || item.kind === "source"));
	ok("探测既有机型：只认真正的 ComfyUI 树，便携版优先");

	const pyCandidates = paths.bundledPythonCandidates();
	assert.ok(pyCandidates.includes(bundledPython), "应探测到 $DSH_HOME/dsh-runtimes/*/dependencies/python/python.exe");
	ok("DSH 自带 Python 候选可被发现");

	const logs = paths.engineLogCandidates();
	assert.ok(logs[0].endsWith("engine.err.log") && logs[1].endsWith("engine.log"));
	assert.ok(logs.some((file) => file.includes(path.join("user", "comfyui.log"))));
	ok("引擎日志候选：插件落盘优先，ComfyUI 自身日志兜底");

	const created = paths.ensureInstallDirs();
	assert.ok(created.length > 0 && existsSync(path.resolve(paths.MODELS_ROOT)));
	assert.equal(paths.ensureInstallDirs().length, 0, "已存在的目录不重复创建");
	ok("安装根与派生目录按需创建，可重入");

	const defaults = paths.defaultAssetPaths();
	assert.equal(defaults.engineRoot, engine);
	assert.equal(defaults.engineRootSource, "env");
	assert.ok(Array.isArray(defaults.detectedEngines));
	ok("设置页默认值快照带上引擎来源与探测结果");

	// 引擎未安装：报「没装 + 怎么装」，而不是「进程启动失败」
	const engineMod = await import("../lib/engine/index.js");
	const missingConfig = { engineRoot: path.join(FIXTURE, "nowhere", "ComfyUI_windows_portable") };
	assert.equal(engineMod.engineInstalled(missingConfig), false);
	const message = engineMod.engineMissingMessage(missingConfig);
	assert.match(message, /not installed/i);
	assert.match(message, /image_setup/);
	assert.match(message, new RegExp(engine.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "应提示可复用的既有安装");
	assert.doesNotMatch(message, /exited during startup/i);
	ok("引擎未安装的报错指向安装/复用，不再说成启动崩溃");

	console.log(`\n✅ test-paths: ${checks} 项通过`);
	rmSync(FIXTURE, { recursive: true, force: true });
}

main().catch((error) => {
	console.error(`\n❌ test-paths 失败: ${error?.message ?? error}`);
	process.exitCode = 1;
});
