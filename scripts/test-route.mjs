#!/usr/bin/env node
/**
 * test-route.mjs —— 设置页 host 路由的 HTTP 层自测（离线、不起服务器）。
 *
 * 路线图里“设置页路由（HTTP 层）尚未自动化”的收尾：直接注册一个假的 `connection`
 * 服务，把 `registerSetupTools` 注册的 handler 抓出来，用真实 `Request` 打进去，
 * 断言 HTTP 状态码 + JSON 形状。覆盖：
 *   1) 两条路由已注册（`/api/dsh-imagekit/setup`、`/api/dsh-imagekit/perf`）；
 *   2) setup 路由透传 `image_setup` 的 status（含 components 数组）；
 *   3) 非 JSON 请求体 → 400；
 *   4) 工具未注册 → 503；
 *   5) 工具抛错 → 500 且带可读 message。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { registerSetupTools } = await import(new URL("../lib/setup.js", import.meta.url).href);

let passed = 0;
const check = async (label, fn) => {
	await fn();
	console.log(`  ✓ ${label}`);
	passed += 1;
};
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

const root = mkdtempSync(path.join(tmpdir(), "imagekit-route-"));
const config = {
	installRoot: root,
	modelsRoot: path.join(root, "models"),
	engineRoot: path.join(root, "engine", "ComfyUI_windows_portable"),
	upscaleEnginesRoot: path.join(root, "upscale-engines", "engines"),
	outputDir: path.join(root, "outputs"),
	modelSource: "custom",
	modelPackBaseUrl: "http://127.0.0.1:1/mirror",
	keepVersions: "1",
	autoDownload: "off",
	autoCheckUpdates: "on",
	downloadConnections: "4"
};

const tools = [];
let hideSetupTool = false;
const routes = new Map();
const fakeTool = {
	name: "image_setup",
	execute: async (args) => {
		if (args.action === "boom") throw new Error("boom from tool");
		return { action: args.action ?? "status", components: [{ component: "engine" }], ok: true };
	}
};

const ctx = {
	tools: {
		register: (tool) => {
			registeredTool = tool;
			tools.push(tool);
			return () => {};
		},
		get: (name) => {
			if (name === "image_setup") return hideSetupTool ? undefined : (registeredImageSetup ?? fakeTool);
			return undefined;
		}
	},
	effect: () => {},
	inject: (_services, callback) => {
		const connection = {
			fetch: {
				register: (definition) => {
					routes.set(definition.path, definition);
					return () => {};
				}
			}
		};
		callback({ get: () => connection, effect: (fn) => fn() });
	}
};
let registeredTool = null;
let registeredImageSetup = null;

registerSetupTools(ctx, { pluginRoot: ROOT, config });
// 路由层只负责「透传给工具」：断言用假工具，不依赖真实 image_setup 的输出形状。
registeredImageSetup = fakeTool;

const handler = (pathname) => {
	const route = routes.get(pathname);
	assert(route !== undefined, `route ${pathname} not registered`);
	return route;
};
const post = (pathname, body) =>
	handler(pathname).fetch(
		new Request(`http://127.0.0.1${pathname}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body)
		})
	);

try {
	await check("两条设置页路由已注册（setup + perf）", async () => {
		assert(routes.has("/api/dsh-imagekit/setup"), "missing setup route");
		assert(routes.has("/api/dsh-imagekit/perf"), "missing perf route");
		assert(handler("/api/dsh-imagekit/setup").methods?.includes("POST"), "setup route must accept POST");
	});

	await check("setup 路由透传 image_setup 的 status", async () => {
		const res = await post("/api/dsh-imagekit/setup", { action: "status" });
		assert(res.status === 200, `expected 200, got ${res.status}`);
		const body = await res.json();
		assert(body.ok === true, `expected ok:true, got ${JSON.stringify(body).slice(0, 200)}`);
		assert(body.value?.action === "status", "body should be forwarded to the tool as-is");
		assert(Array.isArray(body.value?.components), "tool result should be returned under .value");
	});

	await check("非 JSON 请求体 → 400", async () => {
		const res = await post("/api/dsh-imagekit/setup", "not-json");
		assert(res.status === 400, `expected 400, got ${res.status}`);
		const body = await res.json();
		assert(body.ok === false && /JSON/i.test(body.message), "400 body should explain JSON");
	});

	await check("工具未注册 → 503", async () => {
		hideSetupTool = true;
		try {
			const res = await post("/api/dsh-imagekit/setup", { action: "status" });
			assert(res.status === 503, `expected 503, got ${res.status}`);
			const body = await res.json();
			assert(body.ok === false && /not registered/i.test(body.message), "503 body should say the tool is missing");
		} finally {
			hideSetupTool = false;
		}
	});

	await check("工具抛错 → 500 且带可读 message", async () => {
		const res = await post("/api/dsh-imagekit/setup", { action: "boom" });
		assert(res.status === 500, `expected 500, got ${res.status}`);
		const body = await res.json();
		assert(body.ok === false && body.message === "boom from tool", `unexpected body ${JSON.stringify(body)}`);
	});

	await check("响应带 no-store，设置页不会缓存", async () => {
		const res = await post("/api/dsh-imagekit/setup", { action: "status" });
		assert(res.headers.get("cache-control") === "no-store", "missing cache-control: no-store");
	});
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n✓ ${passed} 项路由断言通过`);
