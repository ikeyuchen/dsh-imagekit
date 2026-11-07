#!/usr/bin/env node
/**
 * 版本备份/回滚/旧版本删除自测（离线，不启动宿主、不联网）。
 *
 *   npm i --no-save @deepseek-ai/dsh-tools
 *   node scripts/test-backup.mjs
 *
 * 覆盖：引擎整目录备份/回滚、模型单文件备份、旧版本列表、按 keepVersions 清理、
 *       非法备份 id 拒绝、组件版本视图（记录版本 / 清单推断 / 有更新）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const {
  backupTargets,
  componentVersions,
  listBackups,
  pruneBackups,
  readEngineVersion,
  removeBackup,
  restoreBackup,
} = await import(new URL('../lib/setup.js', import.meta.url).href)

const root = mkdtempSync(path.join(tmpdir(), 'imagekit-backup-'))
const layout = {
  installRoot: root,
  engineRoot: path.join(root, 'engine', 'ComfyUI_windows_portable'),
  modelsRoot: path.join(root, 'models'),
  upscaleRoot: path.join(root, 'upscale-engines', 'engines'),
  stateDir: path.join(root, '.imagekit'),
}

const fail = (message) => {
  console.error('✗ ' + message)
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
const assert = (condition, message) => {
  if (!condition) fail(message)
}

try {
  // 1. 引擎版本文件 + 整目录备份/回滚
  mkdirSync(path.join(layout.engineRoot, 'ComfyUI'), { recursive: true })
  writeFileSync(path.join(layout.engineRoot, 'ComfyUI', 'comfyui_version.py'), '__version__ = "0.39.0"\n')
  writeFileSync(path.join(layout.engineRoot, 'python_embeded.exe'), 'binary')
  assert(readEngineVersion(layout) === '0.39.0', 'readEngineVersion did not parse comfyui_version.py')

  const engineBackup = backupTargets(layout, 'engine', [layout.engineRoot], {
    version: '0.39.0',
    pack: 'default',
    kind: 'directory',
  })
  assert(engineBackup !== null, 'engine backup returned null')
  assert(!existsSync(layout.engineRoot), 'engine root still present after backup')
  assert(engineBackup.payloads.length === 1, 'engine backup should have one payload')
  assert(engineBackup.bytes > 0 && engineBackup.files >= 2, 'engine backup size/files not counted')
  const engineList = listBackups(layout, 'engine')
  assert(engineList.length === 1, 'listBackups(engine) should return 1 row')
  assert(engineList[0].version === '0.39.0', 'backup version lost')

  restoreBackup(layout, engineBackup)
  assert(existsSync(path.join(layout.engineRoot, 'python_embeded.exe')), 'engine restore did not move payload back')
  assert(listBackups(layout, 'engine').length === 0, 'backup dir not removed after restore')
  console.log('✓ engine directory backup + restore')

  // 2. 模型单文件备份（只备份将被替换的文件）
  mkdirSync(path.join(layout.modelsRoot, 'diffusion_models'), { recursive: true })
  const modelA = path.join(layout.modelsRoot, 'diffusion_models', 'a.safetensors')
  const modelB = path.join(layout.modelsRoot, 'diffusion_models', 'b.safetensors')
  writeFileSync(modelA, Buffer.alloc(64, 1))
  writeFileSync(modelB, Buffer.alloc(32, 2))
  const modelBackup = backupTargets(layout, 'models', [modelA], { version: '2.1', pack: 'core' })
  assert(modelBackup !== null, 'models backup returned null')
  assert(!existsSync(modelA), 'model A still present after backup')
  assert(existsSync(modelB), 'model B should not be touched')
  const modelList = listBackups(layout, 'models')
  assert(modelList.length === 1 && modelList[0].kind === 'files', 'model backup metadata wrong')
  restoreBackup(layout, modelBackup)
  assert(readFileSync(modelA).length === 64 && existsSync(modelB), 'model file restore failed')
  console.log('✓ model file backup + restore')

  // 3. 删除旧版本备份 + 非法 id 拒绝（用一次性文件，不碰模型 A）
  const modelC = path.join(layout.modelsRoot, 'diffusion_models', 'c.safetensors')
  writeFileSync(modelC, Buffer.alloc(64, 4))
  const removable = backupTargets(layout, 'models', [modelC], { version: '2.0', pack: 'core' })
  assert(removable !== null, 'removable backup returned null')
  const removed = removeBackup(layout, 'models', removable.id)
  assert(removed.bytes === 64 && removed.files === 1, 'removeBackup size/files wrong')
  assert(listBackups(layout, 'models').length === 0, 'backup dir still listed after delete')
  let refused = false
  try {
    removeBackup(layout, 'models', '..')
  } catch {
    refused = true
  }
  assert(refused, 'removeBackup accepted an unsafe id')
  console.log('✓ delete old-version backup + unsafe id refused')

  // 4. keepVersions 清理（模拟三次升级：旧文件进备份，新文件落到原位）
  const first = backupTargets(layout, 'models', [modelA], { version: '2.0', pack: 'core' })
  assert(first !== null, 'first backup returned null')
  writeFileSync(modelA, Buffer.alloc(64, 5))
  const second = backupTargets(layout, 'models', [modelA], { version: '2.1', pack: 'core' })
  assert(second !== null, 'second backup returned null')
  writeFileSync(modelA, Buffer.alloc(64, 6))
  const again = backupTargets(layout, 'models', [modelA], { version: '2.2', pack: 'core' })
  assert(again !== null, 'third backup returned null')
  writeFileSync(modelA, Buffer.alloc(64, 7))
  assert(listBackups(layout, 'models').length === 3, 'expected 3 backups before prune')
  const pruned = pruneBackups(layout, 'models', 1)
  assert(pruned.length === 2, `prune should remove 2, removed ${pruned.length}`)
  assert(listBackups(layout, 'models').length === 1, 'prune left wrong number of backups')
  pruneBackups(layout, 'models', 0)
  assert(listBackups(layout, 'models').length === 0, 'prune keep=0 left backups')
  console.log('✓ prune old backups by keepVersions')

  // 5. 版本视图：记录版本 / 清单推断 / 有更新 / 缺文件
  const manifest = {
    components: {
      models: {
        packs: {
          core: {
            version: '2.1',
            files: [{ path: 'diffusion_models/a.safetensors', sizeBytes: 64 }],
          },
        },
      },
    },
  }
  const current = componentVersions(manifest, 'models', undefined, layout, {
    installed: { models: { version: '2.1' } },
  })
  assert(current.targetVersion === '2.1' && current.installedVersion === '2.1', 'recorded version view wrong')
  assert(current.updateAvailable === false, 'same version reported as update')

  const outdated = componentVersions(manifest, 'models', undefined, layout, {
    installed: { models: { version: '2.0' } },
  })
  assert(outdated.updateAvailable === true, 'older recorded version not flagged as update')

  const inferred = componentVersions(manifest, 'models', undefined, layout, {})
  assert(inferred.installedVersion === '2.1' && inferred.versionSource === 'manifest', 'manifest inference failed')

  rmSync(modelA, { force: true })
  const missing = componentVersions(manifest, 'models', undefined, layout, {})
  assert(missing.updateAvailable === true, 'missing manifest file not flagged as update')
  console.log('✓ version view: recorded / inferred / update available')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n✓ 备份与版本 5 组检查全部通过')
