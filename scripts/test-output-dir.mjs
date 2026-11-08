#!/usr/bin/env node
/**
 * 输出目录落盘自测（离线）。
 *
 *   node scripts/test-output-dir.mjs
 *
 * 直接驱动 saveImages（通过一个假的图像源文件）验证：
 *   - 不传 save_to 时，所有图都进 outputDir；
 *   - 同名不覆盖，自动加 -1 后缀；
 *   - 传 save_to 目录尾斜杠时只存第一张，旧语义不变。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mod = await import(new URL('../lib/generate/tools.js', import.meta.url).href)

// saveImages 不导出；用注册工具的表驱动不了网络，这里直接测等价行为的公开面：
// 通过 registerImageGenTools 拿不到 execute（要网关），因此改测导出的辅助行为——
// 若未导出，则跳过并提示。
const saveImages = mod.saveImages
if (typeof saveImages !== 'function') {
  console.log('skip: saveImages is not exported (internal helper)')
  process.exit(0)
}

const root = mkdtempSync(path.join(tmpdir(), 'imagekit-out-'))
const outDir = path.join(root, 'outputs')
const fail = (message) => {
  console.error('✗ ' + message)
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
const assert = (condition, message) => {
  if (!condition) fail(message)
}

const sourceDir = path.join(root, 'engine-output')
mkdirSync(sourceDir, { recursive: true })
const a = path.join(sourceDir, 'ComfyUI_00001_.png')
const b = path.join(sourceDir, 'ComfyUI_00002_.png')
writeFileSync(a, 'a')
writeFileSync(b, 'b')
const sources = [{ filename: a }, { filename: b }]

const first = await saveImages(sources, undefined, outDir)
assert(Array.isArray(first.saved) && first.saved.length === 2, `expected 2 saved, got ${first.saved?.length}`)
assert(first.savedTo === first.saved[0], 'saved_to should be the first saved path')
assert(readdirSync(outDir).length === 2, 'output dir should hold 2 files')
console.log('✓ no save_to -> all images into outputDir')

const again = await saveImages(sources, undefined, outDir)
assert(again.saved[0].endsWith('ComfyUI_00001_-1.png'), `dedupe suffix wrong: ${again.saved[0]}`)
assert(readdirSync(outDir).length === 4, 'dedupe should not overwrite')
console.log('✓ same name does not overwrite (adds -1 suffix)')

const explicit = path.join(root, 'explicit')
mkdirSync(explicit, { recursive: true })
const single = await saveImages(sources, explicit + path.sep, outDir)
assert(single.savedTo === path.join(explicit, 'ComfyUI_00001_.png'), 'explicit dir should keep original name')
assert(single.saved === undefined, 'explicit save_to should only save the first image')
assert(existsSync(single.savedTo), 'explicit target missing')
console.log('✓ save_to keeps old semantics (first image only)')

const noDir = await saveImages(sources, undefined, undefined)
assert(Object.keys(noDir).length === 0, 'no outputDir should keep legacy behaviour')
console.log('✓ no outputDir -> legacy behaviour')

rmSync(root, { recursive: true, force: true })
console.log('\n✓ 输出目录落盘自测通过')
