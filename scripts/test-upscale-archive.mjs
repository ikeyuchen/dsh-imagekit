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

/** 找一个可执行的 7z（与 lib/setup.js 同源优先级）。 */
function find7z() {
  const candidates = [
    process.env.SEVEN_ZIP,
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return ''
}

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

// —— 没有 7-Zip 的机器：Windows 自带 tar（libarchive）必须同样能解 ——
// 1) 强制 tar 解 .7z（选择性解压 --include 也要能用）
process.env.IMAGEKIT_EXTRACTOR = 'tar'
const tarRoot = path.join(root, 'tar-case')
const tarPlugin = path.join(root, 'tar-plugin')
const tarUpscale = path.join(tarRoot, 'upscale-engines', 'engines')
const tarArchive = path.join(tarUpscale, 'archives', 'test.7z')
mkdirSync(path.dirname(tarArchive), { recursive: true })
copyFileSync(archive, tarArchive)
mkdirSync(tarPlugin, { recursive: true })
writeFileSync(
  path.join(tarPlugin, 'models.manifest.json'),
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
const tarTools = []
registerSetupTools(
  { tools: { register: (tool) => tarTools.push(tool) }, effect: () => {}, inject: undefined },
  {
    pluginRoot: tarPlugin,
    config: {
      installRoot: tarRoot,
      upscaleEnginesRoot: tarUpscale,
      modelsRoot: path.join(tarRoot, 'models'),
      engineRoot: path.join(tarRoot, 'engine', 'ComfyUI_windows_portable'),
    },
  }
)
const tarStatus = await tarTools[0].execute({ action: 'status' }, {})
assert(/extractor: tar/.test(tarStatus.message), `status should report the tar extractor: ${tarStatus.message.split('\n').slice(-4).join(' | ')}`)
const tarInstalled = await tarTools[0].execute({ action: 'install', component: 'upscale' }, {})
assert(tarInstalled.ok, `tar-only install failed: ${tarInstalled.message}`)
assert(
  existsSync(path.join(tarUpscale, 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe')),
  'tar fallback did not extract the 7z glob target'
)
console.log('✓ 没有 7-Zip 时用系统 tar 解 .7z + 选择性解压')

// 2) 强制 tar 解 .zip（放大引擎实际是 zip + extractRename）
const zipArchive = path.join(tarUpscale, 'archives', 'engine.zip')
assert(buildZipFixture(zipArchive), 'could not build zip fixture')
const zipManifest = path.join(tarPlugin, 'models.manifest.json')
writeFileSync(
  zipManifest,
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
const zipTools = []
registerSetupTools(
  { tools: { register: (tool) => zipTools.push(tool) }, effect: () => {}, inject: undefined },
  {
    pluginRoot: tarPlugin,
    config: {
      installRoot: tarRoot,
      upscaleEnginesRoot: tarUpscale,
      modelsRoot: path.join(tarRoot, 'models'),
      engineRoot: path.join(tarRoot, 'engine', 'ComfyUI_windows_portable'),
    },
  }
)
const zipInstalled = await zipTools[0].execute({ action: 'install', component: 'upscale' }, {})
assert(zipInstalled.ok, `tar zip install failed: ${zipInstalled.message}`)
assert(existsSync(path.join(tarUpscale, 'realcugan-ncnn-vulkan', 'realcugan-ncnn-vulkan.exe')), 'tar fallback did not extract+rename the zip')
console.log('✓ 没有 7-Zip 时用系统 tar 解 .zip 并重命名目录')
delete process.env.IMAGEKIT_EXTRACTOR

rmSync(root, { recursive: true, force: true })
console.log('\n✓ 整合包选择性解压自测通过（7z 与 tar 兜底均验证）')
