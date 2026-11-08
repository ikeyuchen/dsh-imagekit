/**
 * find-7z.mjs —— 自测脚本共用的 7-Zip 查找：优先显式 SEVEN_ZIP，其次平台默认位置与 PATH。
 *
 * 为什么需要：CI 跑在 ubuntu（p7zip-full 提供 /usr/bin/7z），而本机是 Windows。
 * 早先只写了 Windows 路径，导致 Linux 上找不到 7z → 退回「按需下载内置 7zr」→
 * 去下 Windows 的 7zr.exe，CI 必红。
 */
import { existsSync } from "node:fs";
import path from "node:path";

const WIN_CANDIDATES = [
	process.env.SEVEN_ZIP,
	"C:/Program Files/7-Zip/7z.exe",
	"C:/Program Files (x86)/7-Zip/7z.exe"
];

/** 在 PATH 里找可执行文件（不区分平台）。 */
function fromPath(names) {
	for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
		if (dir === "") continue;
		for (const name of names) {
			const full = path.join(dir, name);
			if (existsSync(full)) return full;
		}
	}
	return "";
}

/** 返回 7-Zip 可执行文件路径；找不到返回 ''（调用方据此 skip 或走兜底）。 */
export function find7z() {
	if (process.platform === "win32") {
		for (const candidate of WIN_CANDIDATES) if (candidate && existsSync(candidate)) return candidate;
		return fromPath(["7z.exe", "7za.exe"]);
	}
	return fromPath(["7z", "7za", "7zz"]);
}

export { find7z as default };
