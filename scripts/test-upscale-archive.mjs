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
function buildFixtureArchive(outFile) {
  const sevenZip = find7z()
  if (!sevenZip) return false
  const stage = path.join(root, 'fixture', 'W2xEX-vtest')
  const engineDir = path.join(stage, 'realesrgan-ncnn-vulkan')
  mkdirSync(engineDir, { recursive: true })
  writeFileSync(path.join(engineDir, 'RealESRGAN-W2xEX.exe'), 'stub')
  mkdirSync(path.join(engineDir, 'models'), { recursive: true })
  writeFileSync(path.join(engineDir, 'models', 'placeholder.txt'), 'stub')
  execFileSync(sevenZip, ['a', outFile, 'W2xEX-vtest'], { cwd: path.join(root, 'fixture'), stdio: 'ignore' })
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
              version: '3.142.01',
              files: [
                {
                  label: 'W2xEX test archive',
                  path: 'archives/test.7z',
                  sources: { official: 'http://127.0.0.1:1/none.7z' },
                  sizeBytes: null,
                  sha256: null,
                  extractTo: '.',
                  extractGlobs: ['*/realesrgan-ncnn-vulkan/*'],
                  extractMove: ['realesrgan-ncnn-vulkan'],
                  checkPaths: ['realesrgan-ncnn-vulkan/RealESRGAN-W2xEX.exe'],
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
assert(existsSync(path.join(upscaleRoot, 'realesrgan-ncnn-vulkan', 'RealESRGAN-W2xEX.exe')), 'engine exe not moved into target root')
assert(!existsSync(path.join(upscaleRoot, '.staging')), 'staging dir leaked')

const after = await setup.execute({ action: 'status' }, {})
const afterRow = after.components.find((c) => c.component === 'upscale')
assert(afterRow.missing === 0, `expected 0 missing after install, got ${afterRow.missing}`)
console.log('✓ glob extraction + engine dir move + checkPaths status')

rmSync(root, { recursive: true, force: true })
console.log('\n✓ 整合包选择性解压自测通过')
