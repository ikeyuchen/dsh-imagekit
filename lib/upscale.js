/**
 * dsh-imagekit / lib/upscale.js — 图像生成工坊超分模块
 * ==================================================
 * （原 dsh-plugin-image-upscale 于 2026-11-06 并入本包）
 * 为所有会话注册一个模型可见工具，封装 CLI 超分引擎（放在 <installRoot>/upscale-engines/engines）
 * 的三个 Vulkan CLI 引擎。引擎参数差异（waifu2x 的 -m 指模型目录、ESRGAN 的
 * -m 目录 + -n 模型名双参、Real-CUGAN 的 models-pro 与按倍率可用的降噪档）
 * 全部焊死在下方 ENGINES 注册表里——调用方只说 engine + scale + denoise。
 *
 * 刻意独立于生图链路：不依赖网关/ComfyUI（Vulkan 直通 GPU），引擎挂了生图
 * 照常、反之亦然。
 *
 * **全程后台静默**：spawn 一律 windowsHide（无控制台窗口），失败时错误信息
 * 带引擎 stderr 尾部（无窗口可看，就必须可诊断）。
 *
 * Config 由 lib/index.js 统一提供：upscaleEnginesRoot / upscaleTimeoutSeconds /
 * upscaleGpuDevice（映射为内部 enginesRoot/timeoutSeconds/gpuDevice）。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * 版本锚点：本插件的预设注册表焊死在 Waifu2x-Extension-GUI v3.142.01（2026-09-29 发布）
 * 的引擎构建与模型清单上。升级引擎后：重跑 selftest，按新模型清单核对 ENGINES，
 * 同步更新本常量与 README「版本锚点」节。
 */
const ENGINE_ANCHOR = "Waifu2x-Extension-GUI v3.142.01 (2026-09-29)";

/** ESRGAN 系预设工厂——-s 用**经过校验的** s（不再写字面量倍率），
 *  注册表将来扩档（如给 esrgan_anime 加 x3）时校验表与真实命令行不会脱钩，
 *  避免「报告 x3、实际输出 x2」的静默错档；四个条目的重复结构也一并收敛。
 *  定义在 ENGINES 之前（const 箭头函数有 TDZ，后置会在模块加载时 ReferenceError）。 */
const esrganPreset = (label, model, scale) => ({
	dir: "realesrgan-ncnn-vulkan",
	exe: "realesrgan-ncnn-vulkan_waifu2xEX.exe",
	label,
	model,
	scales: { [scale]: [0] },
	defaultScale: scale,
	// ⚠️ ESRGAN 的 -m 是模型目录（models），-n 才是模型名
	buildArgs: (s) => ["-s", String(s), "-m", "models", "-n", model],
});

/**
 * 引擎注册表 —— 验证于 ENGINE_ANCHOR（2026-10-03 六方对比 + 逐参数实证）。
 * scales: 倍率 → 可用降噪档（Real-CUGAN models-pro 实测：×2 全档，×3/×4 仅 0/3）。
 */
const ENGINES = {
	cugan: {
		dir: "realcugan-ncnn-vulkan",
		exe: "realcugan-ncnn-vulkan_W2xEX.exe",
		label: "Real-CUGAN 动画专用（首选）",
		model: "models-pro",
		scales: { 2: [0, 1, 2, 3], 3: [0, 3], 4: [0, 3] },
		defaultScale: 2,
		buildArgs: (s, n) => ["-s", String(s), "-n", String(n), "-m", "models-pro"],
	},
	// ⚠️ 实证（2026-10-03）：conservative 由 -n -1 选择（引擎按 up{scale}x-{后缀} 推导文件名：
	// -1→conservative / 0→no-denoise / 1/2/3→denoise1x/2x/3x）；-c 是 syncgap 多卡参数，与模型无关。
	cugan_cons: {
		dir: "realcugan-ncnn-vulkan",
		exe: "realcugan-ncnn-vulkan_W2xEX.exe",
		label: "Real-CUGAN 保守版（克制修复，防画风漂移）",
		model: "models-pro up{scale}x-conservative（-n -1）",
		scales: { 2: [0], 3: [0], 4: [0] },
		defaultScale: 2,
		buildArgs: (s) => ["-s", String(s), "-n", "-1", "-m", "models-pro"],
	},
	waifu2x: {
		dir: "waifu2x-ncnn-vulkan",
		exe: "waifu2x-ncnn-vulkan_waifu2xEX.exe",
		label: "waifu2x（最保守）",
		model: "models-upconv_7_anime_style_art_rgb",
		scales: { 2: [0] },
		defaultScale: 2,
		// ⚠️ waifu2x 的 -m 直接指模型目录（带 models- 前缀），与 ESRGAN 不同；
		// -n 原样透传：scales 只登记了 denoise 0，非法档在校验层已
		// 响亮拒绝，旧 Math.min(n,3) 钳制永不可达，只会掩盖校验表与实参的偏差。
		buildArgs: (s, n) => ["-n", String(n), "-s", String(s), "-m", "models-upconv_7_anime_style_art_rgb"],
	},
	esrgan_anime: esrganPreset("Real-ESRGAN 动画快速（animevideo 视频系模型，静态图中庸可用）", "AnimeVideo-MiniV1.8-W2xEX", 2),
	esrgan_hq: esrganPreset("Real-ESRGAN Anime-HQ ×4（高质量）", "Anime-HQ-W4xEX", 4),
	// —— 照片/写实线：photo_small/photo_hq 为常规档，photo_conservative 用于防过度锐化 ——
	photo_small: esrganPreset("Real-ESRGAN 照片快速 ×2", "Photo-Small-W2xEX", 2),
	photo_hq: esrganPreset("Real-ESRGAN 照片高画质 ×4", "Photo-HQ-W4xEX", 4),
	// W2xEX v3.142.01 已自带、之前未接入的新模型（参数实测：x2/x4 输出正确）
	omni_small: esrganPreset("Omni Small v2（通用/3D 写实，快速）×2", "Omni-Smallv2-W2xEX", 2),
	omni_turbo: esrganPreset("Omni Turbo v1.5（通用/3D 写实，最快）×2", "Omni-TurboV1.5-W2xEX", 2),
	omni_mini: esrganPreset("Omni Mini v2（通用/3D 写实，最小）×2", "Omni-MiniV2-W2xEX", 2),
	photo_conservative: esrganPreset("Real-ESRGAN 照片保守 ×4（少增细节、防过度锐化）", "Photo-Conservative-x4", 4),
	general: esrganPreset("Real-ESRGAN General x4v3（通用小模型，抗噪）", "realesr-general-x4v3", 4),
	general_wdn: esrganPreset("Real-ESRGAN General WDN x4v3（强降噪）", "realesr-general-wdn-x4v3", 4),
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

/** 隐藏执行 CLI：无控制台窗口；捕获 stdio 尾部；支持取消与超时击杀。
 *  击杀原因（timeout/cancelled）随 resolve 结果带回，调用方据此给出可归因的错误。 */
function runHidden(exePath, args, cwd, timeoutMs, signal) {
	// 信号在 spawn 前就已中止时 abort 事件不会再触发——直接拒绝，
	// 别让引擎白占独占 GPU 一整个 timeout 周期。
	if (signal?.aborted) {
		return Promise.reject(Object.assign(new Error("cancelled before engine start"), { name: "AbortError" }));
	}
	return new Promise((resolve, reject) => {
		const child = spawn(exePath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let killReason = null;
		const keep = (s, d) => (s + d).slice(-8000);
		child.stdout.on("data", (d) => { out = keep(out, d); });
		child.stderr.on("data", (d) => { err = keep(err, d); });
		const onAbort = () => { killReason = "cancelled"; try { child.kill(); } catch { /* 已退出 */ } };
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => { killReason = "timeout"; try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
		child.on("error", (e) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); });
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, out, err, killReason });
		});
	});
}

/** PNG IHDR 尺寸读取（输出恒为 PNG；非 PNG 返回 null 而不是装懂）。 */
function pngSize(file) {
	let fd;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(24);
		// 读取长度必须校验（截断文件读不满 24 字节时 buf 余 0，会把尺寸报成 0
		// 而非 null）；fd 用 try/finally 关（readSync 抛错不再泄漏）；并确认偏移 12 处真是 IHDR。
		const read = readSync(fd, buf, 0, 24, 0);
		if (read < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* 已关 */ }
		}
	}
}

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

function fmtMB(bytes) {
	return `${(bytes / 1048576).toFixed(2)} MB`;
}

/** 注册工具。config 已由 Cordis 按 Config schema 校验并填好默认值。 */
function register(ctx, config) {
	const timeoutMs = config.timeoutSeconds * 1000;

	ctx.tools.register(defineTool({
		name: "image_upscale",
		description: "Upscale a local image. Pick engine by content: anime → cugan (default), photo → photo_hq, 3D → omni_small.",
		parameters: {
			input_path: {
				type: "string",
				required: true,
				description: "Input image absolute path (png/jpg/jpeg/webp/bmp).",
			},
			engine: {
				type: "string",
				description: "Preset (default cugan); routing in the description.",
			},
			scale: {
				type: "integer",
				description: "Factor; default per engine (cugan x2, esrgan_hq x4).",
			},
			denoise: {
				type: "integer",
				description: "Real-CUGAN denoise 0-3 (0 = keep detail).",
			},
			save_to: {
				type: "string",
				description: "Output path (PNG); trailing slash keeps the auto name.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					engine: { type: "string", required: true },
					model: { type: "string", required: true },
					scale: { type: "number", required: true },
					output: { type: "string", required: true },
					out_width: { type: "number" },
					out_height: { type: "number" },
					elapsed_seconds: { type: "number", required: true },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text:
					`Upscaled x${value.scale} via ${value.engine} (${value.model}): ${value.output}` +
					(value.out_width ? ` ${value.out_width}x${value.out_height}` : "") +
					` ${fmtMB(value.out_bytes ?? 0)} in ${value.elapsed_seconds}s`,
			}],
		},
		timeoutMs: timeoutMs + 60000,
		isConcurrencySafe: () => false, // 单 GPU 串行（与生图一致）
		async execute(args, exec) {
			// —— 引擎与参数校验：不合法就响亮报错，绝不静默换档 ——
			const engineKey = args.engine ?? "cugan";
			const engine = ENGINES[engineKey];
			if (!engine) {
				throw new Error(`Unknown engine ${JSON.stringify(engineKey)}. Available: ${Object.keys(ENGINES).join(", ")}. No silent fallback.`);
			}
			const scale = args.scale ?? engine.defaultScale;
			const denoise = args.denoise ?? 0;
			const denoiseList = engine.scales[scale];
			if (!denoiseList) {
				const valid = Object.entries(engine.scales).map(([s, ns]) => `x${s}(denoise ${ns.join("/")})`).join(", ");
				throw new Error(`engine "${engineKey}" does not support scale x${scale}. Valid: ${valid}. No silent fallback.`);
			}
			if (!denoiseList.includes(denoise)) {
				throw new Error(`engine "${engineKey}" at x${scale} supports denoise ${denoiseList.join("/")}, got ${denoise}. No silent fallback.`);
			}
			const input = path.resolve(args.input_path);
			if (!existsSync(input)) {
				throw new Error(`Input image not found: ${input}`);
			}
			// 扩展名认识即通过（零额外读盘）；缺失/不认识则读文件头兜底（DSH 附件无扩展名）
			const inputExt = path.extname(input).toLowerCase();
			if (!IMAGE_EXTS.has(inputExt) && !sniffImageExt(input)) {
				throw new Error(
					`Unrecognized image content (this is not an extension problem): the file header is not PNG/JPEG/WebP/BMP, ` +
						`and the extension ${inputExt ? `"${inputExt}"` : "(none)"} is not in (${[...IMAGE_EXTS].join(" ")}): ${input}`
				);
			}
			const engineDir = path.join(config.enginesRoot, engine.dir);
			const exePath = path.join(engineDir, engine.exe);
			if (!existsSync(exePath)) {
				throw new Error(
					`Engine executable not found: ${exePath}. Check Config enginesRoot (current: ${config.enginesRoot}) ` +
						`or run image_setup(action="install", component="upscale") to fetch the engines.`
				);
			}

			// —— 输出路径：默认输入旁 <stem>_x<scale>_<engine>[_n<denoise>].png ——
			const autoName = `${path.basename(input, path.extname(input))}_x${scale}_${engineKey}${denoise > 0 ? `_n${denoise}` : ""}.png`;
			let output;
			if (args.save_to) {
				const dest = path.resolve(args.save_to);
				if (/[\\/]$/.test(args.save_to)) {
					output = path.join(dest, autoName);
				} else {
					// 无尾斜杠但目标是已存在目录：按目录处理——否则引擎把
					// 目录路径当 -o 文件名：目录已存在时 _wfopen 失败，不存在时写出无扩展名文件。
					let isDir = false;
					try { isDir = statSync(dest).isDirectory(); } catch { /* 不存在：按文件目标 */ }
					output = isDir ? path.join(dest, autoName) : dest;
				}
			} else if (config.outputDir) {
				// 默认收进统一输出目录（<outputDir>/upscale），不再散落在输入图旁边。
				output = path.join(path.resolve(config.outputDir), "upscale", autoName);
			} else {
				output = path.join(path.dirname(input), autoName);
			}
			// 输出恒为 PNG（引擎只写 PNG，与 pngSize/output 契约一致）：非 .png 后缀拒绝；
			// save_to 指向输入本身也拒绝——引擎读入后即覆写，会直接毁掉源图
			if (path.extname(output).toLowerCase() !== ".png") {
				throw new Error(`save_to must be a .png path or a directory (engine always writes PNG): ${output}`);
			}
			mkdirSync(path.dirname(output), { recursive: true });
			const sameTarget = process.platform === "win32"
				? output.toLowerCase() === input.toLowerCase()
				: output === input;
			if (sameTarget) {
				throw new Error(`save_to must not point at the input file itself (it would overwrite the source after load): ${output}`);
			}
			mkdirSync(path.dirname(output), { recursive: true });

			// 运行前该路径已存在时，失败/超时不得删除（可能是用户的旧文件）
			const outputExisted = existsSync(output);
			const startedAt = Date.now();
			const proc = await runHidden(
				exePath,
				["-i", input, "-o", output, ...engine.buildArgs(scale, denoise), "-g", String(config.gpuDevice ?? 0)], // 设备号走 Config，不再焊死 0
				engineDir,
				timeoutMs,
				exec?.signal
			);
			if (proc.code !== 0) {
				// 击杀原因先于通用「exited with code」——超时/取消被杀不再伪装成引擎崩溃；
				// 本次新建的半成品 PNG 清掉（引擎被杀时可能写出不完整文件）；运行前就存在的文件保留。
				if (proc.killReason === "timeout") {
					if (!outputExisted) try { rmSync(output, { force: true }); } catch { /* 尽力而为 */ }
					throw new Error(`Upscale timed out after ${config.timeoutSeconds}s and the engine was killed${outputExisted ? " (existing output kept)" : " (partial output removed)"}: ${output}`);
				}
				if (proc.killReason === "cancelled" || exec?.signal?.aborted) {
					if (!outputExisted) try { rmSync(output, { force: true }); } catch { /* 尽力而为 */ }
					throw new Error(`Upscale cancelled (exec.signal aborted)${outputExisted ? "; existing output kept" : ""}.`);
				}
				// 引擎按 up{scale}x-{后缀} 推导模型文件名，缺文件时以 _wfopen 失败 + 崩溃码退出。
				// 把它验尸成「点名缺失文件 + 版本锚点」的响亮错误，方便引擎升级后快速定位。
				const miss = /_wfopen (.+?) failed/.exec(`${proc.err}\n${proc.out}`);
				if (miss) {
					throw new Error(
						`Engine model file missing: ${miss[1]} — engines may have been updated. ` +
							`This plugin is anchored at ${ENGINE_ANCHOR}; after upgrading engines re-run selftest ` +
							`and reconcile the preset registry (README「版本锚点」).`
					);
				}
				throw new Error(
					`Engine ${engineKey} exited with code ${proc.code}.` +
						(proc.err ? ` stderr tail:\n${proc.err.split("\n").slice(-8).join("\n")}` : "") +
						(proc.out ? ` stdout tail:\n${proc.out.split("\n").slice(-4).join("\n")}` : "")
				);
			}
			if (!existsSync(output)) {
				throw new Error(
					`Engine reported success but output is missing: ${output}.` +
						` stdout tail:\n${proc.out.split("\n").slice(-8).join("\n")}` +
						` stderr tail:\n${proc.err.split("\n").slice(-8).join("\n")}`
				);
			}
			const size = pngSize(output);
			const bytes = statSync(output).size;
			return {
				ok: true,
				engine: engineKey,
				engine_label: engine.label,
				model: engine.model,
				scale,
				denoise,
				input,
				output,
				out_bytes: bytes,
				out_width: size?.width ?? null,
				out_height: size?.height ?? null,
				elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
			};
		},
	}));
}

export { register };
