/**
 * dsh-imagekit / lib/generate/direct.js — 内置直连生成后端
 * ============================================================
 * 目标：新用户装完插件、下完引擎与模型就能直接出图，**不需要自备任何外部网关服务**，
 * 也不额外起 Python 进程（无窗口、无端口占用）。
 *
 * 做法：直接在 Node 里拼 ComfyUI 的 API 工作流（JSON 图），POST /prompt → 轮询 /history → 下载 /view。
 * 只依赖 ComfyUI 本身（用户本来就要装引擎），不再依赖 FastAPI 网关。
 *
 * 覆盖范围（v1）：文生图（标准 int8 / turbo int8+LoRA）。参考图编辑类模板仍在网关侧，
 * 需要时由调用方显式报错说明，不做「静默降级」。
 */
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 支持内置直连的模板（其余模板需要网关）。 */
export const DIRECT_TEMPLATES = new Set([
	"qwen_image_2_1_t2i",
	"qwen_image_2_1_t2i_turbo",
	"turbo_official_t2i",
	"t2i_turbo",
	// 参考图编辑（1 / 3 / 6 图与通用 i2i 都用同一个 2.1 编码节点，参考图数量决定）
	"qwen_image_2_1_edit",
	"qwen_image_2_1_edit3",
	"qwen_image_2_1_edit6",
	"qwen_image_2_1_i2i"
]);

/** 走「编辑」路径的模板（有参考图时）。 */
const EDIT_TEMPLATES = new Set(["qwen_image_2_1_edit", "qwen_image_2_1_edit3", "qwen_image_2_1_edit6", "qwen_image_2_1_i2i"]);

const TURBO_TEMPLATES = new Set(["qwen_image_2_1_t2i_turbo", "turbo_official_t2i", "t2i_turbo"]);

/** 引擎探活。 */
export async function engineUp(baseUrl, signal) {
	const base = String(baseUrl ?? "").replace(/\/+$/, "");
	if (base === "") return false;
	try {
		const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]) });
		return res.ok;
	} catch {
		return false;
	}
}

/** 确保引擎在线（不在就用宿主已注册的 comfy 工具拉起；没有该工具则明确报错）。 */
export async function ensureEngine(config, ctx, signal) {
	if (await engineUp(config.baseUrl, signal)) return { started: false };
	const comfy = (() => {
		try {
			const tool = ctx?.tools?.get?.("comfy");
			return tool !== undefined && tool !== null && typeof tool.execute === "function" ? tool : null;
		} catch {
			return null;
		}
	})();
	if (comfy === null) {
		throw new Error(
			`ComfyUI engine at ${config.baseUrl} is not responding and the comfy tool is unavailable; ` +
				"start it with comfy(action=control, op=start) or image_setup(action=install, component=engine)"
		);
	}
	await comfy.execute({ action: "control", op: "start" }, { signal });
	const deadline = Date.now() + Math.max(30, Number(config.startTimeoutSeconds ?? 90)) * 1000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		if (await engineUp(config.baseUrl, signal)) return { started: true };
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	}
	throw new Error(`ComfyUI engine did not become ready within ${config.startTimeoutSeconds ?? 90}s at ${config.baseUrl}`);
}

/** 从 ComfyUI 的模型清单里挑出 Qwen-Image 2.1 需要的文件（缓存一次）。 */
let modelCache = null;
export async function resolveModels(baseUrl, signal) {
	if (modelCache !== null) return modelCache;
	const info = async (node) => (await fetch(`${baseUrl}/object_info/${node}`, { signal })).json();
	const [unet, clip, vae, lora] = await Promise.all([
		info("UNETLoader"),
		info("CLIPLoader"),
		info("VAELoader"),
		info("LoraLoaderModelOnly")
	]);
	const unets = unet?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
	const clips = clip?.CLIPLoader?.input?.required?.clip_name?.[0] ?? [];
	const clipTypes = clip?.CLIPLoader?.input?.required?.type?.[0] ?? [];
	const vaes = vae?.VAELoader?.input?.required?.vae_name?.[0] ?? [];
	const loras = lora?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];

	const pick = (list, test, what) => {
		const hit = list.find((name) => test(String(name)));
		if (hit === undefined) throw new Error(`ComfyUI has no ${what} matching the Qwen-Image 2.1 expectations; install the model pack (image_setup action=install component=models pack=core)`);
		return hit;
	};
	const resolved = {
		unet: pick(unets, (n) => /qwen_image_2\.1/i.test(n) && !/turbo/i.test(n), "base diffusion model"),
		unetTurbo: pick(unets, (n) => /qwen_image_2\.1/i.test(n) && /turbo/i.test(n), "turbo diffusion model"),
		clip: pick(clips, (n) => /qwen3vl_8b/i.test(n) || /text_encoder/i.test(n), "Qwen text encoder"),
		clipType: clipTypes.includes("qwen_image") ? "qwen_image" : clipTypes[0],
		vae: pick(vaes, (n) => /qwen_image_2\.1/i.test(n) && /vae/i.test(n), "Qwen VAE"),
		lora: loras.find((n) => /turbo/i.test(String(n))) ?? null
	};
	modelCache = resolved;
	return resolved;
}

/** 拼文生图工作流（与官方示例同构：UNETLoader/CLIPLoader/VAELoader/CLIPTextEncode/KSampler/VAEDecode/SaveImage）。 */
export function buildT2IGraph({ models, prompt, negative = "", width, height, steps, cfg, seed, batchSize = 1, turbo = false, savePrefix = "dsh-imagekit/t2i" }) {
	const useTurbo = turbo && models.unetTurbo !== null && models.lora !== null;
	const graph = {
		1: { class_type: "UNETLoader", inputs: { unet_name: useTurbo ? models.unetTurbo : models.unet, weight_dtype: "default" } },
		2: { class_type: "CLIPLoader", inputs: { clip_name: models.clip, type: models.clipType } },
		3: { class_type: "VAELoader", inputs: { vae_name: models.vae } },
		4: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
		5: { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["2", 0] } },
		6: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: batchSize } },
		7: {
			class_type: "KSampler",
			inputs: {
				model: ["1", 0],
				seed,
				steps,
				cfg,
				sampler_name: "euler",
				scheduler: "simple",
				positive: ["4", 0],
				negative: ["5", 0],
				latent_image: ["6", 0],
				denoise: 1
			}
		},
		8: { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
		9: { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: savePrefix } }
	};
	if (useTurbo) {
		graph[10] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: models.lora, strength_model: 1 } };
		graph[7].inputs.model = ["10", 0];
	}
	return graph;
}

/** 把本地参考图上传到 ComfyUI 的 input 目录，返回 LoadImage 可用的名字。 */
export async function uploadImage(baseUrl, filePath, { signal } = {}) {
	const { readFileSync } = await import("node:fs");
	const base = String(baseUrl).replace(/\/+$/, "");
	const buf = readFileSync(filePath);
	const ext = path.extname(filePath).toLowerCase() || ".png";
	const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
	const form = new FormData();
	form.append("image", new Blob([buf], { type }), `dsh-ref-${Date.now()}${ext}`);
	form.append("overwrite", "true");
	const res = await fetch(`${base}/upload/image`, { method: "POST", body: form, signal });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`ComfyUI /upload/image HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
	const name = body.name ?? body.info?.name;
	if (typeof name !== "string" || name === "") throw new Error(`ComfyUI /upload/image returned no filename: ${JSON.stringify(body).slice(0, 300)}`);
	const subfolder = typeof body.subfolder === "string" ? body.subfolder : "";
	return subfolder === "" ? name : `${subfolder}/${name}`;
}

/**
 * 拼参考图编辑工作流（Qwen-Image 2.1）：
 *   LoadImage × N → TextEncodeQwenImage21（输出 positive/negative/latent）→ KSampler → VAEDecode → SaveImage
 * 2.1 的编码节点把参考图直接拼进序列，不需要额外的 VAEEncode/ReferenceLatent。
 */
export function buildEditGraph({ models, prompt, negative = "", resolution = 1024, refNames, steps, cfg, seed, turbo = false }) {
	const graph = {
		1: { class_type: "UNETLoader", inputs: { unet_name: models.unet, weight_dtype: "default" } },
		2: { class_type: "CLIPLoader", inputs: { clip_name: models.clip, type: models.clipType } },
		3: { class_type: "VAELoader", inputs: { vae_name: models.vae } }
	};
	const images = {};
	let next = 4;
	const imageNodes = [];
	for (const name of refNames) {
		graph[next] = { class_type: "LoadImage", inputs: { image: name } };
		imageNodes.push(String(next));
		images[`image_${imageNodes.length}`] = [String(next), 0];
		next += 1;
	}
	graph[next] = {
		class_type: "TextEncodeQwenImage21",
		inputs: { clip: ["2", 0], prompt, negative_prompt: negative, resolution, vae: ["3", 0], images }
	};
	const encode = String(next);
	next += 1;
	graph[next] = {
		class_type: "KSampler",
		inputs: {
			model: ["1", 0],
			seed,
			steps,
			cfg,
			sampler_name: "euler",
			scheduler: "simple",
			positive: [encode, 0],
			negative: [encode, 1],
			latent_image: [encode, 2],
			denoise: 1
		}
	};
	const sampler = String(next);
	next += 1;
	graph[next] = { class_type: "VAEDecode", inputs: { samples: [sampler, 0], vae: ["3", 0] } };
	const decode = String(next);
	next += 1;
	graph[next] = { class_type: "SaveImage", inputs: { images: [decode, 0], filename_prefix: "dsh-imagekit/edit" } };
	if (turbo && models.unetTurbo !== null && models.lora !== null) {
		const lora = String(next + 1);
		graph[lora] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: models.lora, strength_model: 1 } };
		graph["1"].inputs.unet_name = models.unetTurbo;
		graph[sampler].inputs.model = [lora, 0];
	}
	return graph;
}

/** 提交工作流并等到执行结束；返回 ComfyUI 的输出图片引用。 */
export async function submitAndWait(baseUrl, graph, { signal, timeoutMs = 900000 } = {}) {
	const base = String(baseUrl).replace(/\/+$/, "");
	const res = await fetch(`${base}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
		signal
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`ComfyUI /prompt HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
	const promptId = body.prompt_id;
	if (!promptId) throw new Error(`ComfyUI /prompt did not return prompt_id: ${JSON.stringify(body).slice(0, 300)}`);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000));
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const hist = await (await fetch(`${base}/history/${promptId}`, { signal })).json().catch(() => ({}));
		const entry = hist?.[promptId];
		if (entry === undefined) continue;
		const status = entry.status ?? {};
		if (status.status_str === "error") {
			const messages = (status.messages ?? []).filter((m) => m?.[0] === "execution_error");
			throw new Error(`ComfyUI execution failed: ${JSON.stringify(messages[0]?.[1] ?? status).slice(0, 500)}`);
		}
		if (status.completed === true) {
			const images = [];
			for (const output of Object.values(entry.outputs ?? {})) {
				for (const image of output?.images ?? []) if (image?.filename) images.push(image);
			}
			return { promptId, images };
		}
	}
	throw new Error(`ComfyUI job ${promptId} did not finish within ${Math.round(timeoutMs / 1000)}s; check comfy(action=status) for the queue`);
}

/** 把输出图片下载到本地临时目录，返回 { filename: 本地路径 }（与 saveImages 的入参形状一致）。 */
export async function downloadImages(baseUrl, images, { signal } = {}) {
	const base = String(baseUrl).replace(/\/+$/, "");
	const dir = path.join(os.tmpdir(), "dsh-imagekit-direct");
	mkdirSync(dir, { recursive: true });
	const out = [];
	for (const image of images) {
		const url = `${base}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? "")}&type=${encodeURIComponent(image.type ?? "output")}`;
		const res = await fetch(url, { signal });
		if (!res.ok) throw new Error(`ComfyUI /view HTTP ${res.status} for ${image.filename}`);
		const dest = path.join(dir, `${Date.now()}-${path.basename(String(image.filename))}`);
		await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
		out.push({ filename: dest, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
	}
	return out;
}

/** 让 ComfyUI 卸载模型并释放显存（与网关的 /free 等价）。 */
export async function freeModels(baseUrl, { signal } = {}) {
	const base = String(baseUrl).replace(/\/+$/, "");
	const res = await fetch(`${base}/free`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ unload_models: true, free_memory: true }),
		signal
	});
	if (!res.ok) throw new Error(`ComfyUI /free HTTP ${res.status}`);
	return { freed_at: new Date().toISOString() };
}

/** 空闲自动卸载：每次生成后重置计时器；到点调 /free 把模型请出显存（进程退出不影响，timer 已 unref）。 */
let idleTimer = null;
export function scheduleIdleFree(baseUrl, minutes) {
	const mins = Number(minutes);
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	if (!Number.isFinite(mins) || mins <= 0) return;
	idleTimer = setTimeout(() => {
		idleTimer = null;
		freeModels(baseUrl).catch(() => {});
	}, mins * 60_000);
	if (typeof idleTimer.unref === "function") idleTimer.unref();
}

/** 一站式：确保引擎 → 拼图 → 执行 → 下载，返回 { images, prompt_id, engine_started }。 */
export async function generateDirect(config, ctx, args, { signal } = {}) {
	const engine = await ensureEngine(config, ctx, signal);
	const models = await resolveModels(config.baseUrl, signal);
	const turboSteps = args.turbo ? 6 : args.steps;
	const isEdit = Array.isArray(args.refImages) && args.refImages.length > 0;
	const requestedSeed = Number(args.seed);
	const seed = Number.isFinite(requestedSeed) && requestedSeed >= 0 ? Math.floor(requestedSeed) : Math.floor(Math.random() * 4294967295);
	const graph = isEdit
		? buildEditGraph({
				models,
				prompt: args.prompt,
				negative: args.negativePrompt ?? "",
				resolution: args.resolution ?? 1024,
				refNames: await Promise.all(args.refImages.map((file) => uploadImage(config.baseUrl, file, { signal }))),
				steps: turboSteps,
				cfg: args.turbo ? 1 : args.cfg,
				seed,
				turbo: args.turbo === true
			})
		: buildT2IGraph({
				models,
				prompt: args.prompt,
				negative: args.negativePrompt ?? "",
				width: args.width,
				height: args.height,
				steps: turboSteps,
				cfg: args.turbo ? 1 : args.cfg,
				seed,
				batchSize: args.batchSize ?? 1,
				turbo: args.turbo === true
			});
	const { promptId, images } = await submitAndWait(config.baseUrl, graph, { signal, timeoutMs: Math.max(60, Number(config.timeoutSeconds ?? 900)) * 1000 });
	if (images.length === 0) throw new Error("ComfyUI finished but produced no images (check the SaveImage node / templates)");
	const local = await downloadImages(config.baseUrl, images, { signal });
	// 空闲自动卸载：默认 10 分钟（config.idleFreeMinutes），下次生成会重置计时
	scheduleIdleFree(config.baseUrl, config.idleFreeMinutes ?? 10);
	return { images: local, prompt_id: promptId, engine_started: engine.started, backend: "direct", seed, steps: turboSteps, mode: isEdit ? "edit" : "t2i" };
}

export { TURBO_TEMPLATES };
