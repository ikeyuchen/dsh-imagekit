/**
 * env_probe —— 本机能力体检（doctor 范式）
 *
 * 调研结论：flutter doctor / brew doctor 的价值不在"报告事实"，
 * 而在**每条非 ok 的结论都附一条可直接执行的修复命令**。本模块的每个 item 都遵守：
 *   { name, status: ok|missing|warn, detail, fix?, evidence }
 * fix 一律写成能在 PowerShell 里直接粘贴执行的**单行**命令。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { exclusionBlocksBind, probePorts, probeHttp, redactHome, resolveExec, runProcess, tailText } from './util.js'
import { readVram } from './vram.js'

export const CHECK_KINDS = ['interpreters', 'browsers', 'engines', 'ports', 'encoding', 'writable', 'longpaths', 'gpu', 'deps']

/** 统一构造一个 item（保证 status 三态与字段顺序稳定）。 */
function item(name, status, detail, extra = {}) {
  const out = { name, status, detail }
  if (typeof extra.fix === 'string' && extra.fix !== '') out.fix = extra.fix
  out.evidence = extra.evidence ?? {}
  return out
}

function ok(name, detail, evidence = {}, fix) {
  return item(name, 'ok', detail, { evidence, fix })
}
function missing(name, detail, fix, evidence = {}) {
  return item(name, 'missing', detail, { fix, evidence })
}
function warn(name, detail, fix, evidence = {}) {
  return item(name, 'warn', detail, { fix, evidence })
}

/* ------------------------------------------------------------------ */
/* 解释器                                                              */
/* ------------------------------------------------------------------ */

/** 异步探测一个可执行文件的版本（不再用 execFileSync 同步阻塞
 * 事件循环，且把调用方的取消信号透传给子进程——超时/中止时进程被收走而不是跑满）。 */
async function probeVersionAsync(file, args, signal, timeoutMs = 8000) {
  const result = await runProcess(file, args, { timeoutMs, signal })
  const out = String(result.stdout ?? '').trim()
  return out !== '' ? out : null
}

async function checkInterpreters(config, signal) {
  const items = []

  // node（优先 Config.nodePath，其次 PATH）
  const node = config.nodePath && fs.existsSync(config.nodePath) ? config.nodePath : resolveExec('node')
  if (node === null) {
    items.push(missing('node', '未找到 node 解释器', 'winget install OpenJS.NodeJS.LTS', { configNodePath: config.nodePath }))
  } else {
    const version = await probeVersionAsync(node, ['-v'], signal)
    items.push(ok('node', `${version ?? '未知版本'} @ ${node}`, { path: node, version }, version === null ? `重新安装或修 Config.nodePath：${node}` : undefined))
  }

  // python + 依赖（deps 检查复用这里的结果）
  const py = config.pythonPath && fs.existsSync(config.pythonPath) ? config.pythonPath : resolveExec('python')
  let pythonProbe = null
  if (py === null) {
    items.push(missing('python', '未找到 python 解释器', 'winget install Python.Python.3.12', { configPythonPath: config.pythonPath }))
  } else {
    const snippet =
      'import sys,importlib.util as u\n' +
      "print(sys.version.split()[0])\n" +
      "print('PIL', getattr(__import__('PIL'),'__version__','?') if u.find_spec('PIL') else 'MISSING')\n" +
      "print('numpy', getattr(__import__('numpy'),'__version__','?') if u.find_spec('numpy') else 'MISSING')\n" +
      "print('json', 'OK')\n"
    const result = await runProcess(py, ['-c', snippet], { timeoutMs: 25000, signal })
    const lines = String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const version = lines[0] ?? null
    const deps = {}
    for (const line of lines.slice(1)) {
      const [name, value] = line.split(/\s+/)
      if (name && value) deps[name] = value
    }
    pythonProbe = { path: py, version, deps, stderr: tailText(result.stderr ?? '', 400) }
    if (result.exitCode === 0 && version !== null) {
      const depText = Object.entries(deps)
        .map(([k, v]) => `${k} ${v === 'MISSING' ? '缺失' : v}`)
        .join(' / ')
      items.push(ok('python', `${version} @ ${py}${depText ? ` (${depText})` : ''}`, { path: py, version, deps }))
    } else {
      items.push(
        missing(
          'python',
          `执行失败（exit ${result.exitCode}）：${tailText(result.stderr ?? '', 200)}`,
          `& "${py}" -c "import sys; print(sys.version)"`,
          { path: py, stderr: tailText(result.stderr ?? '', 600) },
        ),
      )
    }
  }

  // pnpm（bundled pnpm.mjs 需要 node 拉起）
  const pnpm = config.pnpmPath && fs.existsSync(config.pnpmPath) ? config.pnpmPath : resolveExec('pnpm')
  if (pnpm === null) {
    items.push(missing('pnpm', '未找到 pnpm', 'corepack enable && corepack prepare pnpm@latest --activate', { configPnpmPath: config.pnpmPath }))
  } else {
    const runner = node !== null && pnpm.toLowerCase().endsWith('.mjs') ? { file: node, args: [pnpm, '--version'] } : { file: pnpm, args: ['--version'] }
    const result = await runProcess(runner.file, runner.args, { timeoutMs: 30000, signal })
    const version = String(result.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''
    if (result.exitCode === 0 && version !== '') items.push(ok('pnpm', `${version} @ ${pnpm}`, { path: pnpm, version }))
    else items.push(warn('pnpm', `执行失败（exit ${result.exitCode}）@ ${pnpm}`, `node "${pnpm}" --version`, { stderr: tailText(result.stderr ?? '', 400) }))
  }

  // shell / git / nvidia-smi —— 体检里高频使用的工具
  for (const [name, probe] of [
    ['pwsh', { files: ['pwsh.exe', 'powershell.exe'], args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], fix: 'winget install Microsoft.PowerShell' }],
    ['git', { files: ['git'], args: ['--version'], fix: 'winget install Git.Git' }],
    ['nvidia-smi', { files: ['nvidia-smi'], args: ['--query-gpu=name', '--format=csv,noheader'], fix: '安装/更新 NVIDIA 显卡驱动（nvlddmkm + nvidia-smi）' }],
  ]) {
    const found = resolveExec(probe.files[0], probe.files[0] === 'pwsh.exe' ? ['C:\\Program Files\\PowerShell\\7'] : []) ?? (probe.files[1] ? resolveExec(probe.files[1]) : null)
    if (found === null) {
      items.push(name === 'nvidia-smi' ? warn(name, '未找到（无独显或驱动未装）', probe.fix, {}) : missing(name, '未找到', probe.fix, {}))
    } else {
      // pwsh/git/nvidia-smi 同样走 runProcess：execVersion 的
      // execFileSync 会同步阻塞事件循环最长 20s×3 个工具，且完全无视取消信号。
      const version = await probeVersionAsync(found, probe.args, signal, 20000)
      const first = String(version ?? '').split(/\r?\n/)[0] || '可用'
      // pwsh 名下的条目如果落到 Windows PowerShell 5.1，不能报 ok —— 那不是 pwsh 7，
      // 且 5.1 对无 BOM 的 .ps1 按 ANSI 解码（中文脚本会坏）。
      if (name === 'pwsh' && /WindowsPowerShell/i.test(found)) {
        items.push(warn(name, `只找到 Windows PowerShell ${first}（不是 PowerShell 7）@ ${found}`,
          'winget install Microsoft.PowerShell（或把 pwsh 7 的绝对路径写进 Config.shellPath / Config.pwshPath）',
          { path: found, version }))
      } else {
        items.push(ok(name, `${first} @ ${found}`, { path: found, version }))
      }
    }
  }

  return { items, pythonProbe }
}

/* ------------------------------------------------------------------ */
/* 浏览器                                                              */
/* ------------------------------------------------------------------ */

function checkBrowsers(config) {
  const items = []
  // LOCALAPPDATA 存在时才拼 per-user chrome 候选：缺失（服务账户/
  // 精简环境）时 path.join('', …) 产出相对路径、existsSync 按 cwd 解析——正是下方
  // playwright 分支注释里要防的「相对路径探到 cwd 下、结论失真」，不能重蹈。
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  if (process.env.LOCALAPPDATA) {
    chromePaths.push(path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'))
  }
  const candidates = [
    ['edge', ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']],
    ['chrome', chromePaths],
    ...(config.browserPaths ?? []).map((p, i) => [`custom-${i + 1}`, [p]]),
  ]
  for (const [name, paths] of candidates) {
    const found = paths.find((p) => p && fs.existsSync(p))
    if (found === undefined) {
      items.push(warn(`browser:${name}`, '未安装', name === 'edge' ? 'winget install Microsoft.Edge' : `安装浏览器或把路径写进 Config.browserPaths`, { tried: paths }))
    } else {
      items.push(ok(`browser:${name}`, found, { path: found }))
    }
  }

  // Playwright chromium（design_shot / 视觉核验用的那份）
  // LOCALAPPDATA 缺失（服务账户/精简环境）时不能拿空串拼出相对路径硬探——
  // 相对路径会探到 cwd 下，结论失真；直接跳过该组并说明原因
  if (!process.env.LOCALAPPDATA) {
    items.push(warn(
      'playwright-chromium',
      'LOCALAPPDATA 未设置，跳过 Playwright chromium 探测',
      'npx playwright install chromium',
      {},
    ))
    return items
  }
  const pwRoot = path.join(process.env.LOCALAPPDATA, 'ms-playwright')
  let pwVersions = []
  try {
    pwVersions = fs
      .readdirSync(pwRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^chromium/.test(e.name))
      .map((e) => e.name)
  } catch {
    pwVersions = []
  }
  if (pwVersions.length === 0) {
    items.push(warn('playwright-chromium', `未在 ${pwRoot} 找到 chromium`, `npx playwright install chromium`, { root: pwRoot }))
  } else {
    let exe = null
    // 新版 Playwright 的布局：chrome-win64\chrome.exe / chrome-headless-shell-win64\
    // （旧的 chrome-win\ 也一并兼容；2026-10-02 实测本机是 chrome-win64）
    const relCandidates = [
      'chrome-win64\\chrome.exe',
      'chrome-win\\chrome.exe',
      'chrome-headless-shell-win64\\chrome-headless-shell.exe',
      'chrome-win\\headless_shell.exe',
    ]
    for (const dir of pwVersions) {
      for (const rel of relCandidates) {
        const candidate = path.join(pwRoot, dir, rel)
        if (fs.existsSync(candidate)) {
          exe = candidate
          break
        }
      }
      if (exe !== null) break
    }
    if (exe === null) items.push(warn('playwright-chromium', `目录存在但未找到可执行文件：${pwVersions.join(', ')}`, `npx playwright install chromium`, { root: pwRoot }))
    else items.push(ok('playwright-chromium', exe, { root: pwRoot, versions: pwVersions, path: exe }))
  }

  return items
}

/* ------------------------------------------------------------------ */
/* 引擎 / 端口                                                          */
/* ------------------------------------------------------------------ */

async function checkEngines(config, signal) {
  // 并行探测：probeHttp 只在调用方 abort 时抛错（util.js 的取消语义），Promise.all 安全；
  // 串行 await 会把 N 个 4s 超时叠成 4N s
  const probed = await Promise.all((config.engines ?? []).map(async (engine) => {
    let probe
    try {
      probe = await probeHttp(engine.url, { timeoutMs: 4000, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      probe = { ok: false, status: null, ms: 0, error: String(error?.message ?? error) }
    }
    return { engine, probe }
  }))
  const items = []
  for (const { engine, probe } of probed) {
    if (probe.ok) {
      items.push(ok(
        `engine:${engine.name}`,
        `HTTP ${probe.status} (${probe.ms}ms) @ ${engine.url}`,
        { url: engine.url, status: probe.status, ms: probe.ms },
      ))
    } else {
      items.push(
        item(
          `engine:${engine.name}`,
          'warn',
          probe.error ? `不可达：${probe.error}` : `HTTP ${probe.status ?? '无响应'} @ ${engine.url}`,
          {
            fix: engine.fix ?? `先启动 ${engine.name}（${engine.url}）`,
            evidence: {
              url: engine.url, status: probe.status, ms: probe.ms, error: probe.error ?? null,
            },
          },
        ),
      )
    }
  }
  return items
}

function checkPorts(config, ports) {
  // 端口值先过数字化校验：Config.enginePorts 里出现 '8188-8190'、
  // 空串等非数字时 Number() 产出 NaN，probePorts 查不到条目会报出「port:NaN 未监听」
  // 及误导性 fix——正整数且 ≤65535 才产出探测行（与 probeEnvironment 对 paths 的过滤对齐）。
  const wanted = (ports.length > 0 ? ports : (config.enginePorts ?? []))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
  const rows = probePorts(wanted)
  return rows.map((row) => {
    if (row.status === 'listening') {
      return ok(`port:${row.port}`, `监听中（pid ${row.pid}${row.owner ? ` ${row.owner}` : ''}）`, row)
    }
    // 动态预留段里："未监听"只是表象，真因是系统不许绑——fix 不能写"先启动它"（必失败）
    if (exclusionBlocksBind(row.excluded)) {
      return warn(
        `port:${row.port}`,
        `未监听，且落在 Windows **动态预留**段 ${row.excluded.start}-${row.excluded.end} 内（Hyper-V/WSL 占着，普通进程绑定必报 WinError 10013）`,
        // fix 必须整条可直接粘贴执行：`#` 开启行内注释，可执行命令
        // 放它前面、说明文字放最后，否则 net stop/net start 整段被注释吞掉。
        'net stop winnat ; netsh int ipv4 set dynamic tcp start=49152 num=16384 ; net start winnat  # 需管理员；先用 netsh int ipv4 show excludedportrange protocol=tcp 确认',
        row,
      )
    }
    // 管理员保留段（带 `*`）：作用是把端口从动态分配器手里保护下来，**不影响绑定**
    // （实测对照：本机 8188/8189 就在 `8188 8189 *` 段内，两个引擎都正常监听）
    if (row.excluded) {
      return warn(
        `port:${row.port}`,
        `未监听（端口在管理员保留段 ${row.excluded.start}-${row.excluded.end} 内，Hyper-V/WSL 不会抢它；保留段**不影响绑定**）`,
        `Test-NetConnection 127.0.0.1 -Port ${row.port}  # 正常启动该服务即可`,
        row,
      )
    }
    return warn(
      `port:${row.port}`,
      '未监听',
      `Test-NetConnection 127.0.0.1 -Port ${row.port}  # 若应有服务：先启动它`,
      row,
    )
  })
}

/* ------------------------------------------------------------------ */
/* 编码 / 可写 / 长路径                                                  */
/* ------------------------------------------------------------------ */

function checkEncoding() {
  const items = []
  const cp = (() => {
    try {
      // 注意：`chcp` 的输出是**本地化**的（中文系统上是 GBK 的"活动代码页: 936"），
      // 按 UTF-8 解码必然是乱码。代码页数字本身是 ASCII，所以只取数字、不引用任何
      // 本地化文本 —— 否则一个专测编码的条目自己的 detail 就是乱码（2026-10-02 实测）。
      const raw = execFileSync('chcp', { encoding: 'utf8', timeout: 8000, windowsHide: true, shell: true })
      return String(raw).match(/(\d{3,5})/)?.[1] ?? ''
    } catch {
      return ''
    }
  })()
  const utf8 = cp === '65001'
  items.push(
    utf8
      ? ok('encoding:codepage', `代码页 ${cp}（UTF-8）`, { chcp: cp })
      : item('encoding:codepage', 'warn', `控制台代码页 ${cp || '未知'}（非 65001；中文路径/引号命令易出现坏字符）`, {
          fix: 'chcp 65001 > $null',
          evidence: { chcp: cp || null },
        }),
  )

  // 真实往返测试：让解释器写一个中文名文件再读回（这是失败证据本身，不是推测）
  const dir = os.tmpdir()
  const name = `guard-编码-${Date.now().toString(36)}-中文.txt`
  const file = path.join(dir, name)
  let okRoundTrip = false
  let detail = ''
  try {
    fs.writeFileSync(file, '中文内容', 'utf8')
    const back = fs.readFileSync(file, 'utf8')
    const listed = fs.readdirSync(dir).includes(name)
    okRoundTrip = back === '中文内容' && listed
    detail = listed ? '文件名与内容往返一致' : '目录列举未返回同名文件'
  } catch (error) {
    detail = String(error?.message ?? error)
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
  items.push(
    okRoundTrip
      ? ok('encoding:utf8-roundtrip', `中文路径可写可读（${redactHome(dir)}）`, { file: redactHome(file), detail })
      : item('encoding:utf8-roundtrip', 'warn', `中文路径往返失败：${detail}`, {
          // 指引而不是注册表命令：HKCU LocaleName 并不改 ACP，系统级 UTF-8 是
          // Windows「区域设置 → Beta: 使用 Unicode UTF-8」的开关（改系统区域，需重启）
          fix: '在 Windows 设置 → 时间和语言 → 语言和区域 → 管理语言设置 → 更改系统区域设置 里勾选' +
            '「Beta 版: 使用 Unicode UTF-8 提供全球语言支持」（需重启）；会话内可先 chcp 65001',
          evidence: { file: redactHome(file), detail },
        }),
  )
  return items
}

function checkWritable(config, paths) {
  const items = []
  const targets = [config.dataDir, ...paths].filter((p) => typeof p === 'string' && p !== '')
  for (const target of targets) {
    const probe = path.join(target, `.guard-write-test-${process.pid}.tmp`)
    let writeError = null
    try {
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(probe, 'ok', 'utf8')
    } catch (error) {
      writeError = error
    }
    // 判定与清理分离：临时文件被杀软/索引器短暂锁住时 unlink 抛
    // EPERM，但写入其实已成功——不能误报不可写，也不能让 unlink 的报错顶替真实原因；
    // 清理单独吞错（残留一个 .tmp 可接受）。
    if (writeError === null) {
      try {
        fs.unlinkSync(probe)
      } catch {
        /* ignore */
      }
      items.push(ok(`writable:${redactHome(target)}`, '可写', { path: redactHome(target) }))
    } else {
      items.push(item(`writable:${redactHome(target)}`, 'missing', String(writeError?.message ?? writeError), { fix: `New-Item -ItemType Directory -Force "${redactHome(target)}"`, evidence: { path: redactHome(target) } }))
    }
  }
  return items
}

function checkLongPaths() {
  const items = []
  let enabled = null
  let raw = ''
  try {
    raw = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    )
    const m = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(raw)
    enabled = m ? Number.parseInt(m[1], 16) === 1 : null
  } catch {
    enabled = null
  }
  const fix = 'New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force'
  if (enabled === true) items.push(ok('longpaths', '长路径已启用（LongPathsEnabled=1）', { raw: raw.trim() }))
  else if (enabled === false) items.push(item('longpaths', 'warn', '长路径未启用（>260 字符路径会失败）', { fix, evidence: { raw: raw.trim() } }))
  else items.push(item('longpaths', 'warn', '无法读注册表确认长路径状态', { fix, evidence: { raw: raw.trim() } }))

  // 真实深路径往返（>260 字符），这是"会不会真的失败"的直接证据
  const deepRoot = path.join(os.tmpdir(), `guard-longpath-${Date.now().toString(36)}`)
  let deepOk = false
  let deepDetail = ''
  try {
    const deep = path.join(deepRoot, 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80))
    fs.mkdirSync(deep, { recursive: true })
    const file = path.join(deep, 'deep.txt')
    fs.writeFileSync(file, 'deep', 'utf8')
    deepOk = fs.readFileSync(file, 'utf8') === 'deep'
    deepDetail = `路径长度 ${file.length}`
  } catch (error) {
    deepDetail = String(error?.message ?? error)
  } finally {
    try {
      fs.rmSync(deepRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  items.push(
    deepOk
      ? ok('longpaths:deep-write', `>260 字符路径可写（${deepDetail}）`, { detail: deepDetail })
      : item('longpaths:deep-write', 'warn', `深路径写入失败：${deepDetail}`, { fix, evidence: { detail: deepDetail } }),
  )
  return items
}

/* ------------------------------------------------------------------ */
/* GPU / 依赖                                                          */
/* ------------------------------------------------------------------ */

function checkGpu(config) {
  const items = []
  const { vram, source, evidence } = readVram(config)
  if (vram === null) {
    items.push(warn('gpu', '读不到 GPU（perfmon 数据与 nvidia-smi 都不可用）', 'nvidia-smi', evidence))
    return items
  }
  const parts = [
    vram.name ?? 'GPU',
    `专用 ${vram.usedMiB}/${vram.totalMiB} MiB（余 ${vram.freeMiB}）`,
    vram.sharedMiB !== null ? `共享 ${vram.sharedMiB} MiB` : null,
    `来源 ${source}`,
    vram.ageSec !== null && vram.ageSec > 120 ? `样本 ${vram.ageSec}s 前` : null,
  ].filter(Boolean)
  const spill = Number.isFinite(vram.sharedMiB) && vram.sharedMiB >= 512
  if (spill) {
    items.push(
      item('gpu', 'warn', `${parts.join(' / ')} —— 共享显存已占用（显存溢出会静默变慢 10-50x）`, {
        fix: '先跑 perf(action=snapshot) 找到 nonLocalMiB > 0 的进程，或运行 comfy(action=control, op=free) 释放显存',
        evidence: { ...evidence, vram },
      }),
    )
  } else {
    items.push(ok('gpu', parts.join(' / '), { ...evidence, vram }))
  }
  return items
}

function checkDeps(config, pythonProbe) {
  const items = []
  const deps = pythonProbe?.deps ?? {}
  const py = pythonProbe?.path ?? config.pythonPath
  if (pythonProbe === null) {
    // python 缺失时 config.pythonPath 多半也是 undefined——不能拼出 `& "undefined"`
    // 这种粘贴即报错的 fix：路径不存在时回退 winget 安装指引，
    // 与 checkInterpreters 里 python missing 条目保持一致。
    items.push(warn('deps', 'python 不可用，无法确认 PIL/numpy',
      config.pythonPath && fs.existsSync(config.pythonPath)
        ? `& "${config.pythonPath}" -m pip install Pillow numpy`
        : 'winget install Python.Python.3.12', {}))
    return items
  }
  for (const [mod, pkg] of [
    ['PIL', 'Pillow'],
    ['numpy', 'numpy'],
  ]) {
    const value = deps[mod]
    if (value === undefined) items.push(warn(`deps:${mod}`, '未在探测输出中出现', `& "${py}" -m pip install ${pkg}`, { deps }))
    else if (value === 'MISSING') items.push(missing(`deps:${mod}`, `${pkg} 未安装 @ ${py}`, `& "${py}" -m pip install ${pkg}`, { deps }))
    else items.push(ok(`deps:${mod}`, `${pkg} ${value}`, { python: py, version: value }))
  }
  return items
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/** 归一化 checks 入参（去重、只保留已知种类、缺省 = 全部）。 */
export function normalizeKinds(checks) {
  const list = Array.isArray(checks) ? checks.map((c) => String(c)) : []
  if (list.length === 0) return CHECK_KINDS // 缺省 = 全部
  // 全未知时返回空数组：旧行为静默扩展成全部九类，一次笔误
  // （'ports' 写成 'port'）就触发全量体检（大量子进程、耗时数倍），且让
  // probeEnvironment 的「未知种类」告警分支永远不可达——现在交给兜底把笔误报出来。
  return [...new Set(list.filter((c) => CHECK_KINDS.includes(c)))]
}

/**
 * 跑一次体检。
 * @returns {Promise<{items: object[], summary: object}>}
 */
export async function probeEnvironment({ config, checks, paths = [], signal }) {
  const kinds = normalizeKinds(checks)
  const wants = (k) => kinds.includes(k)
  const items = []
  let pythonProbe = null

  if (wants('interpreters') || wants('deps')) {
    const r = await checkInterpreters(config, signal)
    pythonProbe = r.pythonProbe
    if (wants('interpreters')) items.push(...r.items)
  }
  if (wants('browsers')) items.push(...checkBrowsers(config))
  if (wants('engines')) items.push(...(await checkEngines(config, signal)))
  if (wants('ports')) items.push(...checkPorts(config, paths.filter((p) => /^\d+$/.test(String(p)))))
  if (wants('encoding')) items.push(...checkEncoding())
  if (wants('writable')) items.push(...checkWritable(config, paths.filter((p) => !/^\d+$/.test(String(p)))))
  if (wants('longpaths')) items.push(...checkLongPaths())
  if (wants('gpu')) items.push(...checkGpu(config))
  if (wants('deps')) items.push(...checkDeps(config, pythonProbe))

  // 空 items 的兜底必须发生在 summary 之前：否则 total=0 + verdict=healthy 会把
  // 「其实什么都没检查」伪装成「一切健康」，且插入的告警行不参与排序与计数
  if (items.length === 0) {
    const requested = Array.isArray(checks) ? checks.map((c) => String(c)) : []
    const unknown = requested.filter((c) => !CHECK_KINDS.includes(c))
    if (unknown.length > 0) {
      items.push(warn(
        'env_probe',
        `未知的检查种类：${unknown.join(', ')}`,
        `把 checks 写成这些之一：${CHECK_KINDS.join(' | ')}`,
        { requested },
      ))
    } else {
      // 种类有效但零目标：如实说明原因，而不是误报"未知种类"
      items.push(
        warn(
          'env_probe',
          '检查种类有效，但没有可检查的目标（如 enginePorts/engines 为空且没有传 paths）',
          '把要探测的端口/路径写进 paths，或在 Config.enginePorts / Config.engines 里配置目标',
          { requested },
        ),
      )
    }
  }

  // 非 ok 的条目按 missing > warn 排序，方便一眼看到必须修的东西
  const rank = { missing: 0, warn: 1, ok: 2 }
  items.sort((a, b) => {
    const byStatus = (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
    if (byStatus !== 0) return byStatus
    // 标准三态：同名条目必须返回 0（旧写法 a<b?-1:1 对 a===b 恒返回 1，不自反）
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })

  // 嵌套三元拆成 if/else：verdict 的推导一读就懂
  let verdict = 'healthy'
  if (items.some((i) => i.status === 'missing')) verdict = 'broken'
  else if (items.some((i) => i.status === 'warn')) verdict = 'degraded'

  const summary = {
    checks: kinds,
    total: items.length,
    ok: items.filter((i) => i.status === 'ok').length,
    warn: items.filter((i) => i.status === 'warn').length,
    missing: items.filter((i) => i.status === 'missing').length,
    fixes: items.filter((i) => typeof i.fix === 'string' && i.fix !== '').length,
    verdict,
  }
  return { items, summary }
}
