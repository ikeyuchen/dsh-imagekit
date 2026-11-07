/**
 * dsh-plugin-perfmon — 历史存储（JSONL 环形）
 * ============================================================
 * 按小时滚动 perf-YYYYMMDDHH.jsonl（UTC 命名），超过 retentionHours 的文件
 * 在翻滚时删除；内存保留最近 memWindowMs（默认 2h）供快查询，更早的窗口
 * 从文件按需扫描（记录含毫秒时间戳，内存/文件按 t 去重）。任务打点持久化
 * 在 marks.json（active 未闭合 / finished 最近 50 条含摘要）。
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

const HOUR = 3_600_000;

function hourStamp(t) {
	const d = new Date(t);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

export class PerfStore {
	constructor({ dir, retentionHours = 48, memWindowMs = 2 * HOUR }) {
		this.dir = dir;
		this.retentionHours = retentionHours;
		this.memWindowMs = memWindowMs;
		this.ticks = [];
		this.censuses = [];
		this.lastStats = null;
		this.marks = { seq: 0, active: [], finished: [] };
		this._curStamp = null;
		this._dataBytes = 0;
	}

	fileFor(stamp) {
		return path.join(this.dir, `perf-${stamp}.jsonl`);
	}

	get marksFile() {
		return path.join(this.dir, "marks.json");
	}

	init() {
		mkdirSync(this.dir, { recursive: true });
		const now = Date.now();
		const floor = now - this.memWindowMs;
		for (const stamp of [hourStamp(now - HOUR), hourStamp(now)]) {
			const file = this.fileFor(stamp);
			if (!existsSync(file)) continue;
			try {
				for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
					if (line === "") continue;
					try {
						const rec = JSON.parse(line);
						if (typeof rec.t !== "number" || rec.t < floor) continue;
						if (rec.k === "t") this.ticks.push(rec);
						else if (rec.k === "c") this.censuses.push(rec);
					} catch {}
				}
			} catch {}
		}
		this.ticks.sort((a, b) => a.t - b.t);
		this.censuses.sort((a, b) => a.t - b.t);
		this._pruneFiles();
		this._loadMarks();
		this._dataBytes = this._dirBytes();
	}

	append(record) {
		try {
			const stamp = hourStamp(record.t);
			if (stamp !== this._curStamp) {
				this._curStamp = stamp;
				this._pruneFiles();
			}
			const line = JSON.stringify(record) + "\n";
			appendFileSync(this.fileFor(stamp), line, "utf8");
			this._dataBytes += line.length;
		} catch {}
		if (record.k === "s") {
			this.lastStats = record;
			return;
		}
		const arr = record.k === "t" ? this.ticks : record.k === "c" ? this.censuses : null;
		if (!arr) return;
		arr.push(record);
		const floor = record.t - this.memWindowMs;
		while (arr.length > 0 && arr[0].t < floor) arr.shift();
	}

	/**
	 * 主线程视图刷新：从磁盘重建最近 memWindowMs 的 ticks/censuses 与 lastStats
	 * （worker 线程是唯一写方，主线程只读；每次工具调用前调用）。
	 */
	refreshFromDisk() {
		const now = Date.now();
		const floor = now - this.memWindowMs;
		const ticks = [];
		const censuses = [];
		let lastStats = null;
		let bytes = 0;
		for (const stamp of [hourStamp(now - HOUR), hourStamp(now)]) {
			const file = this.fileFor(stamp);
			if (!existsSync(file)) continue;
			try {
				bytes += statSync(file).size;
			} catch {}
			try {
				for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
					if (line === "") continue;
					try {
						const rec = JSON.parse(line);
						if (typeof rec.t !== "number" || rec.t < floor) continue;
						if (rec.k === "t") ticks.push(rec);
						else if (rec.k === "c") censuses.push(rec);
						else if (rec.k === "s") lastStats = rec;
					} catch {}
				}
			} catch {}
		}
		try {
			bytes += statSync(this.marksFile).size;
		} catch {}
		ticks.sort((a, b) => a.t - b.t);
		censuses.sort((a, b) => a.t - b.t);
		this.ticks = ticks;
		this.censuses = censuses;
		this.lastStats = lastStats;
		this._dataBytes = bytes;
		return { ticks: ticks.length, censuses: censuses.length };
	}

	/** 时间窗内的轻拍记录（内存不足时回扫文件）。 */
	ticksInRange(from, to) {
		return this._range(this.ticks, from, to, "t");
	}

	/** 时间窗内的普查记录。 */
	censusesInRange(from, to) {
		return this._range(this.censuses, from, to, "c");
	}

	_range(mem, from, to, kind) {
		const result = mem.filter((r) => r.t >= from && r.t <= to);
		const memFloor = Date.now() - this.memWindowMs;
		if (from >= memFloor) return result;
		const seen = new Set(result.map((r) => r.t));
		for (let ts = from; ts <= to; ts += HOUR) {
			const file = this.fileFor(hourStamp(ts));
			if (!existsSync(file)) continue;
			try {
				for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
					if (line === "") continue;
					try {
						const rec = JSON.parse(line);
						if (rec.k !== kind || typeof rec.t !== "number") continue;
						if (rec.t < from || rec.t > to || seen.has(rec.t)) continue;
						seen.add(rec.t);
						result.push(rec);
					} catch {}
				}
			} catch {}
		}
		result.sort((a, b) => a.t - b.t);
		return result;
	}

	_pruneFiles() {
		try {
			const minStamp = hourStamp(Date.now() - this.retentionHours * HOUR);
			for (const name of readdirSync(this.dir)) {
				const m = name.match(/^perf-(\d{10})\.jsonl$/);
				if (!m) continue;
				if (m[1] < minStamp) {
					try {
						unlinkSync(path.join(this.dir, name));
					} catch {}
				}
			}
		} catch {}
	}

	_dirBytes() {
		let sum = 0;
		try {
			for (const name of readdirSync(this.dir)) {
				try {
					sum += statSync(path.join(this.dir, name)).size;
				} catch {}
			}
		} catch {}
		return sum;
	}

	dataMB() {
		return Math.round((this._dataBytes / 1048576) * 10) / 10;
	}

	_loadMarks() {
		try {
			this.marks = { seq: 0, active: [], finished: [], ...JSON.parse(readFileSync(this.marksFile, "utf8")) };
		} catch {}
	}

	saveMarks() {
		try {
			writeFileSync(this.marksFile, JSON.stringify(this.marks), "utf8");
		} catch {}
	}
}

export { HOUR, hourStamp };
