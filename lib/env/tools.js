/**
 * dsh-imagekit / lib/env/tools.js
 * ================================
 * env_probe / preflight 两个工具的注册体（从 dsh-plugin-guard 的 lib/tools.js 迁移，
 * 只保留环境检测相关工具；repo_check / plugin_health / agent_capacity 不随包）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { probeEnvironment } from "./env.js";
import { runPreflight, recordMark } from "./preflight.js";
import { renderEnvProbe, renderPreflight } from "./render.js";
import { redactHome } from "./util.js";

/** 只保留有值的键，避免 undefined 混进 JSON（宿主回传走 lossless-json）。 */
function compact(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/* 输出 schema 片段（可空字段一律 oneOf:[...,{type:'null'}]）。 */
const NULLABLE = (schema) => ({ oneOf: [schema, { type: "null" }] });
const OBJ = { type: "object", additionalProperties: true };
const NULLABLE_OBJ = NULLABLE(OBJ);
const NULLABLE_STR = NULLABLE({ type: "string" });
const STR_ARRAY = { type: "array", items: { type: "string" } };

/** 注册 env_probe / preflight。 */
export function registerEnvTools(ctx, config) {
	ctx.tools.register(defineTool({
		name: "env_probe",
		description: "Environment check: interpreters, engines, ports, GPU, deps. Each problem comes with a fix.",
		parameters: {
			checks: {
				type: "array",
				items: { type: "string", enum: ["interpreters", "browsers", "engines", "ports", "encoding", "writable", "longpaths", "gpu", "deps"] },
				description: "探测类别；缺省 = 全部",
			},
			paths: {
				type: "array",
				items: { type: "string" },
				description: "附加路径：纯数字视作端口，其余测可写",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								status: { type: "string", required: true, enum: ["ok", "missing", "warn"] },
								detail: { type: "string", required: true },
								fix: { type: "string" },
								evidence: { type: "object", additionalProperties: true, required: true },
							},
						},
					},
					summary: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							checks: STR_ARRAY,
							total: { type: "number", required: true },
							ok: { type: "number", required: true },
							warn: { type: "number", required: true },
							missing: { type: "number", required: true },
							fixes: { type: "number", required: true },
							verdict: { type: "string", required: true, enum: ["healthy", "degraded", "broken"] },
						},
					},
				},
			},
			render: (_args, value) => [{ type: "text", text: renderEnvProbe(value) }],
		},
		isConcurrencySafe: () => true,
		timeoutMs: 180000,
		async execute(args, exec) {
			const signal = exec?.signal;
			const { items, summary } = await probeEnvironment({
				config,
				checks: args.checks,
				paths: Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [],
				signal,
			});
			return { ok: summary.missing === 0, items, summary };
		},
	}));

	ctx.tools.register(defineTool({
		name: "preflight",
		description: "Go/no-go before heavy GPU jobs: VRAM, shared-memory spill, ports, engines.",
		parameters: {
			task: { type: "string", required: true, description: "任务描述（写进打点）" },
			needs: {
				type: "object",
				additionalProperties: false,
				description: "任务需求；缺省字段不参与判定",
				properties: {
					vramMiB: { type: "number", description: "专用显存 MiB" },
					sharedMemMaxMiB: { type: "number", description: "共享显存上限 MiB（超过即溢出降速）" },
					ports: { type: "array", items: { type: "number" }, description: "需要可用/独占的端口" },
					engines: { type: "array", items: { type: "string" }, description: "引擎名（Config.engines）" },
					cpuPct: { type: "number", description: "CPU 空闲度（%）" },
				},
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					go: { type: "boolean", required: true },
					task: { type: "string", required: true },
					reasons: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								level: { type: "string", required: true, enum: ["go", "warn", "no-go"] },
								kind: { type: "string", required: true },
								text: { type: "string", required: true },
								fix: { type: "string" },
							},
						},
					},
					vram: NULLABLE_OBJ,
					vramSource: NULLABLE_STR,
					ports: { type: "array", items: { type: "object", additionalProperties: true } },
					engines: { type: "array", items: { type: "object", additionalProperties: true } },
					cpu: { type: "object", additionalProperties: true },
					ram: { type: "object", additionalProperties: true },
					marks: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							id: NULLABLE_STR,
							file: NULLABLE_STR,
							note: { type: "string" },
						},
					},
					vramEvidence: NULLABLE_OBJ,
					capturedAt: NULLABLE_STR,
				},
			},
			render: (_args, value) => [{ type: "text", text: renderPreflight(value) }],
		},
		isConcurrencySafe: () => true,
		timeoutMs: 60000,
		async execute(args, exec) {
			const signal = exec?.signal;
			const task = String(args.task ?? "");
			const needs = args.needs !== null && typeof args.needs === "object" ? args.needs : {};
			const result = await runPreflight({ config, needs, signal });
			let marks = { id: null, file: null, note: "mark:false，未记录打点" };
			if (args.mark !== false) {
				const recorded = recordMark(config, {
					at: new Date().toISOString(),
					task,
					go: result.go,
					vramMiB: result.needs.vramMiB,
					sharedMiB: result.vram?.sharedMiB ?? null,
					reasons: result.reasons.filter((r) => r.level === "no-go").map((r) => r.text),
				});
				marks = { id: recorded.id, file: redactHome(recorded.file), note: "已记录到 ImageKit 数据目录；perf(action=mark) 可另做一份 perf 侧打点" };
			}
			return compact({
				ok: result.go,
				go: result.go,
				task,
				reasons: result.reasons,
				vram: result.vram,
				vramSource: result.vramSource,
				ports: result.ports,
				engines: result.engines,
				cpu: result.cpu,
				ram: result.ram,
				marks,
				vramEvidence: result.vramEvidence,
				capturedAt: result.capturedAt,
			});
		},
	}));
}
