#!/usr/bin/env node
/**
 * 下载器自测（离线）：本地 HTTP 服务 + 断点续传 + 大小/哈希校验。
 *
 *   npm i --no-save @deepseek-ai/dsh-tools
 *   node scripts/test-download.mjs
 *
 * 覆盖：全新下载、已存在跳过、.partial 续传、sha256 不符拒绝、大小不符拒绝。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { downloadTo } = await import(new URL('../lib/setup.js', import.meta.url).href)

const payload = Buffer.alloc(512 * 1024)
for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
const sha = createHash('sha256').update(payload).digest('hex')

let requests = 0
const server = createServer((req, res) => {
  requests += 1
  const range = req.headers.range
  if (typeof range === 'string') {
    const m = /bytes=(\d+)-/.exec(range)
    const start = m ? Number(m[1]) : 0
    const slice = payload.subarray(start)
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      'accept-ranges': 'bytes',
    })
    res.end(slice)
    return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(payload.length),
    'accept-ranges': 'bytes',
  })
  res.end(payload)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/file.bin`
const dir = mkdtempSync(path.join(tmpdir(), 'imagekit-dl-'))
const dest = path.join(dir, 'file.bin')

const fail = (msg) => {
  console.error('✗ ' + msg)
  server.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

const first = await downloadTo(base, dest, { sizeBytes: payload.length, sha256: sha })
if (first.skipped) fail('fresh download reported skipped')
if (!readFileSync(dest).equals(payload)) fail('downloaded bytes differ')
console.log('✓ fresh download + sha256 verify')

const second = await downloadTo(base, dest, { sizeBytes: payload.length, sha256: sha })
if (!second.skipped) fail('existing file was re-downloaded')
console.log('✓ existing file skipped (size matches)')

rmSync(dest)
const half = Math.floor(payload.length / 2)
writeFileSync(dest + '.partial', payload.subarray(0, half))
const before = requests
const third = await downloadTo(base, dest, { sizeBytes: payload.length, sha256: sha })
if (third.skipped) fail('resume reported skipped')
if (!readFileSync(dest).equals(payload)) fail('resumed file is corrupt')
if (requests - before !== 1) fail(`resume made ${requests - before} requests, expected 1`)
console.log('✓ resume from .partial produces identical bytes')

rmSync(dest, { force: true })
let threw = false
try {
  await downloadTo(base, dest, { sizeBytes: payload.length, sha256: 'deadbeef' })
} catch {
  threw = true
}
if (!threw) fail('sha256 mismatch did not throw')
console.log('✓ sha256 mismatch rejected')
try {
  readFileSync(dest)
  fail('corrupt file still present after sha256 mismatch')
} catch {
  /* expected */
}
try {
  readFileSync(dest + '.partial')
  fail('corrupt partial still present after sha256 mismatch')
} catch {
  /* expected */
}

rmSync(dest + '.partial', { force: true })
threw = false
try {
  await downloadTo(base, dest, { sizeBytes: payload.length + 10, sha256: null })
} catch {
  threw = true
}
if (!threw) fail('size mismatch did not throw')
console.log('✓ size mismatch rejected (partial kept for resume)')

server.close()
rmSync(dir, { recursive: true, force: true })
console.log('\n✓ 下载器 5 项检查全部通过')
