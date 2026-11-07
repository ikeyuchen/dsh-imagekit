/**
 * preflight —— 重活前置闸门（go / no-go）
 *
 * 在 12GB 显存的机器上，最贵的错误不是"跑慢"，而是**共享显存溢出后静默变慢**
 * （10-50x，无报错）。所以这里把显存、共享显存、端口占用、引擎健康、CPU 余量
 * 逐条转成 go/no-go 与原因，而不是给一堆原始数字让模型自己猜。
 */
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { probePorts, probeHttp, readJson, writeJsonAtomic, nowIso, exclusionBlocksBind } from './util.js'
import { readVram } from './vram.js'

const MIB = 1024 * 1024

/** needs.ports 归一化：judge 与 runPreflight 原各自实现一份且
 *  容忍度不一（非数组输入一个 TypeError 一个静默空）——提取单一实现，判定集合与
 *  实际探测集合不再漂移。 */
const normalizePorts = (ports) =>
  (Array.isArray(ports) ? ports : []).map(Number).filter((n) => Number.isFinite(n) && n > 0)

/** 打点 id 用「时间 + 随机后缀」保证同毫秒并发不撞（旧版是模块级自增计数器，
 *  属防御模式禁止的模块级可变状态；id 是事后归因打点记录的键）。 */


/** 采一次 CPU 使用率（两次 os.cpus() 快照之间的差值）。 */
export async function sampleCpu(signal, windowMs = 350) {
  const snap = () => os.cpus().map((c) => ({ ...c.times }))
  const before = snap()
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      // 正常 resolve 路径也要摘掉 abort 监听：{once:true} 只在事件
      // 触发后自动移除，signal 从未 abort 时 onAbort 闭包（引用 timer/resolve/reject）
      // 会一直挂在长生命周期信号上持续累积。
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, windowMs)
    if (signal === undefined || signal === null) return
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  const after = snap()
  let idle = 0
  let total = 0
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i]
    const a = after[i]
    const dIdle = a.idle - b.idle
    const dTotal = a.user - b.user + (a.nice - b.nice) + (a.sys - b.sys) + dIdle + (a.irq - b.irq)
    idle += dIdle
    total += dTotal
  }
  if (total <= 0) return { usedPct: null, freePct: null, cores: before.length }
  const used = Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10))
  return { usedPct: used, freePct: Math.round((100 - used) * 10) / 10, cores: before.length }
}

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null
}

/** 逐条判定，产出 reasons[] 与 go。 */
export function judge({ needs, vram, ports, engines, cpu }) {
  const reasons = []
  let go = true

  const needVram = num(needs?.vramMiB)
  if (needVram !== null && needVram > 0) {
    // vram 按可缺失归一（judge 是导出函数，调用方传了 needs.vramMiB
    // 而 vram 为 undefined 时裸访问字段会抛 TypeError；同函数内 sharedMiB 已用 ?. 防御）
    const freeVram = vram === null || vram === undefined || vram.freeMiB === null || vram.freeMiB === undefined
      ? null
      : vram.freeMiB
    if (freeVram === null) {
      reasons.push({ level: 'warn', kind: 'vram', text: `需要 ${needVram} MiB 显存，但读不到 GPU 余量（perfmon 数据与 nvidia-smi 都不可用）——按需自担风险`, fix: 'nvidia-smi' })
    } else if (freeVram < needVram) {
      go = false
      reasons.push({
        level: 'no-go',
        kind: 'vram',
        text: `显存不足：需要 ${needVram} MiB，专用显存仅余 ${freeVram} MiB / 共 ${vram.totalMiB} MiB（已用 ${vram.usedMiB} MiB）`,
        fix: '先释放显存（comfy action=control,op=free）或降低 batch/分辨率；也可用 perf(action=snapshot) 看是谁占着',
      })
    } else {
      reasons.push({ level: 'go', kind: 'vram', text: `显存充足：需要 ${needVram} MiB，专用余量 ${freeVram} MiB` })
    }
  }

  const sharedMax = num(needs?.sharedMemMaxMiB)
  if (sharedMax !== null && sharedMax >= 0) {
    const shared = vram?.sharedMiB ?? null
    if (shared === null) {
      reasons.push({ level: 'warn', kind: 'sharedVram', text: `无法读到共享显存占用（无法确认是否已在溢出降速）`, fix: 'perf(action=snapshot) 或 nvidia-smi' })
    } else if (shared > sharedMax) {
      go = false
      reasons.push({
        level: 'no-go',
        kind: 'sharedVram',
        text: `共享显存已在溢出：当前 ${shared} MiB > 允许 ${sharedMax} MiB（这会静默变慢 10-50x）`,
        fix: '等当前 GPU 任务结束，或 comfy action=control,op=free 释放显存后重试',
      })
    } else {
      reasons.push({ level: 'go', kind: 'sharedVram', text: `共享显存占用 ${shared} MiB ≤ 允许 ${sharedMax} MiB` })
    }
  }

  // 与 runPreflight 用同一套端口归一化 normalizePorts，且提到循环外
  // 只算一次：旧写法每行都重建数组，NaN/负数还会因 Number() 松散相等误判 required
  const wantedPortNums = normalizePorts(needs?.ports)
  for (const row of ports ?? []) {
    const required = wantedPortNums.includes(Number(row.port))
    if (row.status === 'listening') {
      const owned = row.owner !== null ? `${row.owner} (pid ${row.pid})` : `pid ${row.pid}`
      // required 端口被占对「任务要自己绑定监听」的场景就是冲突，
      // 而 'go' 是本模块最积极的放行信号——needs 还区分不了 bind/connect，语义明确
      // 前被占一律只提示 warn（不擅自 no-go），不再给 required 被占打 go 级原因。
      reasons.push({ level: 'warn', kind: `port:${row.port}`, text: `端口 ${row.port} 已被占用：${owned}${required ? '（如需独占监听，先停掉它）' : ''}` })
    } else if (required) {
      go = false
      // 动态预留段挡住时，"去启动服务" 是错的建议——启动必报 WinError 10013；
      // 管理员保留段（`*`）不影响绑定，继续按普通"未监听"处理。
      reasons.push(
        exclusionBlocksBind(row.excluded)
          ? {
              level: 'no-go',
              kind: `port:${row.port}`,
              text: `端口 ${row.port} 落在 Windows 排除段 ${row.excluded.start}-${row.excluded.end} 内：服务根本绑不上（WinError 10013），但任务需要它`,
              fix: '以管理员执行：net stop winnat ; netsh int ipv4 set dynamic tcp start=49152 num=16384 ; net start winnat，然后重启引擎',
            }
          : {
              level: 'no-go',
              kind: `port:${row.port}`,
              text: `端口 ${row.port} 未监听，但任务需要它`,
              fix: `先启动占用该端口的服务（或运行对应引擎的 status 工具确认启动方式）`,
            },
      )
    } else {
      reasons.push({ level: 'warn', kind: `port:${row.port}`, text: `端口 ${row.port} 未监听` })
    }
  }

  for (const row of engines ?? []) {
    if (row.status === 'ok') reasons.push({ level: 'go', kind: `engine:${row.name}`, text: `引擎 ${row.name} 健康（${row.detail}）` })
    else if (row.required) {
      go = false
      reasons.push({ level: 'no-go', kind: `engine:${row.name}`, text: `引擎 ${row.name} 不可用（${row.detail}）`, fix: row.fix })
    } else {
      reasons.push({ level: 'warn', kind: `engine:${row.name}`, text: `引擎 ${row.name} 不可用（${row.detail}）`, fix: row.fix })
    }
  }

  const cpuPct = num(needs?.cpuPct)
  if (cpuPct !== null && cpuPct > 0) {
    // cpu 同样按可缺失归一（cpu 缺失时裸访问 freePct 会抛 TypeError）
    const cpuFree = cpu === null || cpu === undefined || cpu.freePct === null || cpu.freePct === undefined
      ? null
      : cpu.freePct
    if (cpuFree === null) reasons.push({ level: 'warn', kind: 'cpu', text: 'CPU 使用率采样失败' })
    else if (cpuFree < cpuPct) {
      go = false
      reasons.push({ level: 'no-go', kind: 'cpu', text: `CPU 余量不足：需要 ${cpuPct}% 空闲，当前只有 ${cpuFree}%（已用 ${cpu?.usedPct ?? '?'}%）`, fix: '等当前 CPU 密集任务结束，或降低并行度' })
    } else {
      reasons.push({ level: 'go', kind: 'cpu', text: `CPU 余量足够：空闲 ${cpuFree}% ≥ 需要 ${cpuPct}%` })
    }
  }

  return { go, reasons }
}

/** 打点：把这次预检记进插件数据目录（便于事后回答"当时为什么放行/拦住"）。 */
export function recordMark(config, entry) {
  const file = path.join(config.dataDir, 'preflight-marks.json')
  const data = readJson(file)
  const list = Array.isArray(data) ? data : []
  // 不再用模块级自增计数器（防御模式：共享可变状态必须有所有者）；
  // 时间 + 随机后缀已足够区分同毫秒内的并发打点。
  const id = `pf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const row = { id, ...entry }
  list.push(row)
  try {
    writeJsonAtomic(file, list.slice(-200))
  } catch {
    /* 打点失败不影响结论 */
  }
  return { id, file }
}

/** 主入口。 */
export async function runPreflight({ config, needs = {}, signal }) {
  const { vram, source, evidence } = readVram(config)
  const wantedPorts = normalizePorts(needs.ports)
  const portRows = probePorts(wantedPorts.length > 0 ? wantedPorts : (config.enginePorts ?? []))

  const wantedEngines = new Set(Array.isArray(needs.engines) ? needs.engines.map((e) => String(e)) : [])
  // 并行探测：probeHttp 只在调用方 abort 时抛错（util.js 的取消语义），Promise.all 安全
  const engineRows = (
    await Promise.all(
      (config.engines ?? []).map(async (engine) => {
        const required = wantedEngines.has(String(engine.name))
        if (!required && wantedEngines.size > 0) return null
        let probe
        try {
          probe = await probeHttp(engine.url, { timeoutMs: 4000, signal })
        } catch (error) {
          if (signal?.aborted) throw error
          probe = { ok: false, status: null, ms: 0, error: String(error?.message ?? error) }
        }
        return {
          name: String(engine.name),
          status: probe.ok ? 'ok' : 'down',
          detail: probe.ok
            ? `HTTP ${probe.status} (${probe.ms}ms)`
            : (probe.error ?? `HTTP ${probe.status}`),
          url: engine.url,
          required,
          fix: engine.fix ?? null,
        }
      }),
    )
  ).filter((row) => row !== null)
  if (wantedEngines.size > 0) {
    for (const name of wantedEngines) {
      if (!engineRows.some((r) => r.name === name)) {
        engineRows.push({ name, status: 'unknown', detail: 'Config.engines 里没有这个引擎', url: null, required: true, fix: `把 ${name} 加进 Config.engines` })
      }
    }
  }

  const cpu = await sampleCpu(signal)
  const { go, reasons } = judge({ needs, vram, ports: portRows, engines: engineRows, cpu })

  const ram = { totalMB: Math.round(os.totalmem() / 1024 / 1024), freeMB: Math.round(os.freemem() / 1024 / 1024) }

  return {
    vram,
    vramSource: source,
    vramEvidence: evidence,
    ports: portRows,
    engines: engineRows,
    cpu,
    ram,
    go,
    reasons,
    needs: {
      task: null,
      vramMiB: num(needs?.vramMiB),
      sharedMemMaxMiB: num(needs?.sharedMemMaxMiB),
      ports: wantedPorts,
      engines: [...wantedEngines],
      cpuPct: num(needs?.cpuPct),
    },
    capturedAt: nowIso(),
    mib: MIB,
  }
}
