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
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
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
		// 两个 UNET 都可缺：只装 core 的用户没有 turbo，只装 fast 的用户没有 base。
		// 以前两个都硬校验，导致「只装 core」的干净安装直接报 “no turbo diffusion model” 而完全不能出图。
		unet: unets.find((n) => /qwen_image_2\.1/i.test(n) && !/turbo/i.test(n)) ?? null,
		unetTurbo: unets.find((n) => /qwen_image_2\.1/i.test(n) && /turbo/i.test(n)) ?? null,
		clip: pick(clips, (n) => /qwen3vl_8b/i.test(n) || /text_encoder/i.test(n), "Qwen text encoder"),
		clipType: clipTypes.includes("qwen_image") ? "qwen_image" : clipTypes[0],
		vae: pick(vaes, (n) => /qwen_image_2\.1/i.test(n) && /vae/i.test(n), "Qwen VAE"),
		lora: loras.find((n) => /turbo/i.test(String(n))) ?? null
	};
	if (resolved.unet === null && resolved.unetTurbo === null) {
		throw new Error(
			"ComfyUI has no Qwen-Image 2.1 diffusion model; install a model pack (image_setup action=install component=models pack=core)"
		);
	}
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
	// turbo 有两情况：官方 turbo 模型（+可选 LoRA）或 base + turbo LoRA；两者都挂 LoraLoader。
	if (turbo && models.lora !== null) {
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
	if (turbo && models.lora !== null) {
		const lora = String(next + 1);
		graph[lora] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: models.lora, strength_model: 1 } };
		if (models.unetTurbo !== null) graph["1"].inputs.unet_name = models.unetTurbo;
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
			const detail = JSON.stringify(messages[0]?.[1] ?? status).slice(0, 500);
			throw new Error(`ComfyUI execution failed: ${detail}${engineFailureHint(detail)}`);
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
		out.push({ filename: dest, bytes: statSync(dest).size, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
	}
	return out;
}

/**
 * 直连提交任意 API 格式图（image_generate_raw 的离线路径）。
 * 只要求本机 ComfyUI；不再强依赖外部网关。调用方负责图的结构与占位符自检。
 */
export async function generateGraphDirect(config, ctx, graph, { signal, timeoutMs = 900000 } = {}) {
	const baseUrl = String(config.baseUrl ?? "").replace(/\/+$/, "");
	await ensureEngine({ baseUrl, startTimeoutSeconds: config.startTimeoutSeconds ?? 90 }, ctx, signal);
	const { promptId, images } = await submitAndWait(baseUrl, graph, { signal, timeoutMs });
	if (images.length === 0) {
		throw new Error("ComfyUI finished but produced no images (check the SaveImage / output nodes in the graph)");
	}
	const local = await downloadImages(baseUrl, images, { signal });
	scheduleIdleFree(baseUrl, config.idleFreeMinutes ?? 10, config.idleRecycle);
	return { prompt_id: promptId, images: local, backend: "direct" };
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

/**
 * 引擎侧已知故障 → 处置建议（接在原始错误后面）。
 * 目前只有 AIMDO 的 VBAR 预留失败：那是引擎进程的虚拟地址空间碎片化，不是显存不足，
 * `/free` 释放不了那段预留，只有重启引擎进程能回收——所以别让用户对着 JSON 猜。
 */
export function engineFailureHint(text) {
	const raw = String(text ?? "");
	if (/VBAR (allocation failed|OOM)|Could not rese[vc]e Virtual Address space/i.test(raw)) {
		return (
			" — the engine's virtual address space is fragmented (AIMDO VBAR), not out of VRAM: unloading will not help. " +
			'Run comfy(action="control", op="restart") and retry; the first image after a restart reloads models in 7–20 s.'
		);
	}
	// 真·显存不足（与上面的 VBAR 是两回事）：给可执行的降档阶梯，而不是让调用方对着 JSON 猜。
	// 关键词来自 torch / ComfyUI / 驱动三层报错文案，宁可多匹配也不要漏——漏了就等于没有提示。
	if (/CUDA out of memory|OutOfMemoryError|allocation on device|failed to allocate|not enough memory|insufficient memory/i.test(raw)) {
		return (
			" — the engine ran out of VRAM (not a bug in the graph). Retry cheaper, in this order: " +
			'tier="draft" (1056², 8 steps) → smaller width/height (1536² → 1024²) → fewer ref_images → ' +
			"unload_after:true; close other GPU apps if it still fails. " +
			'image_prompt_guide(section="排查") has the full downgrade table.'
		);
	}
	return "";
}

/**
 * 空闲回收：每次生成后重置计时器。插件自己拉起了引擎（传了 recycle）就到点重启引擎——
 * AIMDO 时代 `/free` 释放不了 VBAR 预留，卸载等于没做；外部引擎（用户自己开的）只能退化为 `/free`。
 * 进程退出不影响，timer 已 unref。
 */
let idleTimer = null;
export function scheduleIdleFree(baseUrl, minutes, recycle) {
	const mins = Number(minutes);
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	if (!Number.isFinite(mins) || mins <= 0) return;
	idleTimer = setTimeout(() => {
		idleTimer = null;
		// 重启失败就退回轻量卸载：至少把模型请出显存
		const done = typeof recycle === "function" ? recycle() : freeModels(baseUrl);
		Promise.resolve(done).catch(() => {
			freeModels(baseUrl).catch(() => {});
		});
	}, mins * 60_000);
	if (typeof idleTimer.unref === "function") idleTimer.unref();
}

/** 官方 turbo 协议的 8 步 sigma 表（从 ComfyUI 自带官方模板 `image_qwen_image_2_1_turbo_t2i` 取出，固定值）。 */
export const OFFICIAL_TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";
/** 官方 turbo 协议的步数（sigma 表长度决定，与 `steps` 参数无关）。 */
export const OFFICIAL_TURBO_STEPS = 8;

/**
 * 官方 turbo 文生图：ManualSigmas + CFGGuider + SamplerCustomAdvanced。
 * 与 LoRA 路径的区别：不挂 LoRA、不靠 `steps`（sigma 表固定 8 步），官方口径 cfg=1。
 */
export function buildOfficialTurboT2IGraph({ models, prompt, negative = "", width, height, seed, cfg = 1, batchSize = 1, savePrefix = "dsh-imagekit/turbo-official" }) {
	return {
		1: { class_type: "UNETLoader", inputs: { unet_name: models.unetTurbo, weight_dtype: "default" } },
		2: { class_type: "CLIPLoader", inputs: { clip_name: models.clip, type: models.clipType } },
		3: { class_type: "VAELoader", inputs: { vae_name: models.vae } },
		4: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
		5: { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["2", 0] } },
		6: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: batchSize } },
		7: { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg } },
		8: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
		9: { class_type: "ManualSigmas", inputs: { sigmas: OFFICIAL_TURBO_SIGMAS } },
		10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
		11: {
			class_type: "SamplerCustomAdvanced",
			inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["6", 0] }
		},
		12: { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
		13: { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: savePrefix } }
	};
}

/**
 * 官方 turbo 编辑：参考图进 `TextEncodeQwenImage21` 序列（positive/negative/latent），
 * 再接同一张 8 步 sigma 表；官方模板的编辑版用 cfg=8。
 */
export function buildOfficialTurboEditGraph({ models, prompt, negative = "", resolution = 1024, refNames, seed, cfg = 8, savePrefix = "dsh-imagekit/turbo-official-edit" }) {
	const graph = {
		1: { class_type: "UNETLoader", inputs: { unet_name: models.unetTurbo, weight_dtype: "default" } },
		2: { class_type: "CLIPLoader", inputs: { clip_name: models.clip, type: models.clipType } },
		3: { class_type: "VAELoader", inputs: { vae_name: models.vae } }
	};
	const images = {};
	let next = 4;
	for (const name of refNames) {
		graph[next] = { class_type: "LoadImage", inputs: { image: name } };
		images[`image_${Object.keys(images).length + 1}`] = [String(next), 0];
		next += 1;
	}
	graph[next] = {
		class_type: "TextEncodeQwenImage21",
		inputs: { clip: ["2", 0], prompt, negative_prompt: negative, resolution, vae: ["3", 0], images }
	};
	const encode = String(next);
	next += 1;
	graph[next] = { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: [encode, 0], negative: [encode, 1], cfg } };
	const guider = String(next);
	next += 1;
	graph[next] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
	const sampler = String(next);
	next += 1;
	graph[next] = { class_type: "ManualSigmas", inputs: { sigmas: OFFICIAL_TURBO_SIGMAS } };
	const sigmas = String(next);
	next += 1;
	graph[next] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
	const noise = String(next);
	next += 1;
	graph[next] = {
		class_type: "SamplerCustomAdvanced",
		inputs: {
			noise: [noise, 0],
			guider: [guider, 0],
			sampler: [sampler, 0],
			sigmas: [sigmas, 0],
			latent_image: [encode, 2]
		}
	};
	const sampled = String(next);
	next += 1;
	graph[next] = { class_type: "VAEDecode", inputs: { samples: [sampled, 0], vae: ["3", 0] } };
	const decode = String(next);
	graph[next + 1] = { class_type: "SaveImage", inputs: { images: [decode, 0], filename_prefix: savePrefix } };
	return graph;
}

/**
 * 拼「部分重绘」工作流（i2i）：LoadImage → VAEEncode → KSampler(denoise<1) → VAEDecode。
 * 与编辑模板的区别：编辑是「参考图进文本序列 + 整图重绘（denoise=1）」；这条路径保留原图结构，
 * 只让模型重画 denoise 比例的部分（0.7–0.9 是保结构改内容的常用区间；0.4–0.6 只做轻微打磨）。
 */
export function buildI2IGraph({ models, prompt, negative = "", refName, steps, cfg, seed, denoise = 0.6, savePrefix = "dsh-imagekit/i2i" }) {
	return {
		1: { class_type: "UNETLoader", inputs: { unet_name: models.unet, weight_dtype: "default" } },
		2: { class_type: "CLIPLoader", inputs: { clip_name: models.clip, type: models.clipType } },
		3: { class_type: "VAELoader", inputs: { vae_name: models.vae } },
		4: { class_type: "LoadImage", inputs: { image: refName } },
		5: { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["3", 0] } },
		6: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
		7: { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["2", 0] } },
		8: {
			class_type: "KSampler",
			inputs: {
				model: ["1", 0],
				seed,
				steps,
				cfg,
				sampler_name: "euler",
				scheduler: "simple",
				positive: ["6", 0],
				negative: ["7", 0],
				latent_image: ["5", 0],
				denoise
			}
		},
		9: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
		10: { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: savePrefix } }
	};
}

/** 一站式：确保引擎 → 拼图 → 执行 → 下载，返回 { images, prompt_id, engine_started }。 */
export async function generateDirect(config, ctx, args, { signal } = {}) {
	const engine = await ensureEngine(config, ctx, signal);
	const models = await resolveModels(config.baseUrl, signal);
	const refImages = Array.isArray(args.refImages) ? args.refImages.filter((p) => typeof p === "string" && p !== "") : [];
	const denoiseArg = Number(args.denoise);
	// denoise < 1 = 部分重绘（保结构）：走 VAEEncode + KSampler(denoise)，与编辑模板是两条不同的路径。
	const wantsI2I = Number.isFinite(denoiseArg) && denoiseArg > 0 && denoiseArg < 1;
	const wantsTurbo = args.turbo === true && !wantsI2I;
	// 官方 turbo 协议优先（只要 turbo 模型，不需要 LoRA）；没有 turbo 模型时才退回 LoRA 路径（base + turbo LoRA）。
	const officialTurbo = wantsTurbo && models.unetTurbo !== null;
	const loraTurbo = wantsTurbo && !officialTurbo && models.lora !== null && models.unet !== null;
	// 请求的运行模式和磁盘上实际有的模型对不上时显式报错——不静默降级到另一条路线。
	if (wantsI2I) {
		if (refImages.length !== 1) {
			throw new Error(
				`denoise ${denoiseArg} (partial redraw) needs exactly one ref image as the init image; got ${refImages.length}`
			);
		}
		if (models.unet === null) {
			throw new Error(
				"partial redraw needs the base diffusion model; install it with image_setup action=install component=models pack=core"
			);
		}
	} else if (wantsTurbo && !officialTurbo && !loraTurbo) {
		throw new Error(
			"turbo/draft needs either the official turbo model (image_setup action=install component=models pack=fast) " +
				"or a turbo LoRA on the base model (models/loras/*turbo* + pack=core); or use tier=standard/quality"
		);
	} else if (!wantsTurbo && models.unet === null) {
		throw new Error(
			"standard generation needs the base diffusion model; install it with image_setup action=install component=models pack=core (the fast/full packs only carry the turbo model)"
		);
	}
	const turboSteps = officialTurbo ? OFFICIAL_TURBO_STEPS : loraTurbo ? 6 : args.steps;
	const isEdit = refImages.length > 0;
	const requestedSeed = Number(args.seed);
	const seed = Number.isFinite(requestedSeed) && requestedSeed >= 0 ? Math.floor(requestedSeed) : Math.floor(Math.random() * 4294967295);
	let graph;
	let mode;
	if (wantsI2I) {
		graph = buildI2IGraph({
			models,
			prompt: args.prompt,
			negative: args.negativePrompt ?? "",
			refName: await uploadImage(config.baseUrl, refImages[0], { signal }),
			steps: args.steps,
			cfg: args.cfg ?? 1,
			seed,
			denoise: denoiseArg
		});
		mode = "i2i";
	} else if (isEdit) {
		if (officialTurbo) {
			graph = buildOfficialTurboEditGraph({
				models,
				prompt: args.prompt,
				negative: args.negativePrompt ?? "",
				resolution: args.resolution ?? 1024,
				refNames: await Promise.all(refImages.map((file) => uploadImage(config.baseUrl, file, { signal }))),
				seed
			});
		} else {
			graph = buildEditGraph({
				models,
				prompt: args.prompt,
				negative: args.negativePrompt ?? "",
				resolution: args.resolution ?? 1024,
				refNames: await Promise.all(refImages.map((file) => uploadImage(config.baseUrl, file, { signal }))),
				steps: turboSteps,
				cfg: args.cfg,
				seed,
				turbo: loraTurbo
			});
		}
		mode = "edit";
	} else {
		if (officialTurbo) {
			graph = buildOfficialTurboT2IGraph({
				models,
				prompt: args.prompt,
				negative: args.negativePrompt ?? "",
				width: args.width,
				height: args.height,
				seed,
				batchSize: args.batchSize ?? 1
			});
		} else {
			graph = buildT2IGraph({
				models,
				prompt: args.prompt,
				negative: args.negativePrompt ?? "",
				width: args.width,
				height: args.height,
				steps: turboSteps,
				cfg: args.cfg,
				seed,
				batchSize: args.batchSize ?? 1,
				turbo: loraTurbo
			});
		}
		mode = "t2i";
	}
	const { promptId, images } = await submitAndWait(config.baseUrl, graph, { signal, timeoutMs: Math.max(60, Number(config.timeoutSeconds ?? 900)) * 1000 });
	if (images.length === 0) throw new Error("ComfyUI finished but produced no images (check the SaveImage node / templates)");
	const local = await downloadImages(config.baseUrl, images, { signal });
	// 空闲自动卸载：默认 10 分钟（config.idleFreeMinutes），下次生成会重置计时
	scheduleIdleFree(config.baseUrl, config.idleFreeMinutes ?? 10, config.idleRecycle);
	return { images: local, prompt_id: promptId, engine_started: engine.started, backend: "direct", seed, steps: turboSteps, mode };
}

export { TURBO_TEMPLATES };
