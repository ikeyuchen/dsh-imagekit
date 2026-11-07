/**
 * dsh-plugin-perfmon — DSH 会话活动探测（零内容读取，纯 stat）
 * ============================================================
 * 实测（2026-10-02，活跃会话期间扫描 ~/.dsh 最近 5 分钟变更）活动指纹：
 *   - ~/.dsh/.dshw-turn.json / .dshw-usage.json  轮次与用量状态文件
 *   - ~/.dsh/sessions/<工作区>/<会话>/session.vN.jsonl.zstd  会话日志（追加写）
 * 任何一路 mtime 新鲜 = 有会话在工作。目录 mtime 不随追加变化，必须 stat 文件。
 * 多路冗余：任一信号消失（如第三方组件卸载）不影响其余信号。
 *
 * 错误语义：ENOENT/ENOTDIR 是「预期的无信号」，静默归零；
 * 其他失败（EACCES/EIO 等探测本身坏了）必须与「确实空闲」区分——上报给调用方
 * （可选 onError），并按「刚有活动」兜底返回，绝不许伪装成空闲把采样器送进待机。
 */
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DSH_ROOT = path.join(os.homedir(), ".dsh");

/** 会话日志文件名模式：不写死 v4——DSH 升版后这路信号才不会静默消失。 */
const SESSION_LOG_RE = /^session\.v\d+\.jsonl\.zstd$/;

/** sessions/ 下所有会话日志文件（固定深度 3：slug/session-xxx/session.vN.jsonl.zstd）。
 *  软链/junction 的目录 Dirent.isDirectory() 为 false，用 statSync（跟随链接）再判一次
 *  ；字面量 v4 先探一次，命中即免 per-dir readdir。
 *  返回 [{file, mtimeMs}]：存在性探测用的同一次 statSync 直接带回
 *  mtime——调用方不再对同一路径二次 stat（syscall 减半，也消除重复的存在性判断）。 */
function sessionLogFiles(root, unexpected) {
	const out = [];
	const slugDir = path.join(root, "sessions");
	let slugs = [];
	try {
		slugs = readdirSync(slugDir, { withFileTypes: true });
	} catch (e) {
		unexpected(e);
		return out;
	}
	for (const s of slugs) {
		const slugPath = path.join(slugDir, s.name);
		if (!isDirEntry(s, slugPath, unexpected)) continue;
		let sessions = [];
		try {
			sessions = readdirSync(slugPath, { withFileTypes: true });
		} catch (e) {
			unexpected(e);
			continue;
		}
		for (const d of sessions) {
			if (!d.name.startsWith("session-")) continue;
			const dirPath = path.join(slugPath, d.name);
			if (!isDirEntry(d, dirPath, unexpected)) continue;
			const literal = path.join(dirPath, "session.v4.jsonl.zstd");
			try {
				out.push({ file: literal, mtimeMs: statSync(literal).mtimeMs });
				continue;
			} catch (e) {
				unexpected(e);
			}
			// 字面量未命中：按模式匹配（升到 v5+ 时信号延续）
			let entries = [];
			try {
				entries = readdirSync(dirPath, { withFileTypes: true });
			} catch (e) {
				unexpected(e);
				continue;
			}
			for (const f of entries) {
				if (!SESSION_LOG_RE.test(f.name)) continue;
				const p = path.join(dirPath, f.name);
				try {
					out.push({ file: p, mtimeMs: statSync(p).mtimeMs });
				} catch (e) {
					unexpected(e);
				}
			}
		}
	}
	return out;
}

/** Dirent 是目录，或是解析后（跟随软链/junction）仍是目录。 */
function isDirEntry(entry, entryPath, unexpected) {
	if (entry.isDirectory()) return true;
	try {
		return statSync(entryPath).isDirectory();
	} catch (e) {
		unexpected(e);
		return false;
	}
}

/** 最近的 DSH 活动时刻（epoch ms；0 = 无任何信号文件）。
 *  onError(err)：探测本身坏掉（非 ENOENT/ENOTDIR）时逐处上报；此时返回 Date.now()
 *  兜底（见文件头错误语义）。 */
export function latestDshActivityMs(root, onError) {
	const base = typeof root === "string" && root !== "" ? root : DSH_ROOT;
	let latest = 0;
	let probeBroken = false;
	const unexpected = (e) => {
		if (!e || e.code === "ENOENT" || e.code === "ENOTDIR") return;
		probeBroken = true;
		if (typeof onError === "function") {
			try {
				onError(new Error(`activity probe failed: ${e?.code ?? ""} ${e?.message ?? e}`));
			} catch {}
		}
	};
	const touch = (p) => {
		try {
			const m = statSync(p).mtimeMs;
			if (m > latest) latest = m;
		} catch (e) {
			unexpected(e);
		}
	};
	touch(path.join(base, ".dshw-turn.json"));
	touch(path.join(base, ".dshw-usage.json"));
	// 会话日志的 mtime 已由 sessionLogFiles 的同一次 statSync 带回。
	for (const { mtimeMs } of sessionLogFiles(base, unexpected)) {
		if (mtimeMs > latest) latest = mtimeMs;
	}
	if (probeBroken) return Date.now();
	return latest;
}
