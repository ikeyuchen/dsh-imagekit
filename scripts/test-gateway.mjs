/**
 * 网关链路离线测试：起一个兼容插件协议的本地 mock gateway（自动选空闲端口），
 * 用真实的 registerImageGenTools 注册工具，逐项验证：
 *   image_generate（t2i / 编辑 / denoise / 多图 / batch / unload_after / seed）
 *   image_generate_raw（from_template / inline graph）
 *   image_workflow_inspect
 *   image_service_status（up 分支）
 *   generationBackend=auto 时优先网关
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerImageGenTools } from "../lib/generate/tools.js";

let PORT = 0;
const FIXTURE = fileURLToPath(new URL("../docs/icon.png", import.meta.url));
const requests = [];
const results = new Map();
const pendingOnce = new Set();
let seq = 0;
let freeCalls = 0;
let debugCalls = [];
let rawBodies = [];

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};
const readBody = async (req) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	return text === "" ? null : JSON.parse(text);
};
const mockGraph = {
	"1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mock.safetensors" } },
	"2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } }
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	const pathname = url.pathname;
	try {
		if (pathname === "/health") return json(res, 200, { ok: true, engine: "up" });
		if (pathname === "/status") {
			return json(res, 200, { queue_running: 0, queue_pending: 0, vram: { free_vram_gb: 9.5 }, comfyui_version: "0.44.0-mock" });
		}
		if (pathname === "/workflows") return json(res, 200, { workflows: ["qwen_image_2_1_t2i", "qwen_image_2_1_edit3", "qwen_image_2_1_edit6"] });
		if (pathname === "/free") {
			freeCalls += 1;
			return json(res, 200, { freed_at: new Date().toISOString() });
		}
		if (pathname.startsWith("/debug/workflow/")) {
			debugCalls.push({ name: decodeURIComponent(pathname.slice("/debug/workflow/".length)), query: Object.fromEntries(url.searchParams) });
			return json(res, 200, mockGraph);
		}
		if (pathname === "/generate/async" && req.method === "POST") {
			const body = await readBody(req);
			requests.push({ kind: "generate", body });
			if (String(body.prompt ?? "").includes("NO_ID")) return json(res, 200, {});
			const id = `gen-${++seq}`;
			if (String(body.prompt ?? "").includes("NO_IMAGES")) results.set(id, []);
			else {
				const count = Math.max(1, Number(body.batch_size) || 1);
				results.set(id, Array.from({ length: count }, () => ({ filename: FIXTURE, url: "mock", bytes: statSync(FIXTURE).size })));
			}
			if (String(body.prompt ?? "").includes("PENDING_ONCE")) pendingOnce.add(id);
			return json(res, 200, { prompt_id: id });
		}
		if (pathname === "/raw" && req.method === "POST") {
			const body = await readBody(req);
			rawBodies.push(body);
			const id = `raw-${++seq}`;
			results.set(id, [{ filename: FIXTURE, url: "mock", bytes: statSync(FIXTURE).size }]);
			return json(res, 200, { prompt_id: id });
		}
		if (pathname.startsWith("/result/")) {
			const id = pathname.slice("/result/".length);
			if (pendingOnce.has(id)) {
				pendingOnce.delete(id);
				return json(res, 404, { detail: "pending" });
			}
			const images = results.get(id);
			if (!images) return json(res, 404, { detail: "pending" });
			return json(res, 200, { status: "completed", images });
		}
		return json(res, 404, { detail: `no route ${pathname}` });
	} catch (error) {
		return json(res, 500, { detail: String(error?.message ?? error) });
	}
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
PORT = server.address().port;

const makeTools = (generationBackend) => {
	const tools = [];
	const ctx = {
		tools: { register: (d) => { tools.push(d); return () => {}; }, get: () => undefined },
		get: () => undefined
	};
	registerImageGenTools(
		ctx,
		{
			gatewayUrl: `http://127.0.0.1:${PORT}`,
			generationBackend,
			comfyBaseUrl: "http://127.0.0.1:8188",
			timeoutSeconds: 60,
			selfHealWaitSeconds: 10,
			outputDir: mkdtempSync(path.join(tmpdir(), `imagekit-gw-${generationBackend}-`))
		},
		60000,
		{ includeAdvanced: true }
	);
	const byName = (name) => {
		const tool = tools.find((item) => item.name === name);
		assert.ok(tool, `tool ${name} not registered`);
		return tool;
	};
	return { tools, byName, exec: { signal: new AbortController().signal } };
};

let passed = 0;
const check = async (label, fn) => {
	await fn();
	console.log(`  ✓ ${label}`);
	passed += 1;
};

console.log("网关链路");

const gw = makeTools("gateway");
const generate = gw.byName("image_generate");

await check("t2i：tier/尺寸/seed/batch 进入请求体，结果按 batch 保存", async () => {
	const before = requests.length;
	const out = await generate.execute(
		{ prompt: "a red apple", tier: "standard", batch_size: 2, unload_after: true, negative_prompt: "blur", cfg: 2 },
		gw.exec
	);
	const body = requests[before].body;
	assert.equal(body.template, "qwen_image_2_1_t2i");
	assert.equal(body.width, 1536);
	assert.equal(body.height, 1536);
	assert.equal(body.steps, 25);
	assert.equal(body.cfg, 2);
	assert.equal(body.negative_prompt, "blur");
	assert.equal(body.batch_size, 2);
	assert.ok(Number.isInteger(body.seed) && body.seed >= 0, `seed should be resolved, got ${body.seed}`);
	assert.equal(out.backend, "gateway");
	assert.ok(out.prompt_id, "gateway result must carry prompt_id");
	assert.equal(out.meta.seed, body.seed);
	assert.equal(out.meta.backend, "gateway");
	assert.equal(out.images.length, 2);
	assert.equal(out.saved.length, 2);
	assert.equal(out.preflight.queue_running, 0);
	assert.equal(out.preflight.vram_free_gb, 9.5);
	assert.equal(freeCalls, 1, "unload_after should call /free once");
});

await check("/result 首次 404（pending）后继续轮询成功", async () => {
	const out = await generate.execute({ prompt: "PENDING_ONCE apple", tier: "draft" }, gw.exec);
	assert.equal(out.backend, "gateway");
	assert.equal(out.images.length, 1);
});

await check("/result completed 但无图：明确失败，不空转", async () => {
	await assert.rejects(
		() => generate.execute({ prompt: "NO_IMAGES apple", tier: "draft" }, gw.exec),
		/terminal state "completed" with no images/
	);
});

await check("/generate/async 缺 prompt_id：明确失败", async () => {
	await assert.rejects(
		() => generate.execute({ prompt: "NO_ID apple", tier: "draft" }, gw.exec),
		/did not return a prompt_id/
	);
});

await check("编辑 + denoise<1 + 单图：自动选 i2i，denoise/refs 进入请求体", async () => {
	const before = requests.length;
	const out = await generate.execute(
		{ prompt: "改成蓝色", ref_images: [FIXTURE], denoise: 0.8, tier: "standard" },
		gw.exec
	);
	const body = requests[before].body;
	assert.equal(body.template, "qwen_image_2_1_i2i");
	assert.equal(body.denoise, 0.8);
	assert.equal(body.ref_images.length, 1);
	assert.equal(body.resolution, 1056);
	assert.ok(Number.isInteger(body.seed) && body.seed >= 0);
	assert.equal(out.meta.seed, body.seed);
});

await check("3 张参考图 → edit3；6 张 → edit6", async () => {
	const before = requests.length;
	await generate.execute({ prompt: "合成", ref_images: [FIXTURE, FIXTURE, FIXTURE] }, gw.exec);
	assert.equal(requests[before].body.template, "qwen_image_2_1_edit3");
	await generate.execute({ prompt: "合成", ref_images: Array(6).fill(FIXTURE) }, gw.exec);
	assert.equal(requests[before + 1].body.template, "qwen_image_2_1_edit6");
});

await check("显式 t2i + ref_images：本地显式报错，不发网关请求", async () => {
	const before = requests.length;
	await assert.rejects(
		() => generate.execute({ prompt: "x", template: "qwen_image_2_1_t2i", ref_images: [FIXTURE] }, gw.exec),
		/ignores ref_images/
	);
	assert.equal(requests.length, before, "should fail before hitting the gateway");
});

await check("from_template：先 /debug/workflow，再 /raw，结果走网关 meta", async () => {
	const raw = gw.byName("image_generate_raw");
	const before = rawBodies.length;
	const out = await raw.execute({ from_template: "qwen_image_2_1_t2i", prompt: "x", width: 512, height: 512 }, gw.exec);
	assert.ok(debugCalls.some((call) => call.name === "qwen_image_2_1_t2i"));
	assert.equal(rawBodies.length, before + 1);
	assert.deepEqual(rawBodies[before], mockGraph);
	assert.equal(out.meta.backend, "gateway");
	assert.equal(out.meta.source, "template:qwen_image_2_1_t2i");
});

await check("inline workflow：/raw 收到原图，附 node_overrides 生效", async () => {
	const raw = gw.byName("image_generate_raw");
	const before = rawBodies.length;
	const out = await raw.execute(
		{ workflow: mockGraph, node_overrides: { "1": { inputs: { ckpt_name: "patched.safetensors" } } } },
		gw.exec
	);
	assert.equal(rawBodies.length, before + 1);
	assert.equal(rawBodies[before]["1"].inputs.ckpt_name, "patched.safetensors");
	assert.equal(out.meta.source, "inline graph");
	assert.equal(out.meta.backend, "gateway");
});

await check("image_workflow_inspect：返回节点与解析后的图", async () => {
	const inspect = gw.byName("image_workflow_inspect");
	const out = await inspect.execute({ template: "qwen_image_2_1_t2i", width: 512, height: 512, steps: 8 }, gw.exec);
	assert.equal(out.template, "qwen_image_2_1_t2i");
	assert.equal(out.nodeCount, 2);
	assert.deepEqual(out.nodes.map((n) => n.class_type), ["CheckpointLoaderSimple", "PreviewImage"]);
	assert.deepEqual(out.placeholdersRemaining, []);
	assert.ok(debugCalls.some((call) => call.name === "qwen_image_2_1_t2i" && call.query.width === "512" && call.query.steps === "8"));
});

await check("image_service_status：up 分支带 queue/workflows/tiers", async () => {
	const status = gw.byName("image_service_status");
	const out = await status.execute({}, gw.exec);
	assert.equal(out.up, true);
	assert.equal(out.queue.queue_running, 0);
	assert.equal(out.queue.vram.free_vram_gb, 9.5);
	assert.ok(out.workflows.includes("qwen_image_2_1_edit3"));
	assert.ok(out.tiers.standard);
});

await check("generationBackend=auto 且网关在线：走网关而不是直连", async () => {
	const auto = makeTools("auto");
	const before = requests.length;
	const out = await auto.byName("image_generate").execute({ prompt: "x", tier: "draft" }, auto.exec);
	assert.equal(requests.length, before + 1);
	assert.equal(requests[before].body.template, "qwen_image_2_1_t2i_turbo");
	assert.equal(requests[before].body.width, 1056);
	assert.equal(requests[before].body.steps, 8);
	assert.equal(out.backend, "gateway");
});

await new Promise((resolve) => server.close(resolve));
console.log(`\n✓ ${passed} 项网关链路断言通过`);
