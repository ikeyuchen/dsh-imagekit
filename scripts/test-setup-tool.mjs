#!/usr/bin/env node
/**
 * image_setup 工具集成自测（离线，不联网、不启动宿主）。
 *
 *   npm install   # 宿主侧 peer 依赖已钉在 devDependencies
 *   node scripts/test-setup-tool.mjs
 *
 * 用真实 models.manifest.json 与临时目录，覆盖：
 *   status 版本字段 / defaults / 旧版本备份出现在 status / delete backup=<id> /
 *   upgrade 同版本跳过 / 升级下载失败自动回滚（模型单文件 + 引擎/放大整目录）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'models.manifest.json'), 'utf8')).components.engine.packs.default.version
const { backupTargets, listBackups, pickUrl, registerSetupTools } = await import(new URL('../lib/setup.js', import.meta.url).href)

const root = mkdtempSync(path.join(tmpdir(), 'imagekit-tool-'))
const layout = {
  installRoot: root,
  engineRoot: path.join(root, 'engine', 'ComfyUI_windows_portable'),
  modelsRoot: path.join(root, 'models'),
  upscaleRoot: path.join(root, 'upscale-engines', 'engines'),
  stateDir: path.join(root, '.imagekit'),
}
const config = {
  installRoot: root,
  modelsRoot: layout.modelsRoot,
  engineRoot: layout.engineRoot,
  upscaleEnginesRoot: layout.upscaleRoot,
  modelSource: 'custom',
  modelPackBaseUrl: 'http://127.0.0.1:1/mirror',
  keepVersions: '1',
}

const fail = (message) => {
  console.error('✗ ' + message)
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
const assert = (condition, message) => {
  if (!condition) fail(message)
}
const readStateFile = () => JSON.parse(readFileSync(path.join(layout.stateDir, 'state.json'), 'utf8'))

const registered = []
/** 假的 comfy 引擎工具：记录 setup 升级时对引擎的停/起调用。 */
let comfyTool = null
registerSetupTools(
  {
    tools: {
      register: (tool) => registered.push(tool),
      get: (name) => (name === 'comfy' ? comfyTool ?? undefined : undefined),
    },
    effect: () => {},
    inject: undefined,
  },
  { pluginRoot: ROOT, config }
)
const tool = registered[0]
assert(typeof tool?.execute === 'function', 'image_setup tool was not registered')

const call = (args) => tool.execute(args, {})

// 测试夹具：引擎版本文件 / 引擎 checkPath / 三个模型文件 / 放大引擎 checkPath
try {
  mkdirSync(path.join(layout.engineRoot, 'ComfyUI'), { recursive: true })
  writeFileSync(path.join(layout.engineRoot, 'ComfyUI', 'comfyui_version.py'), '__version__ = "0.39.0"\n')
  writeFileSync(path.join(layout.engineRoot, 'ComfyUI', 'main.py'), '# main\n')

  const modelDir = path.join(layout.modelsRoot, 'diffusion_models')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(path.join(layout.modelsRoot, 'vae'), { recursive: true })
  mkdirSync(path.join(layout.modelsRoot, 'text_encoders'), { recursive: true })
  const modelA = path.join(modelDir, 'qwen_image_2.1_int8_convrot.safetensors')
  writeFileSync(modelA, Buffer.alloc(16))
  writeFileSync(path.join(layout.modelsRoot, 'vae', 'qwen_image_2.1_vae_bf16.safetensors'), Buffer.alloc(16))
  writeFileSync(path.join(layout.modelsRoot, 'text_encoders', 'qwen3vl_8b_int8_convrot.safetensors'), Buffer.alloc(16))

  // 放大引擎夹具：四包的上游官方 exe + 一个模型文件（对应新清单的 checkPaths）
  const upscaleFixtures = [
    ['realcugan-ncnn-vulkan', 'realcugan-ncnn-vulkan.exe', ['models-se', 'up2x-denoise1x.param']],
    ['waifu2x-ncnn-vulkan', 'waifu2x-ncnn-vulkan.exe', ['models-upconv_7_anime_style_art_rgb', 'noise0_scale2.0x_model.param']],
    ['realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe', ['models', 'realesrgan-x4plus.param']],
    ['realsr-ncnn-vulkan', 'realsr-ncnn-vulkan.exe', ['models-DF2K', 'x4.param']],
  ]
  for (const [dir, exe, [modelDir, modelFile]] of upscaleFixtures) {
    mkdirSync(path.join(layout.upscaleRoot, dir, modelDir), { recursive: true })
    writeFileSync(path.join(layout.upscaleRoot, dir, exe), 'stub')
    writeFileSync(path.join(layout.upscaleRoot, dir, modelDir, modelFile), 'stub')
  }

  // 1. status：版本字段齐全，引擎版本来自 comfyui_version.py
  const status = await call({ action: 'status' })
  assert(status.ok && status.components.length === 3, 'status should return 3 components')
  let latestStatus = status
  const row = (name) => latestStatus.components.find((item) => item.component === name)
  assert(row('engine').targetVersion === ENGINE_VERSION, 'engine targetVersion should match manifest')
  assert(row('engine').installedVersion === '0.39.0', 'engine installedVersion should come from comfyui_version.py')
  assert(row('models').targetVersion === '2.1', 'models targetVersion should be 2.1')
  assert(row('models').missing === 0, 'models should report no missing manifest files')
  assert(row('upscale').targetVersion === '20220728+20250915+20220424', `upscale targetVersion should match manifest, got ${row('upscale').targetVersion}`)
  // 首次 status 应把探测版本落盘（adopted）：引擎必须记磁盘真实版本（0.39.0），
  // 不能记成清单目标（0.44.0）——记错就会让「已安装 0.39.0 + 清单 0.44.0」永远显示可升级又升不动。
  assert(readStateFile().installed.engine.version === '0.39.0', 'engine version should adopt the detected on-disk version')
  assert(row('engine').updateAvailable === true, 'installed 0.39.0 vs manifest target should be upgradeable')
  assert(readStateFile().installed.models.version === '2.1', 'models version was not adopted')
  latestStatus = await call({ action: 'status' })
  assert(row('models').versionSource === 'recorded', 'adopted version not used on next status')
  console.log('✓ status exposes target/installed versions and adopts them once')

  // 1b. 模型 pack 是叠加关系：core 已装，fast/lowvram/lowvram-fast/full 各自报缺失
  const packs = Object.fromEntries((row('models').packs ?? []).map((pack) => [pack.name, pack]))
  assert(packs.core?.installed === true, 'core pack should be installed')
  assert(packs.fast?.missing === 1 && packs.fast.missingBytes > 0, 'fast should miss the turbo model')
  assert(packs.lowvram?.missing === 1, 'lowvram should miss the w4a8 encoder')
  assert(packs['lowvram-fast']?.missing === 2, 'lowvram-fast should miss turbo + w4a8')
  assert(packs.full?.missing === 4, `full should miss 4 files, got ${packs.full?.missing}`)
  console.log('✓ models expose additive packs (core/fast/lowvram/lowvram-fast/full)')

  // 1c. 下载源优先级：official 缺位时自动退到自建 mirror；用户显式选官方源时不越级
  const sourced = {
    path: 'archives/x.zip',
    kind: 'upscale',
    sources: { official: 'https://github.com/up/stream/releases/download/t/x.zip', mirror: 'https://github.com/us/mirror/releases/download/t/x.zip' },
  }
  assert(
    pickUrl(sourced, { upscaleSource: 'official' }) === sourced.sources.official,
    'official source should win when the user picked it'
  )
  assert(
    pickUrl({ path: 'archives/x.zip', kind: 'upscale', sources: { mirror: 'https://m/x.zip' } }, { upscaleSource: 'official' }) === 'https://m/x.zip',
    'mirror slot should be used when the preferred source is absent'
  )
  assert(pickUrl(sourced, { modelPackBaseUrl: 'https://base/' }) === 'https://base/archives/x.zip', 'custom base URL should win')
  console.log('✓ download source fallback: official → self-hosted mirror → custom base URL')

  // 2. defaults 只读
  const defaults = await call({ action: 'defaults' })
  assert(defaults.ok && typeof defaults.defaults.installRoot === 'string', 'defaults action failed')
  console.log('✓ defaults action')

  // 3. 旧版本备份出现在 status，可通过 delete backup=<id> 删除
  //    用一整个一次性目录做夹具，避免删除动作把真实夹具文件也带走。
  const disposable = path.join(layout.upscaleRoot, 'old-version-fixture')
  mkdirSync(disposable, { recursive: true })
  writeFileSync(path.join(disposable, 'README.txt'), 'old\n')
  const oldBackup = backupTargets(layout, 'upscale', [disposable], { version: '2020.01', pack: 'core' })
  assert(oldBackup !== null, 'upscale backup fixture failed')
  const statusWithBackup = await call({ action: 'status' })
  latestStatus = statusWithBackup
  assert(row('upscale').backups.length === 1, 'status did not list the upscale backup')
  assert(row('upscale').backups[0].id === oldBackup.id, 'status backup id mismatch')
  const removed = await call({ action: 'delete', component: 'upscale', confirm: 'upscale', backup: oldBackup.id })
  assert(removed.ok, `delete backup failed: ${removed.message}`)
  assert(listBackups(layout, 'upscale').length === 0, 'backup still on disk after delete')
  assert(existsSync(layout.engineRoot), 'engine fixture should be untouched')
  const badId = await call({ action: 'delete', component: 'upscale', confirm: 'upscale', backup: '..' })
  assert(badId.ok === false, 'delete accepted unsafe backup id')
  console.log('✓ status lists old versions; delete backup=<id> removes them')

  // 4. upgrade 同版本跳过（不联网）
  mkdirSync(layout.stateDir, { recursive: true })
  writeFileSync(
    path.join(layout.stateDir, 'state.json'),
    JSON.stringify({ installed: { models: { version: '2.1', pack: 'core' } } }, null, 2)
  )
  const skipped = await call({ action: 'upgrade', component: 'models', pack: 'core' })
  assert(skipped.ok && /already at v2\.1/.test(skipped.message), `upgrade skip failed: ${skipped.message}`)
  console.log('✓ upgrade skips when already at manifest version')

  // 5. 升级下载失败：先备份 → 失败 → 自动回滚（文件与 state 均保持原样）
  writeFileSync(modelA, Buffer.alloc(16, 9))
  writeFileSync(
    path.join(layout.stateDir, 'state.json'),
    JSON.stringify({ installed: { models: { version: '2.0', pack: 'core' } } }, null, 2)
  )
  let failure = null
  try {
    await call({ action: 'upgrade', component: 'models', pack: 'core' })
  } catch (error) {
    failure = error
  }
  assert(failure !== null, 'upgrade with unreachable mirror should fail')
  assert(/rolled back/.test(String(failure.message)), `rollback note missing: ${failure.message}`)
  assert(existsSync(modelA) && statSync(modelA).size === 16, 'rolled-back model file missing or wrong size')
  assert(listBackups(layout, 'models').length === 0, 'rollback left a backup behind')
  assert(readStateFile().installed.models.version === '2.0', 'rollback changed the recorded version')
  console.log('✓ failed upgrade rolls back file + keeps recorded version')

  // 5b. 按包删除：装错一个 12G 包不该逼用户全删；只删独有文件，共用文件留给仍安装的包
  //     core 与 lowvram 共用 diffusion+vae，文本编码器不同（int8 vs w4a8）
  const w4a8 = path.join(layout.modelsRoot, 'text_encoders', 'qwen3vl_8b_w4a8.safetensors')
  writeFileSync(w4a8, Buffer.alloc(16))
  const packedBefore = await call({ action: 'status' })
  const packsBefore = Object.fromEntries(packedBefore.components.find((c) => c.component === 'models').packs.map((x) => [x.name, x]))
  assert(packsBefore.core?.installed === true && packsBefore.lowvram?.installed === true, 'core+lowvram fixture should both be installed')

  const packDeleted = await call({ action: 'delete', component: 'models', pack: 'core', confirm: 'models' })
  assert(packDeleted.ok, `pack delete failed: ${packDeleted.message}`)
  assert(!existsSync(path.join(layout.modelsRoot, 'text_encoders', 'qwen3vl_8b_int8_convrot.safetensors')), 'core-only file should be deleted')
  assert(existsSync(path.join(layout.modelsRoot, 'diffusion_models', 'qwen_image_2.1_int8_convrot.safetensors')), 'diffusion shared with lowvram must be kept')
  assert(existsSync(w4a8), 'lowvram-only file must be kept')
  assert(/kept 2 file\(s\) shared with installed packs lowvram/.test(packDeleted.message), `shared-file note missing: ${packDeleted.message}`)
  const packedAfter = await call({ action: 'status' })
  const packsAfter = Object.fromEntries(packedAfter.components.find((c) => c.component === 'models').packs.map((x) => [x.name, x]))
  assert(packsAfter.core?.installed === false && packsAfter.lowvram?.installed === true, 'pack status should follow disk after delete')

  // 只剩一个包时，删它应把独有+共用全部清掉
  rmSync(w4a8, { force: true })
  const solo = await call({ action: 'delete', component: 'models', pack: 'core', confirm: 'models' })
  assert(solo.ok, `solo pack delete failed: ${solo.message}`)
  assert(!existsSync(path.join(layout.modelsRoot, 'diffusion_models', 'qwen_image_2.1_int8_convrot.safetensors')), 'solo pack delete should remove shared files too')

  // 边界：未知包 / pack 用在非 models 组件
  const unknownPack = await call({ action: 'delete', component: 'models', pack: 'nope', confirm: 'models' })
  assert(unknownPack.ok === false && /unknown pack/.test(unknownPack.message), 'unknown pack should be refused by name')
  const wrongComponent = await call({ action: 'delete', component: 'engine', pack: 'core', confirm: 'engine' })
  assert(wrongComponent.ok === false && /only applies to component=models/.test(wrongComponent.message), 'pack on non-models component should be refused')
  console.log('✓ delete pack=<name> removes only that pack\'s exclusive files, keeps files still needed')

  // 5c. 多包组件必须显式指定 pack（避免 8G 显卡默默下 12G 的 core）；单包组件仍可省略
  const noPack = await call({ action: 'install', component: 'models' })
  assert(noPack.ok === false && /requires pack=<name>/.test(noPack.message), `models without pack should be refused: ${noPack.message}`)
  assert(/core（12G 显存/.test(noPack.message) && /lowvram（8G 显存/.test(noPack.message), `refusal should list packs: ${noPack.message}`)
  // 单包组件（upscale）允许省略 pack：这里故意指向不可达源，只为确认它不会报「requires pack」
  let upscaleNoPack
  try {
    upscaleNoPack = await call({ action: 'install', component: 'upscale', pack: 'core' })
  } catch (error) {
    upscaleNoPack = { ok: false, message: String(error?.message ?? error) }
  }
  assert(!/requires pack=<name>/.test(upscaleNoPack.message), 'single-pack component should not demand a pack')
  console.log('✓ models install/upgrade requires an explicit pack; single-pack components do not')

  // 5d. 下载进度：字节级 progress 写进 job.json，status 暴露 percent / 已下载 / 当前文件
  const { createServer: progCreateServer } = await import('node:http')
  const { createHash: progCreateHash } = await import('node:crypto')
  const progPayload = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < progPayload.length; i += 1) progPayload[i] = i % 251
  const progSha = progCreateHash('sha256').update(progPayload).digest('hex')
  const progServer = progCreateServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
    const start = m ? Number(m[1]) : 0
    const slice = progPayload.subarray(start)
    res.writeHead(start > 0 ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(slice.length),
      ...(start > 0 ? { 'content-range': `bytes ${start}-${progPayload.length - 1}/${progPayload.length}` } : {}),
    })
    // 分 4 块慢发，制造可观测的中间进度
    let offset = 0
    const step = 256 * 1024
    const timer = setInterval(() => {
      if (offset >= slice.length) { clearInterval(timer); res.end(); return }
      res.write(slice.subarray(offset, offset + step))
      offset += step
    }, 120)
    req.on('close', () => clearInterval(timer))
  })
  await new Promise((resolve) => progServer.listen(0, '127.0.0.1', resolve))
  const progRoot = path.join(root, 'progress-plugin')
  const progInstall = path.join(root, 'progress-install')
  mkdirSync(path.join(progInstall, '.imagekit'), { recursive: true })
  mkdirSync(progRoot, { recursive: true })
  writeFileSync(path.join(progRoot, 'models.manifest.json'), JSON.stringify({
    manifestVersion: 1,
    components: {
      models: {
        label: 'models',
        packs: {
          prog: {
            label: 'progress fixture', version: '9.9', vram: '8G',
            files: [{
              label: 'progress model', path: 'diffusion_models/progress.safetensors',
              sources: { huggingface: `http://127.0.0.1:${progServer.address().port}/progress.safetensors` },
              sizeBytes: progPayload.length, sha256: progSha,
            }],
          },
        },
      },
    },
  }, null, 2))
  const progTools = []
  registerSetupTools(
    { tools: { register: (t) => progTools.push(t), get: () => undefined }, effect: () => {}, inject: undefined },
    {
      pluginRoot: progRoot,
      config: {
        installRoot: progInstall,
        modelsRoot: path.join(progInstall, 'models'),
        engineRoot: path.join(progInstall, 'engine', 'ComfyUI_windows_portable'),
        upscaleEnginesRoot: path.join(progInstall, 'upscale-engines', 'engines'),
        modelSource: 'huggingface',
        keepVersions: '1',
      },
    }
  )
  const progTool = progTools[0]
  const progJobFile = path.join(progInstall, '.imagekit', 'job.json')
  const installPromise = progTool.execute({ action: 'install', component: 'models', pack: 'prog' }, {})
  const samples = []
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 80))
    if (!existsSync(progJobFile)) continue
    const raw = JSON.parse(readFileSync(progJobFile, 'utf8'))
    const status = await progTool.execute({ action: 'status' }, {})
    samples.push({ job: status.job ?? raw, raw })
    if (status.job?.state === 'done') break
  }
  await installPromise
  const percents = samples.map((s) => s.job?.percent).filter((v) => Number.isFinite(v))
  const midProgress = percents.filter((p) => p > 0 && p < 100)
  assert(midProgress.length > 0, `download progress never showed an intermediate percent: ${percents.join(',')}`)
  assert(percents.every((p, i) => i === 0 || p >= percents[i - 1]), `progress went backwards: ${percents.join(',')}`)
  assert(percents[percents.length - 1] === 100, `final percent should be 100, got ${percents[percents.length - 1]}`)
  const withBytes = samples.find((s) => Number(s.job?.writtenBytes) > 0 && Number(s.job?.totalBytes) === progPayload.length)
  assert(withBytes !== undefined, 'job should carry writtenBytes/totalBytes')
  const withFile = samples.find((s) => s.job?.fileLabel === 'progress model')
  assert(withFile !== undefined, 'job should name the file being downloaded')
  assert(samples[samples.length - 1].job?.state === 'done', 'job should end in state=done')
  console.log('✓ download progress: byte-level percent grows monotonically and ends at 100%')

  // 5e. 新用户首装：installRoot 还不存在时，目录/状态文件应自动创建（不需要用户先建目录）
  const freshRoot = path.join(root, 'fresh-user', 'nested', 'ImageKit')
  assert(!existsSync(freshRoot), 'fresh fixture should not exist yet')
  const freshTools = []
  registerSetupTools(
    { tools: { register: (t) => freshTools.push(t), get: () => undefined }, effect: () => {}, inject: undefined },
    {
      pluginRoot: progRoot,
      config: {
        installRoot: freshRoot,
        modelsRoot: path.join(freshRoot, 'models'),
        engineRoot: path.join(freshRoot, 'engine', 'ComfyUI_windows_portable'),
        upscaleEnginesRoot: path.join(freshRoot, 'upscale-engines', 'engines'),
        modelSource: 'huggingface',
        keepVersions: '1',
      },
    }
  )
  const freshInstall = await freshTools[0].execute({ action: 'install', component: 'models', pack: 'prog' }, {})
  assert(freshInstall.ok, `fresh install failed: ${freshInstall.message}`)
  assert(existsSync(path.join(freshRoot, 'models', 'diffusion_models', 'progress.safetensors')), 'fresh install did not create the model directory')
  assert(existsSync(path.join(freshRoot, '.imagekit', 'job.json')), 'fresh install did not write the job progress file')
  assert(existsSync(path.join(freshRoot, '.imagekit', 'state.json')), 'fresh install did not create the state file')
  const freshStatus = await freshTools[0].execute({ action: 'status' }, {})
  assert(freshStatus.ok && freshStatus.components.find((c) => c.component === 'models').installed, 'fresh install should report installed')
  console.log('✓ first install into a non-existent installRoot creates every directory it needs')
  progServer.closeAllConnections?.()
  progServer.close()

  // 6. 目录级回滚：engine 整目录、upscale 已解压目录
  const statePath = path.join(layout.stateDir, 'state.json')
  const state = readStateFile()
  state.installed.engine = { version: '0.38.0', pack: 'default' }
  state.installed.upscale = { version: '2020.01', pack: 'core' }
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  for (const component of ['engine', 'upscale']) {
    let failure = null
    try {
      await call({ action: 'upgrade', component })
    } catch (error) {
      failure = error
    }
    assert(failure !== null, `${component} upgrade with unreachable mirror should fail`)
    assert(/rolled back/.test(String(failure.message)), `${component} rollback note missing: ${failure.message}`)
  }
  assert(existsSync(path.join(layout.engineRoot, 'ComfyUI', 'main.py')), 'engine rollback missing main.py')
  assert(existsSync(path.join(layout.upscaleRoot, 'realcugan-ncnn-vulkan', 'realcugan-ncnn-vulkan.exe')), 'upscale rollback missing realcugan engine')
  assert(existsSync(path.join(layout.upscaleRoot, 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe')), 'upscale rollback missing realesrgan engine')
  assert(listBackups(layout, 'engine').length === 0, 'engine rollback left a backup')
  assert(listBackups(layout, 'upscale').length === 0, 'upscale rollback left a backup')
  const afterDirs = readStateFile()
  assert(afterDirs.installed.engine.version === '0.38.0', 'engine rollback changed recorded version')
  assert(afterDirs.installed.upscale.version === '2020.01', 'upscale rollback changed recorded version')
  console.log('✓ failed engine/upscale upgrade restores whole directories')

  // 7. 引擎运行中升级：先停引擎 → 失败回滚 → 再重启。
  //    旧行为：备份是整目录 rename，引擎跑着会 EBUSY，升级点下去直接失败。
  const { createServer } = await import('node:http')
  const engineServer = createServer((req, res) => {
    if (req.url === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"system":{"comfyui_version":"0.39.0"}}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => engineServer.listen(0, '127.0.0.1', resolve))
  config.comfyBaseUrl = `http://127.0.0.1:${engineServer.address().port}`
  const calls = []
  comfyTool = {
    execute: async (args) => {
      calls.push(`${args.action}:${args.op ?? ''}:${args.profile ?? ''}`)
      return { ok: true }
    },
  }
  const state7 = readStateFile()
  state7.installed.engine = { version: '0.38.0', pack: 'default' }
  writeFileSync(statePath, JSON.stringify(state7, null, 2))
  // 夹具：引擎目录里的用户数据（模型注册表 / 自定义节点 / 工作流库）——整目录替换不能弄丢
  const registryYaml = path.join(layout.engineRoot, 'ComfyUI', 'extra_model_paths.yaml')
  const poseNode = path.join(layout.engineRoot, 'ComfyUI', 'custom_nodes', 'ComfyUI-Fisher-Pose', '__init__.py')
  const userDb = path.join(layout.engineRoot, 'ComfyUI', 'user', 'comfyui.db')
  mkdirSync(path.dirname(poseNode), { recursive: true })
  mkdirSync(path.dirname(userDb), { recursive: true })
  writeFileSync(registryYaml, 'image-studio:\n    base_path: "models-fixture"\n')
  writeFileSync(poseNode, '# pose node\n')
  writeFileSync(userDb, 'sqlite\n')
  let failure7 = null
  try {
    await call({ action: 'upgrade', component: 'engine' })
  } catch (error) {
    failure7 = error
  }
  assert(failure7 !== null, 'engine upgrade should still fail on the unreachable mirror')
  assert(calls[0] === 'control:stop:', `engine must be stopped before backup, got ${calls[0] ?? '(none)'}`)
  assert(calls.includes('control:start:normal'), `engine must be restarted after failure, got ${calls.join(',')}`)
  assert(/stopping it before backup/.test(String(failure7.message)), `stop note missing: ${failure7.message}`)
  assert(/rolled back/.test(String(failure7.message)), `engine rollback note missing: ${failure7.message}`)
  assert(existsSync(path.join(layout.engineRoot, 'ComfyUI', 'main.py')), 'engine rollback missing main.py')
  assert(existsSync(registryYaml), 'engine user data (extra_model_paths.yaml) lost after rollback')
  assert(existsSync(poseNode), 'engine user data (custom_nodes) lost after rollback')
  assert(existsSync(userDb), 'engine user data (user/comfyui.db) lost after rollback')
  assert(!existsSync(path.join(layout.installRoot, '.staging')), 'engine upgrade left a .staging directory behind')
  console.log('✓ engine upgrade stops the running engine, preserves user data, and restarts after rollback')

  // 7b. 引擎在跑但宿主没注册 comfy 工具：明确拒绝，不假装成功（ok:false + 可执行提示）
  comfyTool = null
  const refused = await call({ action: 'upgrade', component: 'engine' })
  assert(refused.ok === false, 'upgrade should refuse when the engine is running and cannot be stopped')
  assert(/comfy tool is not registered/.test(String(refused.message)), `refusal should name the comfy tool: ${refused.message}`)
  await new Promise((resolve) => engineServer.close(resolve))
  console.log('✓ engine upgrade refuses when the running engine cannot be stopped')

  // 8. 端到端：真 7z 归档 + 真实下载 + 停/备份/解压/保留用户数据/版本核对/重启。
  //    用临时 pluginRoot 提供一份指向本地 HTTP 服务的清单，完全不联网。
  const { find7z } = await import('./find-7z.mjs')
  const sevenZip = find7z() === '' ? undefined : find7z()
  if (sevenZip === undefined) {
    console.log('skip: 找不到 7z，跳过引擎升级端到端用例')
  } else {
    const { execFileSync } = await import('node:child_process')
    const { createHash } = await import('node:crypto')
    const e2e = mkdtempSync(path.join(tmpdir(), 'imagekit-engine-e2e-'))
    // 离线固定：有本机 7-Zip 就用它解压，不去下载内置 7zr（否则该用例依赖 GitHub 可达性，
    // 上游 504 时整条 npm test 会假红）。内置 7zr 路径见 test-upscale-archive 与 CHANGELOG 的手工验证。
    const prevSevenZip = process.env.SEVEN_ZIP
    process.env.SEVEN_ZIP = sevenZip
    try {
      // 8a. 造一个「v0.44.0」的引擎归档（内含 ComfyUI/main.py 与 comfyui_version.py）
      const stage = path.join(e2e, 'stage')
      const archiveEngine = path.join(stage, 'ComfyUI_windows_portable')
      mkdirSync(path.join(archiveEngine, 'ComfyUI'), { recursive: true })
      writeFileSync(path.join(archiveEngine, 'ComfyUI', 'main.py'), '# main v0.44.0\n')
      writeFileSync(path.join(archiveEngine, 'ComfyUI', 'comfyui_version.py'), '__version__ = "0.44.0"\n')
      writeFileSync(path.join(archiveEngine, 'python_embeded.exe'), 'stub')
      execFileSync(sevenZip, ['a', path.join(e2e, 'engine.7z'), 'ComfyUI_windows_portable'], {
        cwd: stage,
        stdio: 'ignore',
      })
      const archiveBytes = readFileSync(path.join(e2e, 'engine.7z'))
      const archiveSha = createHash('sha256').update(archiveBytes).digest('hex')
      let served = 0
      const mirror = createServer((req, res) => {
        served += 1
        const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
        const start = m ? Number(m[1]) : 0
        const slice = archiveBytes.subarray(start)
        res.writeHead(start > 0 ? 206 : 200, {
          'content-type': 'application/octet-stream',
          'content-length': String(slice.length),
          ...(start > 0 ? { 'content-range': `bytes ${start}-${archiveBytes.length - 1}/${archiveBytes.length}` } : {}),
        })
        res.end(slice)
      })
      await new Promise((resolve) => mirror.listen(0, '127.0.0.1', resolve))

      // 8b. 临时 pluginRoot + 清单（引擎指向本地 mirror；只有 engine 组件）
      const pluginRoot2 = path.join(e2e, 'plugin')
      mkdirSync(pluginRoot2, { recursive: true })
      writeFileSync(
        path.join(pluginRoot2, 'models.manifest.json'),
        JSON.stringify(
          {
            manifestVersion: 1,
            components: {
              engine: {
                label: 'engine',
                packs: {
                  default: {
                    version: '0.44.0',
                    files: [
                      {
                        label: 'portable',
                        path: 'engine/ComfyUI_windows_portable.7z',
                        checkPath: 'engine/ComfyUI_windows_portable/ComfyUI/main.py',
                        sources: { official: `http://127.0.0.1:${mirror.address().port}/engine.7z` },
                        sizeBytes: archiveBytes.length,
                        sha256: archiveSha,
                        extractTo: 'engine',
                      },
                    ],
                  },
                },
              },
            },
          },
          null,
          2
        )
      )

      // 8c. 临时 installRoot：装好的 v0.39.0 引擎 + 用户数据 + state
      const installRoot2 = path.join(e2e, 'ImageKit')
      const engineRoot2 = path.join(installRoot2, 'engine', 'ComfyUI_windows_portable')
      mkdirSync(path.join(engineRoot2, 'ComfyUI', 'custom_nodes', 'ComfyUI-Fisher-Pose'), { recursive: true })
      mkdirSync(path.join(engineRoot2, 'ComfyUI', 'user'), { recursive: true })
      writeFileSync(path.join(engineRoot2, 'ComfyUI', 'main.py'), '# main v0.39.0 OLD\n')
      writeFileSync(path.join(engineRoot2, 'ComfyUI', 'comfyui_version.py'), '__version__ = "0.39.0"\n')
      writeFileSync(path.join(engineRoot2, 'ComfyUI', 'extra_model_paths.yaml'), 'image-studio:\n    base_path: "models-fixture"\n')
      writeFileSync(path.join(engineRoot2, 'ComfyUI', 'custom_nodes', 'ComfyUI-Fisher-Pose', '__init__.py'), '# pose\n')
      writeFileSync(path.join(engineRoot2, 'ComfyUI', 'user', 'comfyui.db'), 'sqlite\n')
      mkdirSync(path.join(installRoot2, '.imagekit'), { recursive: true })
      writeFileSync(
        path.join(installRoot2, '.imagekit', 'state.json'),
        JSON.stringify({ installed: { engine: { version: '0.39.0', pack: 'default' } } }, null, 2)
      )

      // 8d. 第二次注册（临时 pluginRoot/config），假 comfy 工具记录停/起
      const registered2 = []
      const engineCalls = []
      registerSetupTools(
        {
          tools: {
            register: (tool) => registered2.push(tool),
            get: (name) =>
              name === 'comfy'
                ? {
                    execute: async (args) => {
                      engineCalls.push(`${args.action}:${args.op}:${args.profile ?? ''}`)
                      return { ok: true }
                    },
                  }
                : undefined,
          },
          effect: () => {},
          inject: undefined,
        },
        {
          pluginRoot: pluginRoot2,
          config: {
            installRoot: installRoot2,
            engineRoot: engineRoot2,
            modelsRoot: path.join(installRoot2, 'models'),
            upscaleEnginesRoot: path.join(installRoot2, 'upscale-engines', 'engines'),
            comfyBaseUrl: `http://127.0.0.1:${mirror.address().port}`,
            // 网关端口也指到本地服务器：升级器的「只杀本引擎目录的网关进程」保护应当跳过它
            gatewayUrl: `http://127.0.0.1:${mirror.address().port}`,
            modelSource: 'official',
            keepVersions: '1',
          },
        }
      )
      // mirror 同时要响应引擎探活
      const e2eComfy = registered2[0]
      writeFileSync(path.join(installRoot2, '.imagekit', 'state.json'), JSON.stringify({ installed: { engine: { version: '0.39.0', pack: 'default' } } }, null, 2))
      mirror.removeAllListeners('request')
      mirror.on('request', (req, res) => {
        if (req.url === '/system_stats') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"system":{"comfyui_version":"0.39.0"}}')
          return
        }
        served += 1
        const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
        const start = m ? Number(m[1]) : 0
        const slice = archiveBytes.subarray(start)
        res.writeHead(start > 0 ? 206 : 200, {
          'content-type': 'application/octet-stream',
          'content-length': String(slice.length),
          ...(start > 0 ? { 'content-range': `bytes ${start}-${archiveBytes.length - 1}/${archiveBytes.length}` } : {}),
        })
        res.end(slice)
      })

      const upgraded = await e2eComfy.execute({ action: 'upgrade', component: 'engine' }, {})
      assert(upgraded.ok === true, `engine upgrade failed: ${upgraded.message}`)
      assert(/preserving engine user data/.test(upgraded.message), `preserve note missing: ${upgraded.message}`)
      assert(/restored engine user data/.test(upgraded.message), `restore note missing: ${upgraded.message}`)
      assert(
        /gateway on port \d+ \(pid \d+\) is not using this engine's python/.test(upgraded.message),
        `gateway safety check missing: ${upgraded.message}`
      )
      assert(/engine restarted \(upgrade finished\)/.test(upgraded.message), `restart note missing: ${upgraded.message}`)
      assert(engineCalls[0] === 'control:stop:', `engine stop missing: ${engineCalls.join(',')}`)
      assert(engineCalls[engineCalls.length - 1] === 'control:start:normal', `engine start missing: ${engineCalls.join(',')}`)
      assert(served > 0, 'archive was never downloaded')
      // 新版本真的被解压替换
      assert(
        /0\.44\.0/.test(readFileSync(path.join(engineRoot2, 'ComfyUI', 'comfyui_version.py'), 'utf8')),
        'engine version file was not replaced'
      )
      // 用户数据被放回新目录
      assert(existsSync(path.join(engineRoot2, 'ComfyUI', 'extra_model_paths.yaml')), 'extra_model_paths.yaml lost after upgrade')
      assert(
        existsSync(path.join(engineRoot2, 'ComfyUI', 'custom_nodes', 'ComfyUI-Fisher-Pose', '__init__.py')),
        'custom_nodes lost after upgrade'
      )
      assert(existsSync(path.join(engineRoot2, 'ComfyUI', 'user', 'comfyui.db')), 'user/comfyui.db lost after upgrade')
      assert(!existsSync(path.join(installRoot2, '.staging')), '.staging left behind after successful upgrade')
      // 旧版本进备份（keepVersions=1 保留 1 份）
      const backups2 = listBackups(
        {
          installRoot: installRoot2,
          engineRoot: engineRoot2,
          stateDir: path.join(installRoot2, '.imagekit'),
        },
        'engine'
      )
      assert(backups2.length === 1, `expected 1 engine backup, got ${backups2.length}`)
      assert(
        /v0\.39\.0 OLD/.test(
          readFileSync(path.join(backups2[0].dir, 'payload', 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), 'utf8')
        ),
        'backup does not contain the old engine'
      )
      const stateAfter = JSON.parse(readFileSync(path.join(installRoot2, '.imagekit', 'state.json'), 'utf8'))
      assert(stateAfter.installed.engine.version === '0.44.0', `state not updated: ${stateAfter.installed.engine.version}`)
      const statusAfter = await e2eComfy.execute({ action: 'status' }, {})
      const engineRow = statusAfter.components.find((row) => row.component === 'engine')
      assert(engineRow.installedVersion === '0.44.0', `detected version wrong: ${engineRow.installedVersion}`)
      assert(engineRow.updateAvailable === false, 'upgraded engine still reports update available')
      mirror.closeAllConnections?.()
      mirror.close()
      console.log('✓ engine upgrade end-to-end: real 7z extract, user data preserved, version verified, engine restarted')
    } finally {
      if (prevSevenZip === undefined) delete process.env.SEVEN_ZIP
      else process.env.SEVEN_ZIP = prevSevenZip
      rmSync(e2e, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log("\n✓ image_setup 集成检查 12 组全部通过")
