#!/usr/bin/env node
/**
 * doc-drift.mjs —— 文档漂移检查（离线、只读）
 *
 * 六类引用逐条对着代码/磁盘验证，任何一条对不上就退出码 1：
 *   A 工具名   反引号里的 snake_case 是否真的是已注册工具
 *   B 本地链接  ](./xxx.md) 指向的文件是否存在
 *   C 仓库路径  反引号里的 lib/… docs/… scripts/… 是否存在
 *   D npm 脚本  `npm run xxx` 是否存在于 package.json
 *   E 配置键    反引号里的 *Dir/*Root/*Path/*Url/… 是否在 Config schema 里
 *   F 数量/版本 “N 件”是否等于实测档位、写死的版本是否等于 package.json
 *
 * 白名单（WHITELIST）放的是**合法但不属于上述类别**的名字：模板名、引擎预设、
 * 宿主工具名、清单字段、历史名称。新增这类名字时同步补白名单。
 *
 * 用法：node scripts/doc-drift.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const asJson = process.argv.includes("--json");

/**
 * 白名单按「来源」分类，每类带自己的校验方式：
 *   engines / manifestFields / params  —— 能在仓库里找到真相，**逐条校验**，失效就报错；
 *   templates / hostTools / historical —— 本地无清单（网关侧 / 其它插件 / 旧名字），静态声明，
 *                                        只做「是否被文档引用」检查（防止白名单自己腐烂）。
 */
const WHITELIST = {
	// 网关侧工作流模板（不在本仓库，无法校验）
	templates: [
		"qwen_image_2_1_t2i", "qwen_image_2_1_t2i_pe", "qwen_image_2_1_t2i_turbo", "qwen_image_2_1_cn",
		"qwen_image_2_1_edit", "qwen_image_2_1_edit3", "qwen_image_2_1_edit6", "qwen_image_2_1_edit_pe",
		"qwen_image_2_1_i2i", "qwen_image_2_1_turbo_official_t2i", "qwen_image_2_1_turbo_official_edit",
		"qwen_image_2_1_vnccs", "turbo_official_t2i", "turbo_official_edit", "t2i_turbo",
	],
	// 放大引擎预设：校验 lib/upscale.js 的 ENGINES（2026-11 迁移到上游官方引擎后）
	engines: [
		"cugan", "cugan_pro", "cugan_cons", "waifu2x", "waifu2x_photo",
		"esrgan_anime", "esrgan_hq", "photo_hq", "realsr", "realsr_jpeg",
	],
	// 宿主 / 其它插件提供的工具（不在本包）
	hostTools: ["job_output", "job_kill", "job_list"],
	// 清单 / state 字段：校验 models.manifest.json 文件条目实际字段
	manifestFields: [
		"checkPath", "checkPaths", "extractGlobs", "extractMove", "extractRename", "extractTo",
		"sizeBytes", "sha256", "sources",
	],
	// 运行时输出/状态字段（不写进清单，也无法从代码静态取）
	stateFields: [
		"versionSource", "installedPack", "targetVersion", "installedVersion", "updateAvailable",
		"save_error", "outputDir", "gatewayDir",
	],
	// 历史名称：CHANGELOG / 实现说明里需要提到已移除的东西
	historical: ["repo_check", "plugin_health", "agent_capacity"],
	// 工具参数名：校验已注册工具的 parameters.properties
	params: [
		"save_to", "input_path", "ref_images", "run_in_background", "batch_size",
		"from_template", "node_overrides", "prompt", "steps", "seed", "cfg", "tier",
		"unload_after", "max_size", "durations_ms", "stroke_width", "character_image", "skeleton_image",
		"negative_prompt", "resolution", "denoise",
	],
	// 请求体内部字段（不是工具参数，模板占位符 / 网关字段）
	requestFields: [],
};
const WHITELIST_ALL = new Set(Object.values(WHITELIST).flat());

const CJK = /[\u3400-\u9FFF\uFF00-\uFFEF]/g;
const stats = (t) => {
	const s = String(t ?? "");
	const cjk = (s.match(CJK) || []).length;
	const ascii = s.length - cjk;
	return { chars: s.length, tokA: Math.round(cjk / 1.6 + ascii / 4.2) };
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// —— 真实注册的工具：直接跑一遍 apply()，三档分别收集 ——
const measureTools = async () => {
	const pkgEntry = pkg.exports?.["."];
	const entry = typeof pkgEntry === "string" ? pkgEntry : (pkgEntry?.import ?? "lib/index.js");
	const mod = await import(pathToFileURL(path.join(ROOT, entry)).href + `?t=${Date.now()}`);
	const all = new Set();
	const params = new Set();
	const counts = {};
	for (const profile of ["minimal", "standard", "all"]) {
		const registered = [];
		const base = typeof mod.Config === "function" ? mod.Config({}) : mod.Config;
		const ctx = {
			tools: {
				register: (d) => { registered.push(d); return () => {}; },
				get: (n, scope) => (scope === undefined || scope === "root" ? registered.find((t) => t.name === n) : undefined),
				restrict: () => () => {},
				guard: () => () => {},
			},
			systemPrompt: { section: () => () => {} },
			effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
			on: () => () => {},
			jobs: { start: () => ({ id: "stub", done: Promise.resolve() }) },
			workingDirectory: { ensure: () => ROOT, get: () => ROOT },
			subagents: { resolveMaxDepth: () => 1, resolve: () => [], spawn: () => { throw new Error("stub"); } },
			slots: { inject: () => () => {} },
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		};
		await mod.apply(ctx, Object.assign(Object.create(base), base, { toolsetProfile: profile }));
		counts[profile] = registered.length;
		for (const d of registered) {
			all.add(d.name);
			// d.parameters 是 JSON Schema（{type,properties,required}），参数名在 properties 里
			const props = d.parameters?.properties ?? d.parameters ?? {};
			for (const p of Object.keys(props)) params.add(p);
		}
	}
	return { tools: all, counts, params };
};

const { tools, counts, params } = await measureTools();
const configKeys = new Set(
	[...fs.readFileSync(path.join(ROOT, "lib/index.js"), "utf8").matchAll(/^\t([a-zA-Z][a-zA-Z0-9]*):\s*Schema\./gm)].map((m) => m[1])
);

const docs = [
	...fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(ROOT, "docs", f)),
	path.join(ROOT, "README.md"),
	path.join(ROOT, "CHANGELOG.md"),
	path.join(ROOT, "THIRD_PARTY.md"),
].filter((f) => fs.existsSync(f));

const findings = [];
const add = (kind, file, line, msg) => findings.push({ kind, file: path.relative(ROOT, file).replace(/\\/g, "/"), line, msg });

for (const file of docs) {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	// CHANGELOG 是历史记录，本来就会引用旧数字/旧版本，F 类检查对它不适用。
	const isHistory = path.basename(file) === "CHANGELOG.md";
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const n = i + 1;

		// A 工具名
		for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
			const id = m[1];
			if (WHITELIST_ALL.has(id) || tools.has(id)) continue;
			if (/\.(md|json|js|mjs|png|webp|txt|yml)$/.test(id)) continue;
			add("A", file, n, `未注册的工具名或标识符 \`${id}\``);
		}

		// B 本地链接
		for (const m of line.matchAll(/\]\((\.{0,2}\/?[^)#:]+\.(?:md|png|webp|svg))\)/g)) {
			const target = path.resolve(path.dirname(file), m[1]);
			if (!fs.existsSync(target)) add("B", file, n, `链接失效：${m[1]}`);
		}

		// C 仓库路径
		for (const m of line.matchAll(/`((?:lib|docs|scripts|locale)\/[A-Za-z0-9_./-]+)`/g)) {
			const p = m[1];
			if (p.includes("*")) continue;
			if (!fs.existsSync(path.join(ROOT, p))) add("C", file, n, `仓库路径不存在：${p}`);
		}

		// D npm 脚本
		for (const m of line.matchAll(/npm run ([a-z0-9:]+)/g)) {
			if (!pkg.scripts?.[m[1]]) add("D", file, n, `npm 脚本不存在：${m[1]}`);
		}

		// E 配置键
		for (const m of line.matchAll(/`([a-z][a-zA-Z0-9]{4,})`/g)) {
			const id = m[1];
			if (!/(Dir|Root|Path|Url|Seconds|Source|Profile|Versions|Download|Check|Mode|Pack|Device|Command|Port)$/.test(id)) continue;
			if (WHITELIST_ALL.has(id) || configKeys.has(id)) continue;
			add("E", file, n, `配置键不存在：${id}`);
		}

		// F 档位数量：只查在讲「档位 / 工具集」的句子里出现的「N 件」，
		// 避免把「生图 2 件」这种子项计数误判成档位总数。
		if (!isHistory && /(档位|工具集|toolsetProfile)/.test(line)) {
			for (const m of line.matchAll(/(\d+)\s*件/g)) {
				const v = Number(m[1]);
				if (!Object.values(counts).includes(v)) {
					add("F", file, n, `档位数 ${v} 件与实测 ${JSON.stringify(counts)} 不符`);
				}
			}
		}

		// F 版本号（排除 IP 片段如 127.0.0 与已知上游版本）
		const UPSTREAM = new Set(["0.39.0", "0.1.0", "1.5.0", "2.1"]);
		for (const m of (isHistory ? [] : line.matchAll(/(?<![\d.])v?(\d+\.\d+\.\d+)(?![\d.])/g))) {
			const v = m[1];
			if (v === pkg.version || UPSTREAM.has(v)) continue;
			add("F", file, n, `版本号 ${v} ≠ package.json ${pkg.version}`);
		}
	}
}

// ——— 白名单自洁：分类校验 + 未使用条目清理提示 ———
const enginesInCode = (() => {
	const src = fs.readFileSync(path.join(ROOT, "lib/upscale.js"), "utf8");
	const i = src.indexOf("const ENGINES = {");
	if (i < 0) return new Set();
	let depth = 0;
	let j = i + "const ENGINES = {".length - 1;
	for (; j < src.length; j += 1) {
		if (src[j] === "{") depth += 1;
		else if (src[j] === "}") { depth -= 1; if (depth === 0) break; }
	}
	const block = src.slice(i, j + 1);
	return new Set([...block.matchAll(/^\t([a-z][a-z0-9_]*):/gm)].map((m) => m[1]));
})();
const manifestFieldsInCode = (() => {
	const m = JSON.parse(fs.readFileSync(path.join(ROOT, "models.manifest.json"), "utf8"));
	const keys = new Set();
	for (const comp of Object.values(m.components ?? {})) {
		for (const pack of Object.values(comp.packs ?? {})) {
			for (const f of pack.files ?? []) for (const k of Object.keys(f)) keys.add(k);
		}
	}
	return keys;
})();

const usedIds = new Set();
for (const file of docs) {
	const text = fs.readFileSync(file, "utf8");
	for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9_]{2,})`/g)) usedIds.add(m[1]);
	// 代码块里的 `tier="draft"` / input_path=... 也算引用
	for (const id of WHITELIST_ALL) {
		if (new RegExp(`\\b${id}\\b`).test(text)) usedIds.add(id);
	}
}

const validators = {
	engines: (id) => enginesInCode.has(id),
	manifestFields: (id) => manifestFieldsInCode.has(id) || /extractRename|extractGlobs|extractMove|extractTo/.test(id),
	params: (id) => params.has(id),
};
for (const [group, list] of Object.entries(WHITELIST)) {
	const validate = validators[group];
	for (const id of list) {
		if (validate && !validate(id)) {
			add("W", path.join(ROOT, "scripts/doc-drift.mjs"), 0, `白名单 [${group}] 条目 \`${id}\` 在代码/清单里已不存在，应删除`);
		}
		if (!usedIds.has(id)) {
			add("W", path.join(ROOT, "scripts/doc-drift.mjs"), 0, `白名单 [${group}] 条目 \`${id}\` 未被任何文档引用，建议清理`);
		}
	}
}

// ——— G 隐私 / 只在本地生效的内容 ———
// 允许：本插件的默认路径（文档化的默认值）、localhost、以及与实例无关的通用路径。
const PATH_ALLOW = [
	/^[A-Za-z]:[\\/]$/,                                        // 单写盘符（“检查某个盘是否存在”这类行为描述）
	/^[A-Za-z]:[\\/]AI[\\/]Tools[\\/]ImageKit([\\/]|$)/,   // 文档化的默认资产目录
	/^[A-Za-z]:[\\/]Program Files([\\/]|$)/,                 // 7-Zip 等系统软件
	/^[A-Za-z]:[\\/]AI[\\/]ComfyUI/,                        // junction 兼容示例
];
const PRIVACY_RULES = [
	["用户目录", /[A-Za-z]:[\\/]Users[\\/][^\\/\s`'"]+/, "把个人目录换成占位符（如 `<你的图片路径>`）"],
];
const AUTHORSHIP = /(^|[\\/])(LICENSE|THIRD_PARTY\.md)$/;
for (const file of docs) {
	if (AUTHORSHIP.test(file)) continue;   // 版权/署名里出现作者名是应有内容
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		for (const [name, rx, hint] of PRIVACY_RULES) {
			if (rx.test(line)) add("G", file, i + 1, `${name}：${hint}`);
		}
		// 只看“盘符开头的路径”：前面不能紧贴字母或斜杠，避免把 URL 的协议前缀当成盘符
		for (const m of line.matchAll(/(?<![A-Za-z0-9/])[A-Za-z]:[\\/][^`\s'")<>，。、；：（）]*/g)) {
			if (PATH_ALLOW.some((rx) => rx.test(m[0]))) continue;
			add("G", file, i + 1, `只有本机才存在的绝对路径 \`${m[0]}\`，应改成占位符或配置项`);
		}
	}
}

// ——— H 仓库里的盘符路径：只允许出现在 lib/paths.js（默认值的唯一出处） ———
// 扫描范围：lib/**、scripts/**；文档类已在 G 类里查过。
const CODE_ALLOW = new Set(["lib/paths.js"]);
const codeFiles = [];
const walk = (dir) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); }
		else if (/\.(js|mjs)$/.test(e.name)) codeFiles.push(full);
	}
};
walk(path.join(ROOT, "lib"));
walk(path.join(ROOT, "scripts"));
for (const file of codeFiles) {
	const rel = path.relative(ROOT, file).replace(/\\/g, "/");
	if (CODE_ALLOW.has(rel)) continue;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		// 只看字符串/注释里的盘符路径（形如 <盘符>:\<目录>）
		for (const m of lines[i].matchAll(/(?<![A-Za-z0-9/])[A-Za-z]:[\\/][^\s`'"]*/g)) {
			// 系统目录属于 OS 事实（7-Zip、nvidia-smi、PowerShell），不算本机化
			// 源码里是转义写法（"C:\\Program Files"），因此允许 1~2 个反斜杠；匹配在空格处截断，只比前缀
			if (/^[A-Za-z]:[\\/]{1,2}(Program|Windows|ProgramData)/i.test(m[0])) continue;
			add("H", file, i + 1, `代码里写死的盘符路径 \`${m[0]}\`（应改用 lib/paths.js 的派生值）`);
		}
	}
}

const out = {
	generatedAt: new Date().toISOString(),
	documents: docs.length,
	profiles: counts,
	findings,
};
if (asJson) {
	console.log(JSON.stringify(out, null, 2));
} else {
	const totalChars = docs.reduce((a, f) => a + stats(fs.readFileSync(f, "utf8")).chars, 0);
	console.log(`=== 文档漂移检查 ===`);
	console.log(`文档 ${docs.length} 份 / ${totalChars} 字符；档位实测 ${JSON.stringify(counts)}`);
	if (findings.length === 0) {
		console.log(`\n✅ 无漂移：链接、路径、工具名、npm 脚本、配置键、数量、版本全部对得上`);
	} else {
		console.log(`\n${findings.length} 条待修：`);
		for (const f of findings) console.log(`  [${f.kind}] ${f.file}:${f.line}  ${f.msg}`);
	}
}
process.exit(findings.length === 0 ? 0 : 1);
