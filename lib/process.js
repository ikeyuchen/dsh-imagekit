/**
 * dsh-imagekit / lib/process.js — 图像生成工坊像素处理模块
 * ======================================================
 * （原 dsh-plugin-image-pipeline 于 2026-11-06 并入本包）
 * 把提示词实测经验（2026-10-03 起沉淀）里反复出现的
 * **确定性像素步骤**固化成模型可见工具，坑焊死在代码里：
 *
 *   image_resize_lanczos  v5a 第 4 步：降采样回目标尺寸。坑=「不加 USM」
 *                         （SR 已含锐化，叠加=过锐，2026-10-03 实测定论）
 *   image_mark_region     局部修复入口：程序红圈标记法。坑=粗 14px 纯红圈
 *                         （细/软标记泄漏圈外），并配发硬边界三要素指令模板
 *   image_flatten_alpha   抠图前处理：RGBA→不透明底。坑=本管线 RGBA 带 VAE
 *                         alpha 噪声（alpha noise，222-255），不扁平化抠不净（下限 178）
 *   anim_encode           表情包动图合成：逐帧 duration（六阶段节奏 / six-phase rhythm 的载体）
 *                          ——js 侧只解析并校验 durations_ms，真实编码在 scripts/pixels.py（duration=durs）；
 *                         WebP q88 优先（百万色、小 7 倍），GIF 256 色配 max_size 512
 *   pose_check            姿势跟随量化检验：角色剪影 vs 骨架剪影（cy 差
 *                         <0.08 = 跟随良好，实测校准阈值）
 *
 * 实现方式：每次调用 spawn 一次性 `python -X utf8 scripts\pixels.py <子命令>
 * <job.json>`（design-studio 同款模式）——无 shell、无运行时依赖、全程
 * windowsHide；job 走临时文件避免命令行长度/引号问题。
 *
 * 刻意不做的事：整管线一键工具（局部修复点选择是判断题，agent+技能卡+工具
 * 的分工优于黑盒；详见 README「设计边界」节）。
 *
 * Config 由 lib/index.js 统一提供：pythonCommand / processTimeoutSeconds（映射为内部 timeoutSeconds）
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { bundledPythonCandidates } from "./paths.js";

const PIXELS_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pixels.py");

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

/** 读文件头判真实图片格式（返回规范扩展名；识别不出返回 null，不装懂）。
 *  DSH 内容寻址附件（~\.dsh\attachments\v1\objects\...）**没有扩展名**——扩展名白名单不能当唯一门槛。 */
function sniffImageExt(file) {
	let fd;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(12);
		const read = readSync(fd, buf, 0, 12, 0);
		if (read >= 4 && buf.readUInt32BE(0) === 0x89504e47) return ".png";
		if (read >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
		if (read >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return ".webp";
		if (read >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* 已关 */ }
		}
	}
}

/** 扩展名认识即通过（零额外读盘）；缺失/不认识则读头兜底；都判不出才报错，并说明真实原因。 */
function assertImageFile(file) {
	const ext = path.extname(file).toLowerCase();
	if (IMAGE_EXTS.has(ext)) return;
	if (sniffImageExt(file)) return;
	throw new Error(
		`Unrecognized image content (this is not an extension problem): the file header is not PNG/JPEG/WebP/BMP, ` +
			`and the extension ${ext ? `"${ext}"` : "(none)"} is not in (${[...IMAGE_EXTS].join(" ")}): ${file}`
	);
}

/** 经验出处锚点：下面这些「焊死坑」来自 2026-10-03 起的提示词实测沉淀。 */
const HANDBOOK_ANCHOR = "prompt-mechanics 2026-10-03";

/**
 * 局部修复指令三要素模板（「程序标记法」定版措辞）。
 * 硬边界句是实测关键：软措辞（"inside the circle"）会全画面泄漏。
 */
const MARK_INSTRUCTION_TEMPLATE =
	"Edit the region inside the red circle ONLY: <describe the change>. " +
	"The edit must stop strictly at the circle boundary and must NOT spread outside. " +
	"The red circle marking must NOT appear in the final image.";

/** 一次性 python 子进程：windowsHide、超时击杀、取消协作、stdout=JSON。 */
function runPixels(python, subcommand, job, timeoutMs, signal) {
	return new Promise((resolve, reject) => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "img-pipeline-"));
		const jobPath = path.join(tmpDir, "job.json");
		writeFileSync(jobPath, JSON.stringify(job), "utf8");
		const child = spawn(python, ["-X", "utf8", PIXELS_PY, subcommand, jobPath], {
			cwd: tmpDir,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const keep = (s, d) => (s + d).slice(-8000);
		child.stdout.on("data", (d) => { out = keep(out, d); });
		child.stderr.on("data", (d) => { err = keep(err, d); });
		const cleanup = () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录残留无害 */ } };
		const onAbort = () => { try { child.kill(); } catch { /* 已退出 */ } };
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			cleanup();
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			cleanup();
			resolve({ code, out, err });
		});
	});
}

/**
 * python 候选顺序：显式配置 > DSH 自带运行时（预装 Pillow/numpy）> PATH 上的 python > py。
 * 之前只探 python/py：DSH 自己就带一份装好 Pillow 的 3.12，用户机器上却没有 python 命令，
 * 于是四个像素工具全报「No usable python found」——而答案就在 $DSH_HOME 里。
 */
function pythonCandidates(config) {
	const out = [];
	if (config.pythonCommand !== "") out.push(config.pythonCommand);
	out.push(...bundledPythonCandidates(), "python", "py");
	return [...new Set(out)];
}

/** 解析 python：首个「python + PIL 都活着」的候选（缓存结果，失败不缓存以便重装后自愈）。 */
function makePythonResolver(config, probe) {
	let resolved;
	let resolving;
	return () => {
		if (resolved !== undefined) return resolved;
		if (resolving !== undefined) return resolving;
		resolving = (async () => {
			const candidates = pythonCandidates(config);
			const errors = [];
			for (const candidate of candidates) {
				try {
					const r = await probe(candidate);
					if (r.code === 0) {
						resolved = candidate;
						return candidate;
					}
					errors.push(`${candidate}: exit ${r.code}`);
				} catch (e) {
					errors.push(`${candidate}: ${e.message}`);
				}
			}
			throw new Error(
				`No usable python found: these pixel tools need Python 3 with Pillow + numpy. Tried ${candidates.length} interpreter(s): ${errors.join("; ")}. ` +
					`Fix one of: install Pillow+numpy into one of them (pip install pillow numpy), ` +
					`install the DSH runtime that bundles them, or set the \`pythonCommand\` config to an interpreter that has both.`
			);
		})().catch((error) => {
			// 失败不缓存：用户装完 Pillow 后下一次调用要能自愈，而不是一直记着旧结论
			resolving = undefined;
			throw error;
		});
		return resolving;
	};
}

function fmtMB(bytes) {
	return `${(bytes / 1048576).toFixed(2)} MB`;
}

/** 公共入参校验：存在 + 图片格式（扩展名白名单，缺失/不识则读文件头）；返回解析后的绝对路径。 */
function checkInput(args) {
	const input = path.resolve(args.input_path);
	if (!existsSync(input)) throw new Error(`Input image not found: ${input}`);
	assertImageFile(input);
	return input;
}

/** 输出路径：save_to 尾随分隔符 = 目录内自动命名；否则原样；默认输入旁。 */
function resolveOutput(input, saveTo, autoName) {
	if (!saveTo) return path.join(path.dirname(input), autoName);
	const dest = path.resolve(saveTo);
	return /[\\/]$/.test(saveTo) ? path.join(dest, autoName) : dest;
}

function ensureDir(output) {
	mkdirSync(path.dirname(output), { recursive: true });
}

function tail(text, lines) {
	return text ? text.split("\n").slice(-lines).join("\n") : "";
}

/** 注册工具。config 已由 Cordis 按 Config schema 校验并填好默认值。 */
function register(ctx, config) {
	const timeoutMs = config.timeoutSeconds * 1000;
	const resolvePython = makePythonResolver(config, async (candidate) => {
		// probe 子命令只验证「python + PIL 活着」；ImportError = 缺依赖，换下一个候选
		const r = await runPixels(candidate, "probe", {}, 15000, undefined).catch((e) => ({ code: -1, err: String(e) }));
		if (r.code === -1 || /ModuleNotFoundError|ImportError/.test(r.err || "")) return { code: 1 };
		return { code: r.code === 0 ? 0 : 1 };
	});

	/** 调 pixels.py；非零退出带 stderr 尾部响亮报错。 */
	async function callPixels(subcommand, job, exec) {
		const python = await resolvePython();
		const startedAt = Date.now();
		const proc = await runPixels(python, subcommand, job, timeoutMs, exec?.signal);
		if (exec?.signal?.aborted) throw new Error("Pixel operation cancelled (exec.signal aborted).");
		if (proc.code !== 0) {
			throw new Error(
				`pixels.py ${subcommand} exited with code ${proc.code}.` +
					(proc.err ? ` stderr tail:\n${tail(proc.err, 6)}` : "") +
					(proc.out ? ` stdout tail:\n${tail(proc.out, 4)}` : "")
			);
		}
		let parsed;
		try {
			parsed = JSON.parse(proc.out);
		} catch {
			throw new Error(`pixels.py ${subcommand} printed non-JSON output:\n${tail(proc.out, 8)}`);
		}
		parsed.elapsed_seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
		return parsed;
	}

	function requireOutputFile(output, label) {
		if (!existsSync(output)) {
			throw new Error(`${label} reported success but output is missing: ${output}`);
		}
		return statSync(output).size;
	}

	const shared = { callPixels, checkInput, resolveOutput, ensureDir, requireOutputFile };

	// 每个子命令一个实现：单独工具（standard/all）与合并工具 image_process（lean）共用同一份执行体，
	// 避免「合并档」变成第二套实现。校验从 schema 移到实现里，合并后参数都是可选的也不会漏。
	async function runResize(args, exec) {
		const picked = ["width", "height", "percent"].filter((k) => args[k] !== undefined);
		if (picked.length !== 1) {
			throw new Error(`Provide exactly ONE of width / height / percent (got: ${picked.join(", ") || "none"}). No silent fallback.`);
		}
		const input = shared.checkInput(args);
		const ext = args.format === "jpeg" ? ".jpg" : `.${args.format ?? "png"}`;
		const autoName = `${path.basename(input, path.extname(input))}_${picked[0]}-${args[picked[0]]}${ext}`;
		const output = shared.resolveOutput(input, args.save_to, autoName);
		shared.ensureDir(output);
		const job = {
			input, output,
			width: args.width, height: args.height, percent: args.percent,
			format: args.format ?? "png", quality: args.quality,
		};
		const r = await shared.callPixels("resize", job, exec);
		const bytes = shared.requireOutputFile(output, "resize");
		return { ok: true, output, in_width: r.in_width, in_height: r.in_height, out_width: r.width, out_height: r.height, out_bytes: bytes, elapsed_seconds: r.elapsed_seconds };
	}

	async function runMarkRegion(args, exec) {
		for (const k of ["cx", "cy", "radius"]) {
			if (args[k] === undefined || args[k] === null) throw new Error(`image_mark_region needs ${k} (px).`);
		}
		const input = shared.checkInput(args);
		const output = shared.resolveOutput(input, args.save_to, `${path.basename(input, path.extname(input))}_marked.png`);
		shared.ensureDir(output);
		const job = {
			input, output,
			cx: args.cx, cy: args.cy, radius: args.radius,
			stroke_width: args.stroke_width, color: args.color,
		};
		const r = await shared.callPixels("mark_region", job, exec);
		const bytes = shared.requireOutputFile(output, "mark_region");
		return { ok: true, output, bbox: r.bbox, instruction_template: MARK_INSTRUCTION_TEMPLATE, out_bytes: bytes, elapsed_seconds: r.elapsed_seconds };
	}

	async function runFlattenAlpha(args, exec) {
		const input = shared.checkInput(args);
		const fmt = args.format === "png" ? ".png" : ".jpg";
		const output = shared.resolveOutput(input, args.save_to, `${path.basename(input, path.extname(input))}_flat${fmt}`);
		shared.ensureDir(output);
		const job = { input, output, background: args.background, format: args.format ?? "jpeg", quality: args.quality };
		const r = await shared.callPixels("flatten_alpha", job, exec);
		const bytes = shared.requireOutputFile(output, "flatten_alpha");
		return { ok: true, output, had_alpha: r.had_alpha, width: r.width, height: r.height, out_bytes: bytes, elapsed_seconds: r.elapsed_seconds };
	}

	async function runAnimEncode(args, exec) {
		if (!Array.isArray(args.frames) || args.frames.length < 2) {
			throw new Error(`frames must be an array of >= 2 image paths, got ${JSON.stringify(args.frames)?.slice(0, 120)}`);
		}
		const inputs = args.frames.map((f) => {
			const p = path.resolve(f);
			if (!existsSync(p)) throw new Error(`Frame not found: ${p}`);
			assertImageFile(p);
			return p;
		});
		// durations_ms 接整数（统一）或逗号串（逐帧，六阶段节奏），这里解析并焊死长度/范围校验
		let durs;
		const rawArg = args.durations_ms ?? 110;
		const raw = typeof rawArg === "number" ? String(rawArg) : rawArg.trim();
		if (/^\d+$/.test(raw.trim())) {
			durs = inputs.map(() => Number(raw.trim()));
		} else {
			const parts = raw.split(",").map((s) => Number(s.trim()));
			if (parts.some((n) => !Number.isFinite(n))) throw new Error(`durations_ms must be integers, got: ${raw}`);
			if (parts.length !== inputs.length) {
				throw new Error(`durations_ms has ${parts.length} entries but frames = ${inputs.length}; one per frame or a single uniform value.`);
			}
			durs = parts;
		}
		const fmt = args.format === "gif" ? ".gif" : ".webp";
		const first = inputs[0];
		const output = shared.resolveOutput(first, args.save_to, `${path.basename(first, path.extname(first))}_anim${fmt}`);
		shared.ensureDir(output);
		const job = {
			frames: inputs, output,
			durations_ms: durs.length === 1 ? durs[0] : durs,
			format: args.format ?? "webp", quality: args.quality, loop: args.loop, max_size: args.max_size,
		};
		const r = await shared.callPixels("anim_encode", job, exec);
		const bytes = shared.requireOutputFile(output, "anim_encode");
		return { ok: true, output, frames: r.frames, width: r.width, height: r.height, durations_ms: r.durations_ms, out_bytes: bytes, elapsed_seconds: r.elapsed_seconds };
	}

	async function runPoseCheck(args, exec) {
		if (!args.character_image || !args.skeleton_image) {
			throw new Error("pose_check needs character_image and skeleton_image (absolute paths).");
		}
		const charPath = path.resolve(args.character_image);
		const skelPath = path.resolve(args.skeleton_image);
		for (const p of [charPath, skelPath]) {
			if (!existsSync(p)) throw new Error(`Input image not found: ${p}`);
		}
		const startedAt = Date.now();
		const character = await shared.callPixels("fg_metrics", { image: charPath, dark_bg: false }, exec);
		const skeleton = await shared.callPixels("fg_metrics", { image: skelPath, dark_bg: true }, exec);
		const cy_diff = Math.abs(character.cy - skeleton.cy);
		const top_diff = Math.abs(character.top - skeleton.top);
		const bot_diff = Math.abs(character.bot - skeleton.bot);
		const threshold = args.threshold ?? 0.08;
		return {
			ok: true,
			verdict: cy_diff < threshold ? "follows" : "drifted",
			threshold,
			cy_diff: Number(cy_diff.toFixed(3)),
			top_diff: Number(top_diff.toFixed(3)),
			bot_diff: Number(bot_diff.toFixed(3)),
			character,
			skeleton,
			elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
		};
	}

	const renderers = {
		resize: (_a, v) => [{
			type: "text",
			text: `Resized ${v.in_width}x${v.in_height} → ${v.out_width}x${v.out_height} (Lanczos, no USM): ${v.output} ${fmtMB(v.out_bytes ?? 0)} in ${v.elapsed_seconds}s`,
		}],
		mark_region: (_a, v) => [{
			type: "text",
			text: `Marked region (bbox [${v.bbox.join(",")}]): ${v.output} ${fmtMB(v.out_bytes ?? 0)} in ${v.elapsed_seconds}s\n` +
				`Instruction template for the edit call:\n${v.instruction_template}`,
		}],
		flatten_alpha: (_a, v) => [{
			type: "text",
			text: `Flattened (had_alpha=${v.had_alpha}) → ${v.output} ${v.width}x${v.height} ${fmtMB(v.out_bytes ?? 0)} in ${v.elapsed_seconds}s`,
		}],
		anim_encode: (_a, v) => [{
			type: "text",
			text: `Encoded ${v.frames} frames ${v.width}x${v.height} durations [${v.durations_ms.join(",")}]ms → ${v.output} ${fmtMB(v.out_bytes ?? 0)} in ${v.elapsed_seconds}s`,
		}],
		pose_check: (_a, v) => [{
			type: "text",
			text: `Pose check: verdict=${v.verdict} cy_diff=${v.cy_diff.toFixed(3)} top_diff=${v.top_diff.toFixed(3)} bot_diff=${v.bot_diff.toFixed(3)} ` +
				`(character cy ${Number(v.character?.cy ?? 0).toFixed(2)} vs skeleton cy ${Number(v.skeleton?.cy ?? 0).toFixed(2)})`,
		}],
	};

	const ACTIONS = {
		resize: runResize,
		mark_region: runMarkRegion,
		flatten_alpha: runFlattenAlpha,
		anim_encode: runAnimEncode,
		pose_check: runPoseCheck,
	};
	const ACTION_NAMES = Object.keys(ACTIONS);

	const commonParams = {
		input_path: { type: "string", description: "Input image absolute path (png/jpg/jpeg/webp/bmp)." },
		save_to: { type: "string", description: "Output path; trailing slash keeps the auto name." },
	};

	// 合并档（lean）：一个 image_process 顶五件，参数按 action 取用。
	if (config.merge === true) {
		ctx.tools.register(defineTool({
			name: "image_process",
			description: "Deterministic pixel steps (CPU): resize, mark region, flatten alpha, encode animation, pose check. Pick action.",
			parameters: {
				action: {
					type: "string",
					required: true,
					description: "resize | mark_region | flatten_alpha | anim_encode | pose_check",
				},
				...commonParams,
				width: { type: "integer", description: "resize: width px (height auto)." },
				percent: { type: "integer", description: "resize: scale percent (1-400)." },
				format: { type: "string", description: "resize/flatten: png|jpeg|webp; anim: webp|gif." },
				quality: { type: "integer", description: "jpeg/webp quality (default 92/90)." },
				cx: { type: "integer", description: "mark_region: circle center x (px)." },
				cy: { type: "integer", description: "mark_region: circle center y (px)." },
				radius: { type: "integer", description: "mark_region: radius px (>= 3)." },
				stroke_width: { type: "integer", description: "mark_region: stroke px (default 14)." },
				color: { type: "string", description: "mark_region: color (default #FF0000)." },
				background: { type: "string", description: "flatten_alpha: background color (default #FFFFFF)." },
				frames: { type: "array", items: { type: "string" }, description: "anim_encode: ordered frame paths (>= 2)." },
				durations_ms: { oneOf: [{ type: "integer" }, { type: "string" }], description: "anim_encode: integer or per-frame comma list; 20-60000 (default 110)." },
				loop: { type: "integer", description: "anim_encode: loop count, 0 = infinite (default)." },
				max_size: { type: "integer", description: "anim_encode: cap longest side px." },
				character_image: { type: "string", description: "pose_check: character frame path." },
				skeleton_image: { type: "string", description: "pose_check: skeleton reference path." },
				threshold: { type: "number", description: "pose_check: cy-diff pass threshold (default 0.08)." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					properties: {
						ok: { type: "boolean", required: true },
						action: { type: "string", required: true },
						output: { type: "string" },
						elapsed_seconds: { type: "number", required: true },
					},
				},
				render: (_args, value) => {
					const fn = renderers[value.action];
					if (fn) return fn(_args, value);
					return [{ type: "text", text: `${value.action}: ${JSON.stringify(value)}` }];
				},
			},
			timeoutMs: timeoutMs + 60000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const action = String(args.action ?? "");
				const run = ACTIONS[action];
				if (!run) {
					throw new Error(`image_process: unknown action ${JSON.stringify(action)}; expected one of ${ACTION_NAMES.join(" | ")}.`);
				}
				return { action, ...(await run(args, exec)) };
			},
		}));
		return;
	}

	// ------------------------------------------------------------------ 工具 1
	ctx.tools.register(defineTool({
		name: "image_resize_lanczos",
		description: "Resize by width or percent (Lanczos, no sharpening).",
		parameters: {
			input_path: { type: "string", required: true, description: "Input image absolute path (png/jpg/jpeg/webp/bmp)." },
			width: { type: "integer", description: "Width px (height auto)." },
			percent: { type: "integer", description: "Scale percent (1-400)." },
			format: { type: "string", description: "png (default) | jpeg | webp." },
			quality: { type: "integer", description: "jpeg/webp quality (92/90); png ignores it." },
			save_to: { type: "string", description: "Output path; trailing slash keeps the auto name." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					output: { type: "string", required: true },
					in_width: { type: "number" },
					in_height: { type: "number" },
					out_width: { type: "number", required: true },
					out_height: { type: "number", required: true },
					out_bytes: { type: "number" },
					elapsed_seconds: { type: "number", required: true },
				},
			},
			render: renderers.resize,
		},
		timeoutMs: timeoutMs + 60000,
		isConcurrencySafe: () => true, // 纯 CPU 像素操作，无 GPU/共享态
		execute: runResize,
	}));

	// ------------------------------------------------------------------ 工具 2
	ctx.tools.register(defineTool({
		name: "image_mark_region",
		description: "Draw a red circle mark on a region of an image.",
		parameters: {
			input_path: { type: "string", required: true, description: "Image to mark (absolute path)." },
			cx: { type: "integer", required: true, description: "Circle center x (px)." },
			cy: { type: "integer", required: true, description: "Circle center y (px)." },
			radius: { type: "integer", required: true, description: "Radius px (>= 3)." },
			stroke_width: { type: "integer", description: "Stroke px (default 14 = calibrated; >= 2)." },
			color: { type: "string", description: "Marker color (default #FF0000)." },
			save_to: { type: "string", description: "Output path; trailing slash keeps the auto name." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					output: { type: "string", required: true },
					bbox: { type: "array", items: { type: "number" }, required: true },
					instruction_template: { type: "string", required: true },
					out_bytes: { type: "number" },
					elapsed_seconds: { type: "number", required: true },
				},
			},
			render: renderers.mark_region,
		},
		timeoutMs: timeoutMs + 60000,
		isConcurrencySafe: () => true,
		execute: runMarkRegion,
	}));

	// ------------------------------------------------------------------ 工具 3
	ctx.tools.register(defineTool({
		name: "image_flatten_alpha",
		description: "Flatten transparency onto a solid background.",
		parameters: {
			input_path: { type: "string", required: true, description: "Image absolute path (alpha or not — idempotent)." },
			background: { type: "string", description: "Background color (default #FFFFFF)." },
			format: { type: "string", description: "jpeg (default) | png." },
			save_to: { type: "string", description: "Output path; trailing slash keeps the auto name." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					output: { type: "string", required: true },
					had_alpha: { type: "boolean", required: true },
					width: { type: "number", required: true },
					height: { type: "number", required: true },
					out_bytes: { type: "number" },
					elapsed_seconds: { type: "number", required: true },
				},
			},
			render: renderers.flatten_alpha,
		},
		timeoutMs: timeoutMs + 60000,
		isConcurrencySafe: () => true,
		execute: runFlattenAlpha,
	}));

	// ------------------------------------------------------------------ 工具 4
	ctx.tools.register(defineTool({
		name: "anim_encode",
		description: "Frames → animated WebP (or GIF).",
		parameters: {
			frames: { type: "array", items: { type: "string" }, required: true, description: "Ordered frame image absolute paths (>= 2)." },
			durations_ms: {
				oneOf: [{ type: "integer" }, { type: "string" }],
				description:
					"Integer or per-frame comma list; 20-60000 (default 110).",
			},
			format: { type: "string", description: "webp (default, quality 88) | gif (256 colors)." },
			quality: { type: "integer", description: "WebP quality (default 88)." },
			loop: { type: "integer", description: "Loop count, 0 = infinite (default)." },
			max_size: { type: "integer", description: "Cap the longest side px (e.g. 512 for WeChat GIF)." },
			save_to: { type: "string", description: "Output path; trailing slash keeps the auto name." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					output: { type: "string", required: true },
					frames: { type: "number", required: true },
					width: { type: "number", required: true },
					height: { type: "number", required: true },
					durations_ms: { type: "array", items: { type: "number" }, required: true },
					out_bytes: { type: "number" },
					elapsed_seconds: { type: "number", required: true },
				},
			},
			render: renderers.anim_encode,
		},
		timeoutMs: timeoutMs + 60000,
		isConcurrencySafe: () => true,
		execute: runAnimEncode,
	}));

	// ------------------------------------------------------------------ 工具 5
	ctx.tools.register(defineTool({
		name: "pose_check",
		description: "Check a frame matches its skeleton pose; pass if center offset < 0.08.",
		parameters: {
			character_image: { type: "string", required: true, description: "Generated character frame (light bg), absolute path." },
			skeleton_image: { type: "string", required: true, description: "Its skeleton reference (OpenPose black bg), absolute path." },
			threshold: { type: "number", description: "cy-diff pass threshold, default 0.08 (field-calibrated)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					verdict: { type: "string", required: true },
					cy_diff: { type: "number", required: true },
					top_diff: { type: "number", required: true },
					bot_diff: { type: "number", required: true },
					character: { type: "object", additionalProperties: true },
					skeleton: { type: "object", additionalProperties: true },
					elapsed_seconds: { type: "number", required: true },
				},
			},
			render: renderers.pose_check,
		},
		timeoutMs: timeoutMs + 60000,
		isConcurrencySafe: () => true,
		execute: runPoseCheck,
	}));
}

export { register };
