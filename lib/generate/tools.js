/**
 * dsh-plugin-image-gen / lib/tools.js
 * ===================================
 * 四个模型可见工具的注册体（从 lib/index.js 拆出，纯代码移动）：
 * image_generate / image_workflow_inspect / image_generate_raw / image_service_status。
 * 引擎/网关自愈与 HTTP 客户端在 ./gateway.js；档位表在 ../tiers.json（经 ./tiers.js 加载）。
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TEMPLATE_NAME_RE, loadTiers, resolveTierArgs } from "./tiers.js";
import {
	ENGINE_LOG_DIR,
	GATEWAY_LOG_DIR,
	GATEWAY_WAIT_MS,
	callGateway,
	callGatewaySoft,
	ensureBackendReady,
	gatewayHealth,
	rethrowIfAborted,
	sleepAbortable,
	tailFile,
} from "./gateway.js";
import { DIRECT_TEMPLATES, generateDirect } from "./direct.js";

/** 并发去重表：移到插件实例作用域（见 registerImageGenTools）——模块级共享状态
 *  会让多实例/HMR 替换后彼此串台，违反防御模式「共享状态必须挂在服务/实例上」。 */

/**
 * 档位注册表（v1.5.0）：draft / standard / quality 预设外置在插件根 tiers.json，
 * 增删档位 = 改 JSON 不改代码（重启 DSH 生效）。加载失败不抛错也不给默认档位——
 * 带 tier 的调用会拿到指明修法的显式错误，核心生成路径不受影响（见 lib/tiers.js）。
 */
const { tiers: TIERS, error: TIERS_LOAD_ERROR } = loadTiers(new URL("../../tiers.json", import.meta.url));

/**
 * 与 image_generate 完全一致的默认参数：预览/提交都对得上，不让两边默认值悄悄跑偏。
 * 默认值单点维护——默认模板名与编辑参数一并入表，请求体/meta 都从这里取；
 * 去重键已由请求体派生（P0），三处不再各自硬编码一份（否则改一处漏两处，去重等价性同遭破坏）。
 */
const DEFAULT_TEMPLATE = "qwen_image_2_1_t2i";
/**
 * 选择出图后端：
 *  - `generationBackend=direct`：只用内置直连（不碰网关）；
 *  - `gateway`：只用外部网关（保行为不变）；
 *  - `auto`（默认）：网关在线就走网关，离线就用内置直连（免去用户自备网关）。
 * 内置直连只覆盖文生图模板；编辑类模板仍需要网关，此时明确报错而不是静默降级。
 */
const TURBO_TEMPLATES_LOCAL = new Set(["qwen_image_2_1_t2i_turbo", "turbo_official_t2i", "t2i_turbo"]);

async function pickBackend(config, template, signal) {
	const mode = String(config.generationBackend ?? "auto");
	const templateName = String(template ?? DEFAULT_TEMPLATE);
	if (mode === "direct") return "direct";
	if (mode === "gateway") return "gateway";
	let health = "gateway-down";
	try {
		health = await gatewayHealth(config.gatewayUrl, signal);
	} catch (error) {
		rethrowIfAborted(error, signal);
		health = "gateway-down";
	}
	if (health !== "gateway-down") return "gateway";
	if (!DIRECT_TEMPLATES.has(templateName)) {
		throw new Error(
			`template "${templateName}" needs the external image gateway (${config.gatewayUrl}), which is unreachable, and the built-in backend only covers ${[...DIRECT_TEMPLATES].join(", ")}. ` +
				"Either start that gateway, or use a text-to-image template (tier=draft/standard/quality)."
		);
	}
	return "direct";
}

const EDIT_TEMPLATE = "qwen_image_2_1_edit";
const GEN_DEFAULTS = { width: 1024, height: 1024, steps: 25, cfg: 1.0, seed: -1, batch_size: 1 };
const EDIT_DEFAULTS = { resolution: 1056, denoise: 1.0 };

/**
 * 参考图必须配 edit/i2i 模板（t2i 模板根本不吃 ref_images，网关会直接忽略）。
 * 过去的失败模式：用户说“把这张图里的猫改成狗”，模型传了 ref_images 却用默认 t2i，
 * 结果参考图被静默丢弃、生成一张无关新图。这里给出明确决策：
 *   - 没显式指定 template（或档位给的是 t2i 系） → 自动改走编辑模板；
 *   - 用户显式给了 t2i 模板 → 报错并指明改法（不静默纠正用户意图）。
 * 导出供离线测试使用（不依赖 cordis 上下文）。
 */
export function resolveTemplateForRefs({ effectiveTemplate, explicitTemplate, refCount }) {
	if (!refCount) return { template: effectiveTemplate, switched: false };
	const tpl = effectiveTemplate ?? DEFAULT_TEMPLATE;
	const isTextOnly = tpl.includes("t2i");
	if (!isTextOnly) return { template: tpl, switched: false };
	if (typeof explicitTemplate === "string" && explicitTemplate !== "") {
		throw new Error(
			`template "${explicitTemplate}" is text-to-image and ignores ref_images. ` +
				`For image editing pass template: "${EDIT_TEMPLATE}" (or "qwen_image_2_1_edit3" / "qwen_image_2_1_i2i"), or drop template to let it pick the edit path automatically.`
		);
	}
	return { template: EDIT_TEMPLATE, switched: true };
}

/** 拼 `/debug/workflow/{name}` 的查询串（网关默认值是 steps=20/cfg=4.0，与本插件不同，所以显式传）。 */
function templatePreviewQuery(args) {
	return new URLSearchParams({
		prompt: args.prompt ?? "debug",
		width: String(args.width ?? GEN_DEFAULTS.width),
		height: String(args.height ?? GEN_DEFAULTS.height),
		steps: String(args.steps ?? GEN_DEFAULTS.steps),
		cfg: String(args.cfg ?? GEN_DEFAULTS.cfg),
		seed: String(args.seed ?? GEN_DEFAULTS.seed),
		batch_size: String(args.batch_size ?? GEN_DEFAULTS.batch_size),
		negative_prompt: args.negative_prompt ?? ""
	}).toString();
}

/**
 * 模板名只允许单层名字：网关侧只取 basename，这里也堵住穿越写法。
 * 复用 tiers.js 导出的同一份 TEMPLATE_NAME_RE（此前是手工拷贝的第二份，
 * 两处独立维护必然漂移）；错误信息也不再硬编码盘上路径，指向可发现的网关 workflows 目录。
 */
function assertTemplateName(name) {
	if (!TEMPLATE_NAME_RE.test(String(name))) {
		throw new Error(
			`Invalid template name ${JSON.stringify(name)}: only a bare name under the gateway workflows directory is allowed (no path, no _api.json, no leading/trailing/double dots).`
		);
	}
}

/** 递归找出仍未被替换的 __PLACEHOLDER__（模板文件里就是这些标记，直接提交必报 invalid_input_type）。 */
function findPlaceholders(value) {
	const found = new Set();
	const walk = (v) => {
		if (typeof v === "string") {
			for (const m of v.match(/__[A-Z0-9_]+__/g) ?? []) found.add(m);
			return;
		}
		if (Array.isArray(v)) {
			v.forEach(walk);
			return;
		}
		if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(value);
	return [...found];
}

/** API 格式图的节点清单（节点 id 是顶层键，节点体带 class_type）。 */
function graphNodes(graph) {
	return Object.entries(graph ?? {})
		.filter(([, v]) => v && typeof v === "object" && typeof v.class_type === "string")
		.map(([id, v]) => ({ id, class_type: v.class_type }));
}

/**
 * 把生成结果图片落到输出目录，返回 { savedTo, saved, saveError }。
 *
 * - `saveTo` 给了：只把第一张拷到指定位置（目录尾斜杠保留原文件名），维持旧语义；
 * - 没给 `saveTo`：**把所有图都拷进 Config.outputDir**，同名自动加 -1/-2 后缀，不覆盖；
 * - `outputDir` 也没配（旧部署）：保持原行为（图留在引擎输出目录），不报错。
 *
 * 数分钟生成成功后，保存失败不能把整个调用炸掉——降级为 save_error，
 * 网关侧文件名/字节数仍在。
 */
export async function saveImages(sources, saveTo, outputDir) {
	if (sources.length === 0) return {};
	try {
		if (saveTo) {
			let dest = path.resolve(saveTo);
			if (/[\\/]$/.test(saveTo)) dest = path.join(dest, path.basename(sources[0].filename));
			await mkdir(path.dirname(dest), { recursive: true });
			await copyFile(sources[0].filename, dest);
			return { savedTo: dest };
		}
		if (!outputDir) return {};
		const dir = path.resolve(outputDir);
		await mkdir(dir, { recursive: true });
		const saved = [];
		for (const source of sources) {
			const name = path.basename(String(source.filename ?? "image.png"));
			const ext = path.extname(name);
			const stem = path.basename(name, ext) || "image";
			// 同名不覆盖：已存在就加 -1/-2 后缀（同批次重跑、不同批次同序号都很常见）。
			let dest = path.join(dir, name);
			if (existsSync(dest)) {
				let index = 1;
				while (index < 1000) {
					const candidate = path.join(dir, `${stem}-${index}${ext}`);
					if (!existsSync(candidate)) {
						dest = candidate;
						break;
					}
					index += 1;
				}
			}
			await copyFile(source.filename, dest);
			saved.push(dest);
		}
		return { savedTo: saved[0], saved };
	} catch (error) {
		return { saveError: `saving to ${saveTo || outputDir} failed: ${String(error?.message ?? error).slice(0, 160)}` };
	}
}

function fmtMB(bytes) {
	return `${(bytes / 1048576).toFixed(2)} MB`;
}

/** 注册全部工具。genTimeoutMs 由 apply 按 Config.timeoutSeconds 换算后传入。 */
export function registerImageGenTools(ctx, config, genTimeoutMs, options = {}) {
	const includeAdvanced = options.includeAdvanced !== false;
	/** 并发去重表（本插件实例拥有）：完全相同的生成请求复用同一次执行。 */
	const inflightGenerations = new Map();
	// 工具硬超时必须盖住最坏链路——网关等待上限 GATEWAY_WAIT_MS(120s) +
	// 引擎冷启动 selfHealWaitSeconds（默认 420s）+ 提交 60s + 轮询余量 60s + 探测间隔松弛
	//（gatewayHealth 每轮最坏 ~24s）。固定 240s 富余在冷启动场景下会被宿主先杀：精心构造的
	// 「任务可能仍在跑，去 GET /result/{id}」恢复提示反而没机会出现，且以 AbortError 形式
	// 失败更难排查。selfHealWaitSeconds 兜底 420 与 Schema 默认一致（经 index.js 归一化时恒有值）。
	const healWaitMs =
		Number.isFinite(config.selfHealWaitSeconds) && config.selfHealWaitSeconds > 0 ? config.selfHealWaitSeconds * 1000 : 420000;
	const toolDeadlineMs = genTimeoutMs + GATEWAY_WAIT_MS + healWaitMs + 240000;
	// 后台分支需要回调自身（去掉 run_in_background 后跑同步体）。
	let imageTool;
	ctx.tools.register(imageTool = defineTool({
		name: "image_generate",
		description: "Text-to-image (local Qwen-Image-2.1); returns PNG paths.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description:
					"One caption, not keyword lists: subject→setting→style→light; concrete colors/counts; quote on-image text. zh/en; 'transparent' for alpha."
			},
			tier: {
				type: "string",
				description:
					"draft | standard (default, 25 steps) | quality (2K)."
			},
			template: {
				type: "string",
				description: "Default qwen_image_2_1_t2i. Editing: *_edit* / *i2i* (list via image_service_status)."
			},
			width: { type: "integer", description: "Width px, multiple of 32 (default 1024)." },
			height: { type: "integer", description: "Height px, multiple of 32 (default 1024)." },
			steps: { type: "integer", description: "Sampling steps (default 25)." },
			seed: { type: "integer", description: "-1 = random (default); reuse to reproduce." },
			batch_size: { type: "integer", description: "Images per call 1-8 (default 1)." },
			ref_images: {
				type: "array",
				items: { type: "string" },
				description:
					"Absolute ref paths; address as <image1>... (max 10)."
			},
			save_to: {
				type: "string",
				description:
					"Destination for the first image (trailing slash keeps name); omit to save all images into the configured output dir."
			},
			run_in_background: {
				type: "boolean",
				description: "Return jobId at once; read with job_output."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					prompt_id: { type: "string", required: true },
					images: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								filename: { type: "string" },
								url: { type: "string" },
								bytes: { type: "number" }
							}
						}
					},
					meta: { type: "object", additionalProperties: true, required: true },
					saved_to: { type: "string" },
					tier: { type: "string" },
					tier_applied: { type: "array", items: { type: "string" } }
				}
			},
			render: (_args, value) => (value?.kind === "background"
				? [{ type: "text", text: `started background job ${value.jobId}${value.label ? ` (${value.label})` : ""}; read with job_output, cancel with job_kill` }]
				: [{
				type: "text",
				text:
					`Generated ${value.images?.length ?? 0} image(s): ` +
					(value.images ?? []).map((i) => `${i.filename} (${fmtMB(i.bytes)})`).join(", ") +
					(value.tier ? `; tier=${value.tier}${value.tier_applied?.length ? ` (${value.tier_applied.join("+")} from preset)` : ""}` : "") +
					(value.saved_to ? `; copied to ${value.saved_to}` : "") +
					(value.save_error ? `; save FAILED: ${value.save_error}` : "") +
					(value.preflight?.engine_thermal ? `; engine ${value.preflight.engine_thermal}` : "") +
					(value.reused_inflight ? "; reused an identical in-flight generation (no duplicate engine call)" : "") +
					(value.preflight?.actions?.length ? `; auto-recovery: ${value.preflight.actions.join("; ")}` : "") +
					(value.preflight && (value.preflight.queue_running > 0 || value.preflight.queue_pending > 0)
						? `; queue before this job: ${value.preflight.queue_running} running, ${value.preflight.queue_pending} pending`
						: "")
			}])
		},
		timeoutMs: toolDeadlineMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (args.run_in_background === true) {
				const jobs = ctx?.get?.("jobs");
				if (jobs === null || jobs === undefined || typeof jobs.start !== "function") {
					throw new Error("run_in_background needs the jobs runtime: load dsh-jobs-local + dsh-tool-jobs, or drop the flag");
				}
				const label = `image_generate ${String(args.prompt ?? "").slice(0, 60)}`;
				const controller = new AbortController();
				let cancelReason = null;
				const jobId = jobs.start({
					kind: "image_generate",
					label,
					owner: exec?.agent?.session?.id ?? exec?.agent?.sessionId,
					...(typeof exec?.callId === "string"
						? { toolCall: { callId: exec.callId, rootCallId: exec.parentCallId ?? exec.callId } } : {}),
					run(handle) {
						const done = (async () => {
							try {
								const result = await imageTool.execute({ ...args, run_in_background: false }, {
									...exec,
									signal: AbortSignal.any([exec.signal, controller.signal].filter(Boolean)),
								});
								handle.append(JSON.stringify(result));
								return { status: "completed", result: JSON.stringify(result) };
							} catch (error) {
								return { status: cancelReason !== null ? "killed" : "failed", detail: String(error?.message ?? error) };
							}
						})();
						return {
							cancel(reason) {
								cancelReason = typeof reason === "string" && reason !== "" ? reason : "cancelled";
								controller.abort(cancelReason);
							},
							done,
						};
					},
				});
				return { kind: "background", jobId: String(jobId), label, prompt_id: `job:${jobId}`, images: [], meta: { background: true } };
			}
			// —— 档位展开（显式传参 > 档位预设 > 默认值；未知档位/表损坏显式报错，不静默回退）——
			const { args: eff, tier, applied } = resolveTierArgs(TIERS, TIERS_LOAD_ERROR, args);
			// —— 参考图 × 模板闸门：t2i 模板不消化 ref_images，见 resolveTemplateForRefs 注释 ——
			const refCount = Array.isArray(eff.ref_images) ? eff.ref_images.filter((p) => typeof p === "string" && p !== "").length : 0;
			const tplChoice = resolveTemplateForRefs({
				effectiveTemplate: eff.template,
				explicitTemplate: typeof args.template === "string" ? args.template : undefined,
				refCount
			});
			if (tplChoice.switched) eff.template = tplChoice.template;
			// —— 防重复调用：完全相同的请求并发到达时，复用同一次生成 ——
			//    （按展开后的参数去重：tier=standard 与显式等价参数命中同一次执行）
			//    去重键必须覆盖全部会改变产出的字段（resolution/denoise/ref_images
			//    也在请求体里）——直接由请求体派生，杜绝键与 body 再漂移
			const requestBody = {
				prompt: eff.prompt,
				template: eff.template ?? DEFAULT_TEMPLATE,
				width: eff.width ?? GEN_DEFAULTS.width,
				height: eff.height ?? GEN_DEFAULTS.height,
				steps: eff.steps ?? GEN_DEFAULTS.steps,
				cfg: eff.cfg ?? GEN_DEFAULTS.cfg,
				seed: eff.seed ?? GEN_DEFAULTS.seed,
				negative_prompt: eff.negative_prompt ?? "",
				batch_size: eff.batch_size ?? GEN_DEFAULTS.batch_size,
				resolution: eff.resolution ?? EDIT_DEFAULTS.resolution,
				denoise: eff.denoise ?? EDIT_DEFAULTS.denoise,
				ref_images: eff.ref_images ?? []
			};
			const dedupKey = JSON.stringify(requestBody);
			const makeJob = () => (async () => {
				const backend = await pickBackend(config, eff.template, exec?.signal);
				if (backend === "direct") {
					// 内置直连：不需要网关，也不需要 Python；只要求本机 ComfyUI 引擎与模型
					const direct = await generateDirect(
						{ baseUrl: String(config.comfyBaseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, ""), timeoutSeconds: config.timeoutSeconds, startTimeoutSeconds: config.startTimeoutSeconds },
						ctx,
						{
							prompt: requestBody.prompt,
							negativePrompt: requestBody.negative_prompt,
							width: requestBody.width,
							height: requestBody.height,
							steps: requestBody.steps,
							cfg: requestBody.cfg,
							seed: requestBody.seed,
							batchSize: requestBody.batch_size,
							turbo: TURBO_TEMPLATES_LOCAL.has(String(eff.template ?? DEFAULT_TEMPLATE))
						},
						{ signal: exec?.signal }
					);
					const { savedTo, saved, saveError } = await saveImages(direct.images, eff.save_to, config.outputDir);
					const meta = { template: eff.template ?? DEFAULT_TEMPLATE, width: requestBody.width, height: requestBody.height, steps: direct.steps ?? requestBody.steps, cfg: requestBody.cfg, seed: direct.seed ?? requestBody.seed };
					return {
						prompt_id: direct.prompt_id,
						images: direct.images,
						backend: "direct",
						...(direct.engine_started ? { engine_started: true } : {}),
						meta,
						...(savedTo ? { saved_to: savedTo } : {}),
						...(saved && saved.length > 1 ? { saved } : {}),
						...(saveError ? { save_error: saveError } : {}),
						...(tier ? { tier, tier_applied: applied } : {})
					};
				}
				const preflight = await ensureBackendReady(config, ctx, exec?.signal);
				const body = { ...requestBody, unload_after: eff.unload_after ?? false, timeout: config.timeoutSeconds };
				// v1.5.2：改为「异步提交 + 短轮询」（镜像 image_generate_raw 的已验证模式）。
				// 旧的单请求长等待（POST /generate 同步版）会被 HTTP 客户端的 300s
				// HeadersTimeout 硬限打断：>5 分钟的任务（如 4MP 编辑）实际成功但客户端报失败。
				const submitted = await callGateway(config.gatewayUrl, "/generate/async", { method: "POST", body, timeoutMs: 60000, signal: exec?.signal });
				const promptId = submitted?.prompt_id;
				if (!promptId) throw new Error(`Gateway /generate/async did not return a prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);
				const deadline = Date.now() + genTimeoutMs + 60000;
				let result = null;
				let lastStatus = "pending";
				let netErrors = 0;
				while (Date.now() < deadline) {
					await sleepAbortable(2000, exec?.signal);
					let res;
					try {
						res = await callGatewaySoft(config.gatewayUrl, `/result/${promptId}`, { timeoutMs: 20000, signal: exec?.signal });
						netErrors = 0;
					} catch (error) {
						rethrowIfAborted(error, exec?.signal);
						// 任务已提交、引擎还在跑——轮询期的瞬时网络故障（连接抖动/重置、
						// 单次 20s 超时）不该当场判死整个调用；连续多次才放弃（404=未产出的语义不变）
						if (++netErrors >= 5) throw error;
						continue;
					}
					if (res.status === 404) { lastStatus = "pending"; continue; } // 404 = 还在队列/执行中，不是错误
					if (!res.ok) {
						// 引擎侧结构化错误（含 node id）原样透出，与同步版语义一致
						throw new Error(`Gateway GET /result/${promptId} -> HTTP ${res.status}: ${JSON.stringify(res.json?.detail ?? res.text).slice(0, 2000)}`);
					}
					if (res.json?.images?.length) { result = res.json; break; }
					lastStatus = res.json?.status ?? "running";
					// 网关已报 completed 却没有图 = 终态无产出——立即带原因失败，
					// 不空转到整个轮询预算耗尽才报「no image within Ns」
					if (res.json?.status === "completed") {
						throw new Error(
							`Generation ${promptId} reached terminal state "completed" with no images. ` +
								`The workflow produced no output — inspect it with image_workflow_inspect, or GET /result/${promptId} on the gateway.`
						);
					}
				}
				if (result === null) {
					throw new Error(
						`Generation submitted (prompt_id ${promptId}) but no image within ${Math.round((genTimeoutMs + 60000) / 1000)}s (last status: ${lastStatus}). ` +
							`The job may still finish later — GET /result/${promptId} on the gateway, or check the queue with comfy(action=status).`
					);
				}
				// unload_after：异步端点不收（立即返回无法在完成时机释放），插件拿到结果后代劳
				let unloadInfo = {};
				if (eff.unload_after) {
					try {
					const freed = await callGateway(config.gatewayUrl, "/free", { method: "POST", timeoutMs: 60000, signal: exec?.signal });
					unloadInfo = { vram_freed_at: freed?.freed_at ?? null };
					} catch (e) {
					rethrowIfAborted(e, exec?.signal);
					unloadInfo = { vram_free_error: String(e?.message ?? e).slice(0, 200) }; // 释放失败不影响已成功的结果
					}
				}
				// 保存失败降级为 save_error 字段，不丢已成功的生成结果
				const { savedTo, saved, saveError } = await saveImages(result.images ?? [], eff.save_to, config.outputDir);
				// /result 不带 meta（同步版有）——插件自建同形 meta，对外契约不变（#223：默认值单点取）
				const meta = { template: eff.template ?? DEFAULT_TEMPLATE, width: eff.width ?? GEN_DEFAULTS.width, height: eff.height ?? GEN_DEFAULTS.height, steps: eff.steps ?? GEN_DEFAULTS.steps, cfg: eff.cfg ?? GEN_DEFAULTS.cfg, seed: eff.seed ?? GEN_DEFAULTS.seed };
				// tier/tier_applied：预设生效了什么直接可取证（render 文本同样可见）
				return {
					...result,
					meta,
					...unloadInfo,
					...(savedTo ? { saved_to: savedTo } : {}),
					...(saved && saved.length > 1 ? { saved } : {}),
					...(saveError ? { save_error: saveError } : {}),
					preflight,
					...(tier ? { tier, tier_applied: applied } : {})
				};
			})();
			let job = inflightGenerations.get(dedupKey);
			if (job) {
				let shared = null;
				try {
					const leader = await job;
					shared = { ...leader };
					delete shared.saved_to; // 领头的 save_to 不是搭车方的执行记录
				} catch (error) {
					// 搭车不能被领头者的取消连坐——自己未取消时不能跟着失败
					rethrowIfAborted(error, exec?.signal);
					if (error?.name === "AbortError") {
						job = makeJob(); // 领头被取消而自己没有 → 落下去自己重新建单（用自己的 exec.signal）
					} else {
						// 领头者的真实失败：透出但标记来源（不吞、也不盲目重试引擎错误）
						throw new Error(`piggybacked in-flight generation failed (leader error): ${String(error?.message ?? error).slice(0, 400)}`);
					}
				}
				if (shared) {
					// unload_after 也是每个调用方自己的意图——搭车方拿到结果后自己代劳
					let unloadInfo = {};
					if (eff.unload_after) {
						try {
							const freed = await callGateway(config.gatewayUrl, "/free", { method: "POST", timeoutMs: 60000, signal: exec?.signal });
							unloadInfo = { vram_freed_at: freed?.freed_at ?? null };
						} catch (e) {
							rethrowIfAborted(e, exec?.signal);
							unloadInfo = { vram_free_error: String(e?.message ?? e).slice(0, 200) };
						}
					}
					const { savedTo, saved, saveError } = await saveImages(shared.images ?? [], eff.save_to, config.outputDir);
					return {
						...shared,
						...unloadInfo,
						reused_inflight: true,
						...(savedTo ? { saved_to: savedTo } : {}),
						...(saved && saved.length > 1 ? { saved } : {}),
						...(saveError ? { save_error: saveError } : {})
					};
				}
			} else {
				job = makeJob();
			}
			inflightGenerations.set(dedupKey, job);
			try {
				return await job;
			} finally {
				// 只清理仍是自己那次执行的登记（键可能已被后来者替换，不能误删）
				if (inflightGenerations.get(dedupKey) === job) inflightGenerations.delete(dedupKey);
			}
		}
	}));

	if (includeAdvanced) {
		ctx.tools.register(defineTool({
			name: "image_workflow_inspect",
			description: "Show the ComfyUI workflow a template submits.",
			parameters: {
				template: {
					type: "string",
					required: true,
					description: "Template name (bare, no _api.json)."
				},
				prompt: { type: "string", description: "Prompt substituted into the preview (default \"debug\")." },
				width: { type: "integer", description: "Same as image_generate (1024)." },
				height: { type: "integer", description: "Same as image_generate (1024)." },
				steps: { type: "integer", description: "Same as image_generate (25)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					properties: {
						template: { type: "string", required: true },
						nodeCount: { type: "number", required: true },
						nodes: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: true,
								properties: { id: { type: "string" }, class_type: { type: "string" } }
							}
						},
						graph: { type: "object", additionalProperties: true, required: true },
						placeholdersRemaining: { type: "array", items: { type: "string" }, required: true },
						previewParams: { type: "object", additionalProperties: true, required: true }
					}
				},
				render: (_args, value) => {
					// render 是**模型可见通道**（宿主按 render 呈现结果）：graph 必须在这里逐字出现，
					// 否则“pass it as workflow”就是空话——实测探针指出：只写进 output 的字段模型看不到。
					const graphJson = JSON.stringify(value.graph ?? {}, null, 1);
					const graphBlock = graphJson.length > 8000
						? `(graph too large to inline: ${graphJson.length} chars —用 from_template + node_overrides，不要整图传递)`
						: graphJson;
					return [{
						type: "text",
						text:
							`Template ${value.template}: ${value.nodeCount} nodes -> ` +
							value.nodes.map((n) => `${n.id}:${n.class_type}`).join(", ") +
							`\npreviewParams: ${JSON.stringify(value.previewParams)}` +
							`\nunresolved placeholders: ${value.placeholdersRemaining.length ? value.placeholdersRemaining.join(", ") : "none"}` +
							`\ngraph（原样给 image_generate_raw 的 workflow，或用 from_template + node_overrides 按节点改）:\n${graphBlock}`
					}];
				}
			},
			timeoutMs: 30000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				assertTemplateName(args.template);
				const graph = await callGateway(
					config.gatewayUrl,
					`/debug/workflow/${encodeURIComponent(args.template)}?${templatePreviewQuery(args)}`,
					{ timeoutMs: 20000, signal: exec?.signal }
				);
				const nodes = graphNodes(graph);
				return {
					template: args.template,
					nodeCount: nodes.length,
					nodes,
					graph,
					placeholdersRemaining: findPlaceholders(graph),
					previewParams: {
						prompt: args.prompt ?? "debug",
						width: args.width ?? GEN_DEFAULTS.width,
						height: args.height ?? GEN_DEFAULTS.height,
						steps: args.steps ?? GEN_DEFAULTS.steps,
						cfg: args.cfg ?? GEN_DEFAULTS.cfg,
						seed: args.seed ?? GEN_DEFAULTS.seed,
						batch_size: args.batch_size ?? GEN_DEFAULTS.batch_size
					}
				};
			}
		}));

		ctx.tools.register(defineTool({
			name: "image_generate_raw",
			description: "Run any ComfyUI workflow; returns PNG paths.",
			parameters: {
				from_template: {
					type: "string",
					description: "Template name; exactly one of from_template / workflow."
				},
				workflow: {
					type: "object",
					additionalProperties: true,
					description:
						"Full API graph (node id -> node object)."
				},
				node_overrides: {
					type: "object",
					additionalProperties: true,
					description:
						"Per-node patch: {\"6\":{\"inputs\":{...}}}; inputs merge."
				},
				prompt: { type: "string", description: "Same as image_generate." },
				width: { type: "integer", description: "Default 1024." },
				height: { type: "integer", description: "Default 1024." },
				steps: { type: "integer", description: "Default 25." },
				cfg: { type: "number", description: "Default 1.0." },
				seed: { type: "integer", description: "Default -1 (random)." },
				poll_seconds: {
					type: "integer",
					description: "Wait bound for /result (default 900)."
				},
				save_to: {
					type: "string",
					description: "Optional destination; omit to save all images into the configured output dir."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					properties: {
						prompt_id: { type: "string", required: true },
						images: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									filename: { type: "string" },
									url: { type: "string" },
									bytes: { type: "number" }
								}
							}
						},
						meta: { type: "object", additionalProperties: true, required: true },
						preflight: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text:
						`Generated ${value.images?.length ?? 0} image(s) via raw workflow (${value.meta?.source ?? "?"}, ${value.meta?.node_count ?? "?"} nodes` +
						(value.meta?.overrides_applied?.length ? `, overrides: ${value.meta.overrides_applied.join(",")}` : "") +
						`): ` + (value.images ?? []).map((i) => `${i.filename} (${fmtMB(i.bytes)})`).join(", ") +
						`; prompt_id=${value.prompt_id}` +
						// preflight 也要看得见：一切正常时原来什么都不印，验证者无法确认它真的返回了
						(value.preflight
							? `; queue before: ${value.preflight.queue_running ?? "?"} running / ${value.preflight.queue_pending ?? "?"} pending, free VRAM ${value.preflight.vram_free_gb ?? "?"}GB` +
								(value.preflight.engine_thermal ? `; engine ${value.preflight.engine_thermal}` : "")
							: "; preflight: none") +
						(value.preflight?.actions?.length ? `; auto-recovery: ${value.preflight.actions.join("; ")}` : "") +
						`; meta: ${JSON.stringify(value.meta)}`
				}]
			},
			timeoutMs: toolDeadlineMs,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const hasTemplate = typeof args.from_template === "string" && args.from_template !== "";
				const hasWorkflow = args.workflow !== undefined && args.workflow !== null;
				if (hasTemplate === hasWorkflow) {
					throw new Error(
						"Provide exactly one of `from_template` (resolve a gateway template) or `workflow` (a full API graph); " +
							`got ${hasTemplate ? "both" : "neither"}. Tip: image_workflow_inspect returns a ready-to-use graph.`
					);
				}

				// 1) 解析图
				let graph;
				let source;
				if (hasTemplate) {
					assertTemplateName(args.from_template);
					graph = await callGateway(
						config.gatewayUrl,
						`/debug/workflow/${encodeURIComponent(args.from_template)}?${templatePreviewQuery(args)}`,
						{ timeoutMs: 20000, signal: exec?.signal }
					);
					source = `template:${args.from_template}`;
				} else {
					if (typeof args.workflow !== "object" || Array.isArray(args.workflow)) {
						throw new Error("`workflow` must be an object keyed by node id (API format), e.g. the graph from image_workflow_inspect.");
					}
					graph = JSON.parse(JSON.stringify(args.workflow));
					source = "inline graph";
				}

				// 2) 按节点打补丁（巡检 → 改 → 提交 的便利路径）
				const overridesApplied = [];
				for (const [id, patch] of Object.entries(args.node_overrides ?? {})) {
					const node = graph[id];
					if (!node || typeof node !== "object") {
						throw new Error(
							`node_overrides refers to node "${id}", which is not in the graph. Available ids: ${Object.keys(graph).slice(0, 20).join(", ")}`
						);
					}
					if (patch && typeof patch === "object") {
						if (patch.inputs && typeof patch.inputs === "object") node.inputs = { ...(node.inputs ?? {}), ...patch.inputs };
						for (const [k, v] of Object.entries(patch)) if (k !== "inputs") node[k] = v;
						overridesApplied.push(id);
					}
				}

				// 3) 提交前自检：空图 / 残留占位符都会在引擎侧报晦涩错误，这里直接说清楚
				const nodes = graphNodes(graph);
				if (nodes.length === 0) {
					throw new Error("The workflow has no nodes with class_type — an API-format graph is required (image_workflow_inspect returns one).");
				}
				const placeholders = findPlaceholders(graph);
				if (placeholders.length > 0) {
					throw new Error(
						`The workflow still contains unresolved placeholders (${placeholders.join(", ")}) — those are template markers, not values. ` +
							`Use from_template (the gateway substitutes them), or take the resolved graph from image_workflow_inspect.`
					);
				}

				// 4) 预检/自愈（引擎或网关掉线时隐藏拉起）
				const preflight = await ensureBackendReady(config, ctx, exec?.signal);

				// 5) 提交（/raw 只回 prompt_id，图要自己轮询）
				const startedAt = Date.now();
				const submitted = await callGateway(config.gatewayUrl, "/raw", {
					method: "POST",
					body: graph,
					timeoutMs: 60000,
					signal: exec?.signal
				});
				const promptId = submitted?.prompt_id;
				if (!promptId) throw new Error(`Gateway /raw did not return a prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);

				// 6) 轮询结果（404 = 还没产出；404 不是错误，所以走 callGatewaySoft）
				const budgetMs = (args.poll_seconds ?? config.timeoutSeconds) * 1000;
				const deadline = Date.now() + budgetMs;
				let images = null;
				let lastStatus = "pending";
				let netErrors = 0;
				while (Date.now() < deadline) {
					await sleepAbortable(2000, exec?.signal);
					let res;
					try {
						res = await callGatewaySoft(config.gatewayUrl, `/result/${promptId}`, { timeoutMs: 20000, signal: exec?.signal });
						netErrors = 0;
					} catch (error) {
						rethrowIfAborted(error, exec?.signal);
						// 与 image_generate 同款——轮询网络抖动容忍连续少量失败，
						// 别把还在引擎里跑的任务判死（图片经此路径不可再取）
						if (++netErrors >= 5) throw error;
						continue;
					}
					if (res.status === 404) {
						lastStatus = "pending";
						continue;
					}
					if (!res.ok) {
						// ComfyUI 的 node_errors 就在 detail 里：原样透出，AI 能自己改图
						throw new Error(`Gateway GET /result/${promptId} -> HTTP ${res.status}: ${JSON.stringify(res.json?.detail ?? res.text).slice(0, 2000)}`);
					}
					if (res.json?.images?.length) {
						images = res.json.images;
						break;
					}
					lastStatus = res.json?.status ?? "running";
					// completed 且无图 = 终态——带原因立即失败，不空转整个 poll_seconds
					if (res.json?.status === "completed") {
						throw new Error(
							`Workflow ${promptId} reached terminal state "completed" with no images. ` +
								`The graph produced no output — check SaveImage/output nodes, or GET /result/${promptId} on the gateway.`
						);
					}
				}
				if (images === null) {
					throw new Error(
						`Workflow submitted (prompt_id ${promptId}) but no image within ${Math.round(budgetMs / 1000)}s (last status: ${lastStatus}). ` +
							`Raise poll_seconds for slow graphs; check the queue with comfy(action=status); the job may still finish later — GET /result/${promptId} on the gateway.`
					);
				}

				// 与 image_generate 同款：未指定 save_to 时把结果落进 Config.outputDir。
				const { savedTo, saved, saveError } = await saveImages(images, args.save_to, config.outputDir);
				return {
					prompt_id: promptId,
					images,
					...(savedTo ? { saved_to: savedTo } : {}),
					...(saved && saved.length > 1 ? { saved } : {}),
					...(saveError ? { save_error: saveError } : {}),
					meta: {
						source,
						template: hasTemplate ? args.from_template : null,
						node_count: nodes.length,
						overrides_applied: overridesApplied,
						placeholders_checked: true,
						elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
					},
					preflight
				};
			}
		}));
	}

	ctx.tools.register(defineTool({
		name: "image_service_status",
		description: "Backend status: gateway, queue, VRAM, templates, tiers.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					gatewayUrl: { type: "string", required: true },
					up: { type: "boolean", required: true },
					error: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
					queue: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true },
				workflows: { type: "array", items: { type: "string" }, required: true },
				tiers: { type: "object", additionalProperties: true, required: true },
				diagnostics: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.up
					? `Gateway ${value.gatewayUrl}: up; running=${value.queue?.queue_running}, pending=${value.queue?.queue_pending}, ` +
						`free VRAM=${value.queue?.vram?.free_vram_gb ?? "?"}GB, ComfyUI ${value.queue?.comfyui_version ?? "?"}, ` +
						`templates: ${(value.workflows ?? []).join(", ")}; tiers: ${Object.keys(value.tiers ?? {}).join(", ") || "(none)"}` +
						(value.diagnostics?.tierError ? ` [tier table ERROR: ${value.diagnostics.tierError}]` : "")
					: `Gateway ${value.gatewayUrl}: DOWN (${value.error})\n` +
						`  gateway log tail: ${value.diagnostics?.gatewayLogTail || "(empty)"}\n` +
						`  engine log tail: ${value.diagnostics?.engineLogTail || "(empty)"}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(_args, exec) {
			// 没有窗口可看，所以状态工具自己把日志尾部带上；容器差异在下面 catch 里降级返回。
			const diagnostics = {
				gatewayLogTail: tailFile(path.join(GATEWAY_LOG_DIR, "gateway.err.log"), 6) || tailFile(path.join(GATEWAY_LOG_DIR, "gateway.log"), 6) || null,
				engineLogTail: tailFile(path.join(ENGINE_LOG_DIR, "engine.err.log"), 6) || tailFile(path.join(ENGINE_LOG_DIR, "engine.log"), 6) || null,
				// 档位表损坏时随 status 透出（可诊断），不带 tier 的生成不受影响
				tierError: TIERS_LOAD_ERROR
			};
			try {
				const [queue, workflows] = await Promise.all([
					callGateway(config.gatewayUrl, "/status", { timeoutMs: 15000, signal: exec?.signal }),
					callGateway(config.gatewayUrl, "/workflows", { timeoutMs: 15000, signal: exec?.signal })
				]);
				return { gatewayUrl: config.gatewayUrl, up: true, error: null, queue, workflows: workflows.workflows ?? [], tiers: TIERS, diagnostics };
			} catch (error) {
				// 取消必须原样上抛（官方硬性规则）；真实故障则降级成「可诊断的结果」而不是抛错。
				rethrowIfAborted(error, exec?.signal);
				return {
					gatewayUrl: config.gatewayUrl,
					up: false,
					error: String(error?.message ?? error).slice(0, 400),
					queue: null,
					workflows: [],
					tiers: {},
					diagnostics
				};
			}
		}
	}));
}
