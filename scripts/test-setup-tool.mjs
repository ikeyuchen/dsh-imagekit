#!/usr/bin/env node
/**
 * image_setup 工具集成自测（离线，不联网、不启动宿主）。
 *
 *   npm i --no-save @deepseek-ai/dsh-tools
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
const { backupTargets, listBackups, registerSetupTools } = await import(new URL('../lib/setup.js', import.meta.url).href)

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
registerSetupTools(
  { tools: { register: (tool) => registered.push(tool) }, effect: () => {}, inject: undefined },
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

  mkdirSync(path.join(layout.upscaleRoot, 'realcugan-ncnn-vulkan', 'models-pro'), { recursive: true })
  mkdirSync(path.join(layout.upscaleRoot, 'realesrgan-ncnn-vulkan', 'models'), { recursive: true })

  // 1. status：版本字段齐全，引擎版本来自 comfyui_version.py
  const status = await call({ action: 'status' })
  assert(status.ok && status.components.length === 3, 'status should return 3 components')
  let latestStatus = status
  const row = (name) => latestStatus.components.find((item) => item.component === name)
  assert(row('engine').targetVersion === ENGINE_VERSION, 'engine targetVersion should match manifest')
  assert(row('engine').installedVersion === '0.39.0', 'engine installedVersion should come from comfyui_version.py')
  assert(row('models').targetVersion === '2.1', 'models targetVersion should be 2.1')
  assert(row('models').missing === 0, 'models should report no missing manifest files')
  assert(row('upscale').targetVersion === '3.142.01', 'upscale targetVersion should be 3.142.01')
  // 首次 status 应把探测版本落盘（adopted），下次 status 以记录为准
  assert(readStateFile().installed.engine.version === ENGINE_VERSION, 'engine version was not adopted')
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
  const skipped = await call({ action: 'upgrade', component: 'models' })
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
    await call({ action: 'upgrade', component: 'models' })
  } catch (error) {
    failure = error
  }
  assert(failure !== null, 'upgrade with unreachable mirror should fail')
  assert(/rolled back/.test(String(failure.message)), `rollback note missing: ${failure.message}`)
  assert(existsSync(modelA) && statSync(modelA).size === 16, 'rolled-back model file missing or wrong size')
  assert(listBackups(layout, 'models').length === 0, 'rollback left a backup behind')
  assert(readStateFile().installed.models.version === '2.0', 'rollback changed the recorded version')
  console.log('✓ failed upgrade rolls back file + keeps recorded version')

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
  assert(existsSync(path.join(layout.upscaleRoot, 'realcugan-ncnn-vulkan', 'models-pro')), 'upscale rollback missing realcugan dir')
  assert(existsSync(path.join(layout.upscaleRoot, 'realesrgan-ncnn-vulkan', 'models')), 'upscale rollback missing realesrgan dir')
  assert(listBackups(layout, 'engine').length === 0, 'engine rollback left a backup')
  assert(listBackups(layout, 'upscale').length === 0, 'upscale rollback left a backup')
  const afterDirs = readStateFile()
  assert(afterDirs.installed.engine.version === '0.38.0', 'engine rollback changed recorded version')
  assert(afterDirs.installed.upscale.version === '2020.01', 'upscale rollback changed recorded version')
  console.log('✓ failed engine/upscale upgrade restores whole directories')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log("\n✓ image_setup 集成检查 6 组全部通过")
