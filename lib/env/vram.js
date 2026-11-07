/**
 * 显存读取（preflight 与 env_probe 共用）
 *
 * 优先级：
 *   1. perfmon 数据目录（Config.perfmonDataDir，默认 %USERPROFILE%\.dsh\perfmon）里
 *      最新的 perf-*.jsonl —— 取最后一条 `k==="t"` 的 tick，与 perf(action=snapshot) 同源
 *   2. nvidia-smi --query-gpu=... 解析
 * 读不到就诚实地报告 source=null（上层据此降级为 warn，而不是假装 0 占用）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** 从文件尾部往前读，找最后一条满足 predicate 的 JSON 行。 */
function lastMatchingLine(file, predicate, { chunkBytes = 256 * 1024, maxBytes = 8 * 1024 * 1024 } = {}) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fs.fstatSync(fd).size
    let read = 0
    let carry = ''
    let offset = size
    while (offset > 0 && read < maxBytes) {
      const len = Math.min(chunkBytes, offset)
      offset -= len
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, offset)
      // chunk 头部的孤立续字节不能独立解码：其引导字节在更早的
      // chunk 里，独立 toString 会把劈开的多字节字符（census 行的中文进程名等）解码
      // 成 U+FFFD 弄坏该行数据。数出头部孤立续字节（≤3，最长 UTF-8 序列 4 字节）、
      // 退回 offset，让这些字节与引导字节在下一轮一起完整解码；offset 已是 0（文件
      // 开头）时不再回退——文件首就是续字节属于本来就非法的 UTF-8。
      let start = 0
      while (start < 3 && start < len && offset > 0 && (buf[start] & 0xc0) === 0x80) start += 1
      if (start > 0) offset += start
      const text = buf.toString('utf8', start, len) + carry
      const lines = text.split('\n')
      carry = lines.shift() ?? ''
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim()
        if (line === '') continue
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (predicate(parsed)) return parsed
      }
      read += len - start
    }
    // 循环结束后 carry 里可能是文件首行（单行文件/目标行恰是首行时它从未被评估，
    //）：按同样逻辑补判一次。截断场景的 carry 是半行，JSON.parse 自然失败。
    const first = carry.trim()
    if (first !== '') {
      try {
        const parsed = JSON.parse(first)
        if (predicate(parsed)) return parsed
      } catch {
        /* 非 JSON：放弃 */
      }
    }
    return undefined
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
  }
}

/** perfmon 样本新鲜度门槛（秒）：超过现视为停写残留，改走下一来源（其它目录 /
 * nvidia-smi），不让 preflight 拿旧占用做 go/no-go（与 env.js
 * 的 120s 标注阈值对齐）。 */
const PERFMON_STALE_SEC = 120

/** 在 perfmon 数据目录里找最新的 perf-*.jsonl。 */
export function findLatestPerfFile(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  for (const name of entries) {
    if (!/^perf-.*\.jsonl$/i.test(name)) continue
    const full = path.join(dir, name)
    try {
      const stat = fs.statSync(full)
      if (best === null || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      /* ignore */
    }
  }
  return best
}

/** 解析 nvidia-smi 的 CSV 输出（memory.total, memory.used, memory.free, utilization.gpu, name）。 */
export function parseNvidiaSmi(text) {
  // 逐行显式解析：--query-gpu 多 GPU 一行一卡，旧的
  // `.find(l => /\d/.test(l))` 在 GPU 0 的行不含数字（如全部字段 [Not Supported]）时
  // 会错位取到后面某卡的行、来源不确定；name 是最后一个字段，含逗号的卡名用
  // slice(4).join(',') 拼回，不被 split 截断。
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(',').map((p) => p.trim())
    const total = Number(parts[0])
    const used = Number(parts[1])
    if (!Number.isFinite(total) || !Number.isFinite(used)) continue
    const free = Number(parts[2])
    rows.push({
      name: parts.length > 4 ? parts.slice(4).join(',') : null,
      totalMiB: total,
      usedMiB: used,
      freeMiB: Number.isFinite(free) ? free : Math.max(0, total - used),
      utilPct: Number.isFinite(Number(parts[3])) ? Number(parts[3]) : null,
      tempC: null,
      sharedMiB: null,
      source: 'nvidia-smi',
    })
  }
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0]
  // 多 GPU：聚合各卡显存并在 name 里标注张数与首卡（——不再静默只代表 GPU 0）
  return {
    ...rows[0],
    name: `${rows.length}×GPU（首卡 ${rows[0].name ?? '?'}，已聚合）`,
    totalMiB: rows.reduce((s, r) => s + r.totalMiB, 0),
    usedMiB: rows.reduce((s, r) => s + r.usedMiB, 0),
    freeMiB: rows.reduce((s, r) => s + r.freeMiB, 0),
  }
}

/** 直接问 nvidia-smi 要一次显存。 */
export function readNvidiaSmi() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total,memory.used,memory.free,utilization.gpu,name', '--format=csv,noheader,nounits'],
      // nvidia-smi 正常亚秒级返回：15s 的同步超时最坏会把整条
      // preflight 主流程卡住 15s；收紧到 5s——同步兜底读法保持，完整异步化另行安排。
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    )
    return parseNvidiaSmi(out)
  } catch {
    return null
  }
}

/**
 * 主入口：优先 perfmon 数据，其次 nvidia-smi。
 * @returns {{vram: object|null, source: string|null, evidence: object}}
 */
export function readVram(config) {
  // 回退目录用跨平台主目录链（与 config.js 的 HOME 同款）：USERPROFILE
  // 只在 Windows 存在，POSIX 下用空串拼 path.join 会得到相对路径 .dsh/perfmon——
  // 相对 CWD 而非用户主目录，行为隐蔽。
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()
  const dirs = [config?.perfmonDataDir, path.join(home, '.dsh', 'perfmon'), config?.dataDir]
    .filter((d) => typeof d === 'string' && d !== '')
  const tried = []
  for (const dir of dirs) {
    const latest = findLatestPerfFile(dir)
    tried.push({ dir, file: latest?.file ?? null })
    if (latest === null) continue
    const tick = lastMatchingLine(latest.file, (r) => r?.k === 't' && r?.gpu !== undefined && r.gpu !== null)
    const census = lastMatchingLine(latest.file, (r) => r?.k === 'c' && Number.isFinite(r?.nonLocalTotalMiB))
    if (tick !== undefined) {
      const ageSec = Number.isFinite(Number(tick.t)) ? Math.max(0, Math.round((Date.now() - Number(tick.t)) / 1000)) : null
      if (ageSec !== null && ageSec > PERFMON_STALE_SEC) {
        // 样本过期：perfmon 已崩溃/停写，降级继续找下一来源
        tried[tried.length - 1] = { ...tried[tried.length - 1], staleTickSec: ageSec }
        continue
      }
      const gpu = tick.gpu
      const total = Number(gpu.totalMiB)
      const used = Number(gpu.usedMiB)
      return {
        vram: {
          name: gpu.name ?? null,
          totalMiB: Number.isFinite(total) ? total : null,
          usedMiB: Number.isFinite(used) ? used : null,
          freeMiB: Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : null,
          utilPct: Number.isFinite(Number(gpu.utilPct)) ? Number(gpu.utilPct) : null,
          tempC: Number.isFinite(Number(gpu.tempC)) ? Number(gpu.tempC) : null,
          sharedMiB: Number.isFinite(Number(census?.nonLocalTotalMiB)) ? Number(census.nonLocalTotalMiB) : null,
          source: 'perfmon',
          ageSec,
        },
        source: 'perfmon',
        evidence: { file: latest.file, mtimeMs: latest.mtimeMs, tickAt: tick.t ?? null, tried },
      }
    }
  }
  const smi = readNvidiaSmi()
  if (smi !== null) {
    return { vram: { ...smi, source: 'nvidia-smi', ageSec: 0 }, source: 'nvidia-smi', evidence: { tried, nvidiaSmi: true } }
  }
  return { vram: null, source: null, evidence: { tried, reason: 'perfmon 数据目录与 nvidia-smi 都读不到显存' } }
}
