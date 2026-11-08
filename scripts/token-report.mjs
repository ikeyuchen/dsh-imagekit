#!/usr/bin/env node
/**
 * token-report.mjs —— 本插件三个档位的常驻 token 计量
 *
 * 口径与宿主统计一致：宿主只发
 * name + description + parameters（outputSchema 不发）+ systemPrompt 段；
 *   A（乐观）：CJK 1.6 字/token、ASCII 4.2 字/token
 *   B（保守）：CJK 1.2 字/token、ASCII 3.6 字/token
 *
 * 用法：node scripts/token-report.mjs [--json]
 * 只读：不联网、不写状态。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const asJson = process.argv.includes("--json");

const CJK = /[\u3400-\u9FFF\uFF00-\uFFEF]/g;
const stats = (text) => {
	const s = String(text ?? "");
	const cjk = (s.match(CJK) || []).length;
	const ascii = s.length - cjk;
	return {
		chars: s.length,
		tokA: Math.round(cjk / 1.6 + ascii / 4.2),
		tokB: Math.round(cjk / 1.2 + ascii / 3.6)
	};
};
const sectionText = (s) => {
	if (typeof s === "string") return s;
	if (s && typeof s.text === "function") {
		try {
			const v = s.text({ scope: "root" });
			return typeof v === "string" ? v : "";
		} catch {
			return "";
		}
	}
	if (s && typeof s.text === "string") return s.text;
	return "";
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
let entry = pkg.exports?.["."];
if (entry && typeof entry === "object") entry = entry.import ?? entry.default ?? entry.require;
const mod = await import(pathToFileURL(path.join(ROOT, entry)).href + `?t=${Date.now()}`);
const { apply, Config } = mod;

const measure = async (profile) => {
	const registered = new Map();
	const sections = [];
	const ctx = {
		tools: {
			register(d) {
				registered.set(d.name, d);
				return () => registered.delete(d.name);
			},
			get(n, scope) {
				return scope === undefined || scope === "root" ? registered.get(n) : undefined;
			},
			restrict() {
				return () => {};
			},
			guard() {
				return () => {};
			}
		},
		systemPrompt: {
			section(s) {
				sections.push(s);
				return () => {};
			}
		},
		effect(fn) {
			const d = fn();
			return typeof d === "function" ? d : () => {};
		},
		on() {
			return () => {};
		},
		jobs: {
			start() {
				return { id: "stub", done: Promise.resolve() };
			}
		},
		workingDirectory: { ensure: () => ROOT, get: () => ROOT },
		subagents: { resolveMaxDepth: () => 1, resolve: () => [], spawn: () => { throw new Error("stub"); } },
		slots: { inject: () => () => {} },
		logger: { debug() {}, info() {}, warn() {}, error() {} }
	};
	const base = typeof Config === "function" ? Config({}) : Config;
	await apply(ctx, Object.assign(Object.create(base), base, { toolsetProfile: profile }));

	const rows = [];
	let toolA = 0;
	let toolB = 0;
	for (const def of registered.values()) {
		const s = stats(JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }));
		toolA += s.tokA;
		toolB += s.tokB;
		rows.push({ name: def.name, tokA: s.tokA, tokB: s.tokB, desc: String(def.description ?? "").length });
	}
	const secs = sections.map(sectionText).filter(Boolean).map(stats);
	const secA = secs.reduce((a, s) => a + s.tokA, 0);
	const secB = secs.reduce((a, s) => a + s.tokB, 0);
	rows.sort((a, b) => b.tokA - a.tokA);
	return { profile, tools: registered.size, toolA, toolB, secA, secB, totalA: toolA + secA, totalB: toolB + secB, rows };
};

const out = [];
for (const p of ["minimal", "standard", "all"]) out.push(await measure(p));

if (asJson) {
	console.log(JSON.stringify({ generatedAt: new Date().toISOString(), profiles: out }, null, 2));
} else {
	console.log("=== dsh-imagekit 常驻 token（name+description+parameters+提示段）===");
	console.log("档位      工具  工具tokA  提示段  合计tokA  合计tokB");
	for (const r of out) {
		console.log(
			`${r.profile.padEnd(9)} ${String(r.tools).padStart(3)}  ${String(r.toolA).padStart(7)}  ${String(r.secA).padStart(6)}  ${String(r.totalA).padStart(7)}  ${String(r.totalB).padStart(7)}`
		);
	}
	const std = out.find((r) => r.profile === "standard");
	console.log("\n分工具（standard，按 token 降序）：");
	for (const row of std.rows) console.log(`  ${row.name.padEnd(26)} ${String(row.tokA).padStart(5)}  (desc ${row.desc} 字符)`);
}
