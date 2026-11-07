/**
 * @local/dsh-plugin-guard —— 共享工具原语（跨工具各自复制，不建共享包）
 *
 * 硬性规则：每个子进程/网络等待点都要把调用方的
 * `exec.signal` 与本工具超时**合成**一个信号，并且降级 catch 不得把取消
 * 吞成"部分成功"——统一用 withDeadline / rethrowIfAborted 这一对。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

/* ------------------------------------------------------------------ */
/* 取消语义                                                             */
/* ------------------------------------------------------------------ */

/** 合成 `exec.signal` 与本工具超时；没有调用方信号时只用超时。 */
export function withDeadline(timeoutMs, signal) {
  const deadline = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs)))
  return signal === undefined || signal === null ? deadline : AbortSignal.any([signal, deadline])
}

/** 调用方取消必须向上传播：降级 catch 不能把「已取消」变成「部分成功」。 */
export function rethrowIfAborted(error, signal) {
  if (signal !== undefined && signal !== null && signal.aborted) throw error
}

/* ------------------------------------------------------------------ */
/* 子进程                                                              */
/* ------------------------------------------------------------------ */

/** 杀掉整棵进程树（Windows 用 taskkill /T，其它平台退化为负 PID）。 */
export function killTree(child) {
  if (child === undefined || child === null) return
  const pid = child.pid
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 进程可能已经退出 */
    }
  }
}

/**
 * 跑一个子进程并收集输出。
 * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, ms:number, killed:boolean, error:string|null, signal:string|null}>}
 */
export function runProcess(file, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 60000,
    signal,
    maxBuffer = 4 * 1024 * 1024,
    stdin,
  } = options
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 上以独立进程组拉起（detached），killTree 的 process.kill(-pid) 才杀得
        // 到整组；Windows 用 taskkill /T 杀树，不需要也不应 detached
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', ms: 0, killed: false, error: String(error?.message ?? error), signal: null })
      return
    }

    // spawn 成功立即挂空 error 监听（在 end() 之前）：子进程先退时 stdin.end(data)
    // 的异步写会 EPIPE，未处理的 'error' 事件会直接崩掉宿主进程
    child.stdin?.on('error', () => {})

    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let errBytes = 0
    let truncatedBytes = 0
    let killed = false
    let timedOut = false
    let settled = false
    let timer = null
    let graceTimer = null

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const clearGrace = () => {
      if (graceTimer !== null) clearTimeout(graceTimer)
      graceTimer = null
    }

    // 流式解码：stdout/stderr 各用一个**复用的** TextDecoder（stream 模式保留跨
    // chunk 的多字节状态；两个流共享一个解码器会把彼此的字节序混进同一状态机）。
    // 字节计数用原始 chunk 长度，不按解码文本重编码（宽字符会漂移）。
    const outDecoder = new TextDecoder()
    const errDecoder = new TextDecoder()
    const onData = (chunk, which) => {
      const bytes = typeof chunk?.byteLength === 'number'
        ? chunk.byteLength
        : Buffer.byteLength(String(chunk))
      const text = which === 'out'
        ? outDecoder.decode(chunk, { stream: true })
        : errDecoder.decode(chunk, { stream: true })
      if (which === 'out') {
        outBytes += bytes
        if (outBytes <= maxBuffer) stdout += text
        else truncatedBytes += bytes
      } else {
        errBytes += bytes
        if (errBytes <= maxBuffer) stderr += text
        else truncatedBytes += bytes
      }
    }
    child.stdout?.on('data', (c) => onData(c, 'out'))
    child.stderr?.on('data', (c) => onData(c, 'err'))
    // 流结束时冲刷解码器里悬着的半个多字节字符（无参 decode()）
    child.stdout?.on('end', () => { stdout += outDecoder.decode() })
    child.stderr?.on('end', () => { stderr += errDecoder.decode() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimer()
      clearGrace()
      // 与 finish 分支对齐：摘掉 abort 监听、补 timedOut 字段，两个分支形状一致
      signal?.removeEventListener?.('abort', onAbort)
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${String(error?.message ?? error)}`,
        ms: Date.now() - started,
        killed,
        timedOut,
        error: String(error?.message ?? error),
        signal: null,
        truncatedBytes,
      })
    })

    // killTree 之后 close 仍可能永不到来：孙进程（detached/setsid）继承 stdio 管道时
    // close 要求三条流全部关闭、会一直等下去——挂一个 unref 的短 grace 定时器强制
    // settle，保证 runProcess 永不挂死（有界规则）。
    const settleAfterKill = () => {
      if (graceTimer === null) {
        graceTimer = setTimeout(() => finish(null, 'killed'), 2000)
        graceTimer.unref?.()
      }
    }

    const finish = (exitCode, sig) => {
      if (settled) return
      settled = true
      clearTimer()
      clearGrace()
      signal?.removeEventListener?.('abort', onAbort)
      resolve({
        exitCode,
        stdout,
        stderr,
        ms: Date.now() - started,
        killed,
        timedOut,
        error: null,
        signal: sig ?? null,
        truncatedBytes,
      })
    }

    child.on('close', (code, sig) => finish(code, sig))

    const onAbort = () => {
      killed = true
      killTree(child)
      settleAfterKill()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    timer = setTimeout(() => {
      killed = true
      timedOut = true
      killTree(child)
      settleAfterKill()
    }, Math.max(1, Math.round(timeoutMs)))

    if (typeof stdin === 'string') {
      try {
        child.stdin?.end(stdin)
      } catch {
        /* 忽略：进程可能已退出 */
      }
    } else {
      try {
        child.stdin?.end()
      } catch {
        /* 忽略 */
      }
    }
  })
}

/** 同步探测一个可执行文件的版本（短超时；失败返回 null）。 */
export function execVersion(file, args, timeoutMs = 8000) {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return String(out).trim()
  } catch (error) {
    const out = error?.stdout
    if (out) return String(out).trim()
    return null
  }
}

/** 在 PATH / 常见安装位置里解析一个可执行文件；找不到返回 null。 */
export function resolveExec(name, extraDirs = []) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null
  const exts = process.platform === 'win32' ? (path.extname(name) ? [''] : ['.exe', '.cmd', '.bat', '']) : ['']
  const localApps = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null
  const dirs = [
    ...extraDirs,
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    // MSIX 执行别名目录：pwsh 7 的真身可能在 WindowsApps 里，别名 stat 会 EACCES，
    // 但它确实是可用入口（不列出来就会静默落到 Windows PowerShell 5.1，）
    ...(localApps ? [localApps] : []),
    'C:\\Program Files\\PowerShell\\7',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  ]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      // 不能写成 `existsSync(c) && statSync(c)...`：MSIX 别名的 existsSync 返回 **false**，
      // 会短路掉 statSync，让 EACCES 分支永远不执行（2026-10-02 实测踩到，导致
      // env_probe 仍把本机错报成只有 PowerShell 5.1）。直接 statSync：
      // ENOENT = 不存在（继续找），EACCES/EPERM = 在但被拒 = 可用入口。
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch (error) {
        const code = error?.code
        // EACCES/EPERM 容错只针对 Windows 的 MSIX 执行别名目录（WindowsApps 里 stat
        // 报 EACCES）：其它目录/平台上「读不到」不能当「可用入口」，
        // 否则位于更靠前 PATH 目录、权限被拒的非可执行文件会截断搜索，遮住后面目录
        // 里的真身（POSIX 无权限目录下的 stat 同样报 EACCES，会命中假路径）。
        if (code === 'EACCES' || code === 'EPERM') {
          const aliasRoot = localApps !== null ? localApps.toLowerCase() : ''
          if (process.platform === 'win32' && aliasRoot !== '' && candidate.toLowerCase().startsWith(aliasRoot)) return candidate
        }
      }
    }
  }
  return null
}

/** 解析 shell：优先 Config.shellPath，其次 pwsh.exe，最后 powershell.exe。 */
export function resolveShell(preferred) {
  if (preferred && preferred !== 'pwsh.exe') {
    const found = resolveExec(preferred)
    if (found) return found
  }
  return (
    resolveExec('pwsh.exe', ['C:\\Program Files\\PowerShell\\7']) ??
    resolveExec('powershell.exe', ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0']) ??
    null
  )
}

/* ------------------------------------------------------------------ */
/* 端口 / HTTP                                                         */
/* ------------------------------------------------------------------ */

/**
 * Windows 排除端口段（Hyper-V/WSL 启动时动态预留）。端口落在里面时，**任何进程绑定都会失败**
 * ——`WinError 10013`（"以一种访问权限不允许的方式做了一个访问套接字的尝试"），而 netstat 里
 * 根本找不到占用者。2026-10-03 实测：生图网关 8189 与 ComfyUI 8188 **双双**落在 8105–8204 内，
 * 整个生图/3D 栈起不来，而当时的 env_probe 只会说"未监听"，fix 又是"先启动它"（启动必失败）。
 * 查询只读且只做一次。
 */
/**
 * 进程级只读缓存（所有权声明）：这是操作系统「端口排除段」能力的进程快照，
 * 不是业务数据；owner = guard 插件模块，首次读取后不可变。防御模式要求共享状态
 * 有明确所有者——这里以该声明替代实例迁移（结果与实例无关，且每进程只需查一次 netsh）。
 */
let _excludedRanges = null
export function excludedPortRanges() {
  if (_excludedRanges !== null) return _excludedRanges
  _excludedRanges = []
  if (process.platform !== 'win32') return _excludedRanges
  try {
    const out = execFileSync('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    // 行形如："      8105        8204"（动态预留）或 "     50000       50059     *"（管理员保留）
    for (const m of out.matchAll(/^\s*(\d{2,5})\s+(\d{2,5})(\s*\*)?\s*$/gm)) {
      _excludedRanges.push({ start: Number(m[1]), end: Number(m[2]), administered: Boolean(m[3]) })
    }
  } catch {
    /* netsh 不可用（非 Windows/被裁剪）：当作没有排除段，宁可不报也不误报 */
  }
  return _excludedRanges
}

/** 纯匹配器（可直接测）：port 落在哪个段内，没有则 null。 */
export function rangeCovers(ranges, port) {
  const p = Number(port)
  return (ranges ?? []).find((r) => p >= r.start && p <= r.end) ?? null
}

/** 该端口落在哪个排除段里（可能不阻断绑定，看 `administered`）。 */
export function excludedRangeFor(port) {
  return rangeCovers(excludedPortRanges(), port)
}

/**
 * 这个排除段是否**真的会阻断绑定**。两种段行为完全不同（2026-10-03 实测区分）：
 *   - 动态预留（无 `*`）：端口被 Hyper-V/WSL 预定，普通进程绑定报 `WinError 10013`；
 *   - 管理员保留（带 `*`，`netsh … add excludedportrange`）：**不阻断显式绑定**，作用是
 *     把端口从动态分配器手里保护下来。对照证据：本机 8188/8189 就在 `8188 8189 *` 段内，
 *     而两个引擎都正常监听——把这两种当成一回事会给出“去让开动态段”的错建议，
 *     甚至让用户拆掉自己刚加的保护。
 */
export function exclusionBlocksBind(range) {
  return Boolean(range) && range.administered === false
}

/** 并行探测一组端口监听状态 + 占用者（netstat）；返回按入参顺序的结果。 */
export function probePorts(ports) {
  const table = new Map()
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
      if (m) {
        const port = Number(m[2])
        if (!table.has(port)) table.set(port, { address: m[1], pid: Number(m[3]) })
      }
    }
  } catch {
    /* netstat 不可用：只报未监听 */
  }
  const names = new Map()
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
      if (m) names.set(Number(m[2]), m[1])
    }
  } catch {
    /* tasklist 不可用：占用者名字留空 */
  }
  return (ports ?? []).map((port) => {
    const entry = table.get(Number(port))
    if (!entry) return { port: Number(port), status: 'free', pid: null, owner: null, excluded: excludedRangeFor(port) }
    return { port: Number(port), status: 'listening', pid: entry.pid, owner: names.get(entry.pid) ?? null, excluded: null }
  })
}

/** 探一个 HTTP 端点（只看状态码与是否可解析为 JSON）；永不抛错。 */
export async function probeHttp(url, { timeoutMs = 4000, signal, maxBytes = 2 * 1024 * 1024 } = {}) {
  const started = Date.now()
  const composed = withDeadline(timeoutMs, signal)
  try {
    const res = await fetch(url, { signal: composed, headers: { accept: 'application/json,text/plain,*/*' } })
    // 限量读取：与 runProcess 的 maxBuffer 防护对齐——探测端点
    // 返回超大/恶意响应时不再整包读入内存，超限即断流截断（bytes 记实际读到的字节数）。
    const reader = res.body?.getReader?.()
    let text = ''
    let readBytes = 0
    if (reader === undefined) {
      text = await res.text()
      readBytes = Buffer.byteLength(text)
    } else {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        readBytes += value.byteLength
        text += decoder.decode(value, { stream: true })
        if (readBytes >= maxBytes) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          break
        }
      }
      text += decoder.decode()
    }
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bytes: readBytes,
      json: safeJson(text),
      error: null,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return { ok: false, status: null, ms: Date.now() - started, bytes: 0, json: undefined, error: String(error?.message ?? error) }
  }
}

export function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* 文本 / 文件                                                         */
/* ------------------------------------------------------------------ */

/** 取尾部 n 个字符（先去 ANSI 颜色与常见控制字符）；被截断时在前面加一行说明。 */
export function tailText(text, n) {
  const s = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  if (s.length <= n) return s
  return `…[省略 ${s.length - n} 字符]…\n${s.slice(s.length - n)}`
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 原子写一个小 JSON 文件（先写临时文件再 rename，避免并发读到半个文件）。 */
export function writeJsonAtomic(file, value) {
  // 目录创建失败要响亮报出真实原因：直接忽略会让 writeFileSync
  // 以指向 tmp 文件的 ENOENT 抛错，把排查方向带偏。
  if (!ensureDir(path.dirname(file))) {
    throw new Error(`writeJsonAtomic: 无法创建目标目录 ${path.dirname(file)}`)
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    // Windows 上目标被杀软/并发读取瞬时占用时 rename 可能 EPERM/EINVAL：清掉残留的 .tmp 再把原始错误上抛，不给目录留永久垃圾。
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw error
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** deepScanConfig 默认认的「像插件配置」的键（任两个同时出现即命中）。 */
const CONFIG_KEYS = [
  'maxDepth', 'maxActiveSubagents', 'backgroundMode', 'toolName', 'allowedModels', 'provider',
]

/**
 * 在一个 loader entry（或任意对象）里找出"像插件配置"的那个对象。
 * 判据是**已知的配置键**同时出现（不是猜内部结构）：只有真正的插件行才带这些键。
 * 第三个参数 notes（可选数组）：Object.keys/values 在代理上抛错时跳过该 entry
 * 并把原因记进去——与逐键读取的容错语义一致，不让 agent_capacity 硬失败。
 */
export function deepScanConfig(root, keys = CONFIG_KEYS, notes = []) {
  let found = null
  const seen = new Set()
  const walk = (node, depth) => {
    if (found !== null || depth > 6 || node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const child of node.slice(0, 60)) walk(child, depth + 1)
      return
    }
    let own
    try {
      own = Object.keys(node)
    } catch (error) {
      notes.push(`Object.keys 抛错，跳过该 entry：${String(error?.message ?? error)}`)
      return
    }
    const hits = keys.filter((k) => own.includes(k))
    if (hits.length >= 2 || (hits.length === 1 && hits[0] === 'maxActiveSubagents')) {
      // 形状校验：'provider'/'maxDepth'/'toolName' 都是通用键，
      // 仅凭「两个列表键同时出现」会把 { provider, toolName } / { provider, maxDepth }
      // 这类无关对象（网络/扫描配置）误判成插件配置——认定前先验证数字键是有限数字、
      // toolName 是非空字符串；读取本身也可能碰到代理，整体护住，形状不对继续下钻。
      let shaped = true
      try {
        if (own.includes('maxDepth') && !(typeof node.maxDepth === 'number' && Number.isFinite(node.maxDepth))) shaped = false
        if (shaped && own.includes('maxActiveSubagents') && !(typeof node.maxActiveSubagents === 'number' && Number.isFinite(node.maxActiveSubagents))) shaped = false
        if (shaped && own.includes('toolName') && !(typeof node.toolName === 'string' && node.toolName !== '')) shaped = false
      } catch {
        shaped = false
      }
      if (shaped) {
        found = node
        return
      }
    }
    // 逐键读取必须护住：loader entry 里可能挂着 **Cordis 上下文代理**，在未 inject
    // 对应服务的上下文里读 `settings` 这类属性会直接抛
    // `cannot get property "settings" without inject`（2026-10-02 活体验收实测，
    // 曾让 agent_capacity 100% 不可用，而 stub ctx 的 selftest 完全看不到）。
    for (const key of ['config', 'options', 'configs', 'settings', 'value', 'resolved', 'current', 'components']) {
      let child
      try {
        if (!(key in node)) continue
        child = node[key]
      } catch {
        continue
      }
      walk(child, depth + 1)
    }
    let values
    try {
      values = Object.values(node)
    } catch (error) {
      notes.push(`Object.values 抛错，跳过该层展开：${String(error?.message ?? error)}`)
      return
    }
    for (const value of values) {
      if (value !== null && typeof value === 'object') walk(value, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))))
}

/** 临时目录下的一个唯一路径（只写字，不建目录）。 */
export function tempPath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`)
}

/** ISO 时间戳；clock 不可信时也只要字符串。 */
/** 把家目录/临时目录前缀替换为 `~`，避免把用户名路径送进模型可见输出。 */
export function redactHome(value) {
  let out = String(value ?? "")
  const bases = [
    [process.env.DSH_HOME, "~/.dsh"],
    [os.tmpdir(), "<tmp>"],
    [os.homedir(), "~"],
  ]
  for (const [base, repl] of bases) {
    if (typeof base !== "string" || base.length < 3) continue
    const lower = out.toLowerCase()
    const needle = base.toLowerCase()
    let i = 0
    const chunks = []
    for (;;) {
      const j = lower.indexOf(needle, i)
      if (j < 0) { chunks.push(out.slice(i)); break }
      chunks.push(out.slice(i, j), repl)
      i = j + needle.length
    }
    out = chunks.join("")
  }
  return out
}

export function nowIso() {
  return new Date().toISOString()
}
