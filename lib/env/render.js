/**
 * dsh-imagekit / lib/env/render.js
 * ================================
 * env_probe / preflight 的模型可见文本（从 dsh-plugin-guard 的 lib/render.js 迁移，只保留这两个工具）。
 * 纯函数，只把 JSON 结果压成几行文本，不产生额外数据。
 */

/** reason 级别 → 标记。 */
function levelMark(level) {
	if (level === "go") return "✓";
	if (level === "warn") return "!";
	return "✗";
}

/** env_probe：每条非 ok 带一行 fix。 */
export function renderEnvProbe(v) {
	const icon = { ok: "[ok]", warn: "[warn]", missing: "[MISSING]" };
	const lines = [
		`env_probe: ${v.summary?.ok ?? 0} ok / ${v.summary?.warn ?? 0} warn / ${v.summary?.missing ?? 0} missing → ${v.summary?.verdict ?? "?"}（${v.summary?.fixes ?? 0} 条修复命令）`,
		`检查类别: ${(v.summary?.checks ?? []).join(", ")}`,
	];
	for (const it of v.items ?? []) {
		lines.push(`${icon[it.status] ?? "[?]"} ${it.name}: ${it.detail}`);
		if (typeof it.fix === "string" && it.fix !== "") lines.push(`    fix: ${it.fix}`);
	}
	return lines.join("\n");
}

/** preflight：GO/NO-GO + 共享显存 + 每条 reason 的 fix。 */
export function renderPreflight(v) {
	const lines = [`preflight ${v.go ? "GO" : "NO-GO"} — ${v.task}`];
	if (v.vram !== null && v.vram !== undefined) {
		// 共享显存必须显式出现（未知也要说未知）：sysmem fallback 是 10-50x 静默降速的头号原因。
		const shared = v.vram.sharedMiB !== null && v.vram.sharedMiB !== undefined
			? `共享显存 ${v.vram.sharedMiB} MiB`
			: "共享显存：未知（nvidia-smi 通道读不到，不代表没有溢出）";
		lines.push(`VRAM(${v.vramSource}): ${v.vram.usedMiB}/${v.vram.totalMiB} MiB 已用，余 ${v.vram.freeMiB} MiB，${shared}${v.vram.name ? ` [${v.vram.name}]` : ""}`);
	} else lines.push("VRAM: 读不到");
	if (v.cpu !== null && v.cpu !== undefined) lines.push(`CPU: 已用 ${v.cpu.usedPct ?? "?"}%（空闲 ${v.cpu.freePct ?? "?"}%，${v.cpu.cores ?? "?"} 核）RAM 空闲 ${v.ram?.freeMB ?? "?"} MB`);
	for (const r of v.reasons ?? []) lines.push(`  ${levelMark(r.level)} [${r.kind}] ${r.text}${r.fix ? ` → fix: ${r.fix}` : ""}`);
	if (v.marks?.id) lines.push(`mark: ${v.marks.id}`);
	return lines.join("\n");
}
