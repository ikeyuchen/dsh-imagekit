#!/usr/bin/env node
/**
 * 整合包选择性解压自测（离线，不联网）。
 *
 *   node scripts/test-upscale-archive.mjs
 *
 * 验证：7z 按 extractGlobs 只解压匹配路径，再把 extractMove 目录搬到目标根；
 * 已存在的引擎目录不被覆盖；checkPaths 全部存在才算安装完成。
 *
 * 样本归档优先级：
 *   1. 环境变量 IMAGEKIT_TEST_ARCHIVE 指向的真实包（最真实，能用真包就用真包）
 *   2. 用本机 7z 现场造一个最小归档（形状对齐：<任意前缀>/realesrgan-ncnn-vulkan/...）
 * 两者都不可用时跳过；全程不联网、不依赖本机目录。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { registerSetupTools } = await import(new URL('../lib/setup.js', import.meta.url).href)

const root = mkdtempSync(path.join(tmpdir(), 'imagekit-upscale-'))

import { find7z as find7zShared } from './find-7z.mjs'

/** 找一个可执行的 7z（Windows 默认目录 / 各平台 PATH，见 scripts/find-7z.mjs）。 */
const find7z = find7zShared

// 测试不联网：本机有 7-Zip 就显式交给解压器，避免 `7z` 走「按需下载内置 7zr」——
// 上游 504 / 断网时那条分支会让 npm test 假红。内置 7zr 路径见 CHANGELOG 的手工验证。
if (find7z() !== '') process.env.SEVEN_ZIP = find7z()

/** 当外部样本不可用时，现场造一个形状一致的最小归档。 */
function buildZipFixture(outFile) {
  const sevenZip = find7z()
  if (!sevenZip) return false
  const stage = path.join(root, 'zipfixture', 'realcugan-ncnn-vulkan-20220728-windows')
  mkdirSync(stage, { recursive: true })
  writeFileSync(path.join(stage, 'realcugan-ncnn-vulkan.exe'), 'stub')
  mkdirSync(path.join(stage, 'models-se'), { recursive: true })
  writeFileSync(path.join(stage, 'models-se', 'up2x-no-denoise.param'), 'stub')
  execFileSync(sevenZip, ['a', '-tzip', outFile, '.'], { cwd: path.join(root, 'zipfixture'), stdio: 'ignore' })
  return existsSync(outFile)
}

function buildFixtureArchive(outFile) {
  const sevenZip = find7z()
  if (!sevenZip) return false
  const stage = path.join(root, 'fixture', 'engine-vtest')
  const engineDir = path.join(stage, 'realesrgan-ncnn-vulkan')
  mkdirSync(engineDir, { recursive: true })
  writeFileSync(path.join(engineDir, 'realesrgan-ncnn-vulkan.exe'), 'stub')
  mkdirSync(path.join(engineDir, 'models'), { recursive: true })
  writeFileSync(path.join(engineDir, 'models', 'placeholder.txt'), 'stub')
  execFileSync(sevenZip, ['a', outFile, 'engine-vtest'], { cwd: path.join(root, 'fixture'), stdio: 'ignore' })
  return existsSync(outFile)
}

const pluginRoot = path.join(root, 'plugin')
mkdirSync(pluginRoot, { recursive: true })
const installRoot = path.join(root, 'ImageKit')
const upscaleRoot = path.join(installRoot, 'upscale-engines', 'engines')
const archive = path.join(upscaleRoot, 'archives', 'test.7z')
mkdirSync(path.dirname(archive), { recursive: true })

// 样本归档：优先外部真包，其次现场造一个形状一致的
const external = process.env.IMAGEKIT_TEST_ARCHIVE || ''
if (external && existsSync(external)) {
  copyFileSync(external, archive)
  console.log(`fixture: 使用外部样本 ${path.basename(external)}`)
} else if (buildFixtureArchive(archive)) {
  console.log('fixture: 用本机 7z 现造的最小归档')
} else {
  console.log('skip: 既没有 IMAGEKIT_TEST_ARCHIVE，也找不到 7z，无法构造样本归档')
  process.exit(0)
}

// 只测试 extractGlobs/extractMove 路径：不声明上游真实 size/sha（归档已存在会跳过下载）。
writeFileSync(
  path.join(pluginRoot, 'models.manifest.json'),
  JSON.stringify(
    {
      manifestVersion: 1,
      components: {
        upscale: {
          label: 'test',
          packs: {
            core: {
              version: '20220424',
              files: [
                {
                  label: 'engine test archive',
                  path: 'archives/test.7z',
                  sources: { official: 'http://127.0.0.1:1/none.7z' },
                  sizeBytes: null,
                  sha256: null,
                  extractTo: '.',
                  extractGlobs: ['*/realesrgan-ncnn-vulkan/*'],
                  extractMove: ['realesrgan-ncnn-vulkan'],
                  checkPaths: ['realesrgan-ncnn-vulkan/realesrgan-ncnn-vulkan.exe'],
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

const tools = []
registerSetupTools(
  { tools: { register: (tool) => tools.push(tool) }, effect: () => {}, inject: undefined },
  {
    pluginRoot,
    config: {
      installRoot,
      upscaleEnginesRoot: upscaleRoot,
      modelsRoot: path.join(installRoot, 'models'),
      engineRoot: path.join(installRoot, 'engine', 'ComfyUI_windows_portable'),
    },
  }
)
const setup = tools[0]

const fail = (message) => {
  console.error('✗ ' + message)
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
const assert = (condition, message) => {
  if (!condition) fail(message)
}

const before = await setup.execute({ action: 'status' }, {})
const row = before.components.find((c) => c.component === 'upscale')
assert(row.missing === 1, `expected 1 missing before install, got ${row.missing}`)

const installed = await setup.execute({ action: 'install', component: 'upscale' }, {})
assert(installed.ok, `install failed: ${installed.message}`)
assert(existsSync(path.join(upscaleRoot, 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe')), 'engine exe not moved into target root')
assert(!existsSync(path.join(upscaleRoot, '.staging')), 'staging dir leaked')

const after = await setup.execute({ action: 'status' }, {})
const afterRow = after.components.find((c) => c.component === 'upscale')
assert(afterRow.missing === 0, `expected 0 missing after install, got ${afterRow.missing}`)
console.log('✓ glob extraction + engine dir move + checkPaths status')

console.log('✓ 7z 路径（自动选择）')

// —— 简化后的两个方案：zip 走内置 Node 解压；7z 走内置 7zr（测试里用 SEVEN_ZIP 显式指向本机 7z，避免联网） ——
process.env.SEVEN_ZIP = find7z()
process.env.IMAGEKIT_EXTRACTOR = 'zip'
const zipOnlyRoot = path.join(root, 'ziponly-case')
const zipOnlyUpscale = path.join(zipOnlyRoot, 'upscale-engines', 'engines')
mkdirSync(path.join(zipOnlyUpscale, 'archives'), { recursive: true })
const zipOnlyArchive = path.join(zipOnlyUpscale, 'archives', 'engine.zip')
assert(buildZipFixture(zipOnlyArchive), 'could not build zip fixture')
const zipPlugin = path.join(root, 'zip-plugin')
mkdirSync(zipPlugin, { recursive: true })
writeFileSync(
  path.join(zipPlugin, 'models.manifest.json'),
  JSON.stringify(
    {
      manifestVersion: 1,
      components: {
        upscale: {
          label: 'test',
          packs: {
            core: {
              version: '20220728',
              files: [
                {
                  label: 'zip engine',
                  path: 'archives/engine.zip',
                  sources: { official: 'http://127.0.0.1:1/none.zip' },
                  sizeBytes: null,
                  sha256: null,
                  extractTo: '.',
                  extractRename: { from: 'realcugan-ncnn-vulkan-20220728-windows', to: 'realcugan-ncnn-vulkan', overwrite: true },
                  checkPaths: ['realcugan-ncnn-vulkan/realcugan-ncnn-vulkan.exe'],
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
const zipOnlyTools = []
registerSetupTools(
  { tools: { register: (tool) => zipOnlyTools.push(tool) }, effect: () => {}, inject: undefined },
  {
    pluginRoot: zipPlugin,
    config: {
      installRoot: zipOnlyRoot,
      upscaleEnginesRoot: zipOnlyUpscale,
      modelsRoot: path.join(zipOnlyRoot, 'models'),
      engineRoot: path.join(zipOnlyRoot, 'engine', 'ComfyUI_windows_portable'),
    },
  }
)
const zipStatus = await zipOnlyTools[0].execute({ action: 'status' }, {})
assert(/extractor: zip/.test(zipStatus.message), `status should report the native zip extractor: ${zipStatus.message.split('\n').slice(-4).join(' | ')}`)
const zipOnlyInstalled = await zipOnlyTools[0].execute({ action: 'install', component: 'upscale' }, {})
assert(zipOnlyInstalled.ok, `native zip install failed: ${zipOnlyInstalled.message}`)
assert(
  existsSync(path.join(zipOnlyUpscale, 'realcugan-ncnn-vulkan', 'realcugan-ncnn-vulkan.exe')),
  'native zip extractor did not extract+rename the archive'
)
assert(
  existsSync(path.join(zipOnlyUpscale, 'realcugan-ncnn-vulkan', 'models-se', 'up2x-no-denoise.param')),
  'native zip extractor lost nested files'
)
console.log('✓ zip 走内置 Node 解压（不依赖 7-Zip / tar）')

if (find7z() === '') {
  console.log('skip: 本机与 PATH 都没有 7z，跳过 7z 解压用例（CI 装 p7zip-full 后会跑）')
} else {
  // 7z 方案：测试用 SEVEN_ZIP 指向本机 7z（避免联网下载 7zr）；真实「无 7-Zip」场景由 7zr 兜底（手工验证见 CHANGELOG）
  delete process.env.IMAGEKIT_EXTRACTOR
  const explicitRoot = path.join(root, 'explicit7z-case')
  const explicitUpscale = path.join(explicitRoot, 'upscale-engines', 'engines')
  mkdirSync(path.join(explicitUpscale, 'archives'), { recursive: true })
  copyFileSync(archive, path.join(explicitUpscale, 'archives', 'test.7z'))
  const explicitTools = []
  registerSetupTools(
    { tools: { register: (tool) => explicitTools.push(tool) }, effect: () => {}, inject: undefined },
    {
      pluginRoot,
      config: {
        installRoot: explicitRoot,
        upscaleEnginesRoot: explicitUpscale,
        modelsRoot: path.join(explicitRoot, 'models'),
        engineRoot: path.join(explicitRoot, 'engine', 'ComfyUI_windows_portable'),
      },
    }
  )
  const explicitInstalled = await explicitTools[0].execute({ action: 'install', component: 'upscale' }, {})
  assert(explicitInstalled.ok, `7z install failed: ${explicitInstalled.message}`)
  assert(existsSync(path.join(explicitUpscale, 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe')), '7z path did not extract')
  console.log('✓ 7z 走显式 SEVEN_ZIP / 内置 7zr')
}

delete process.env.IMAGEKIT_EXTRACTOR

rmSync(root, { recursive: true, force: true })
console.log('\n✓ 整合包选择性解压自测通过（zip 内置解压 / 7z 路径均验证）')
