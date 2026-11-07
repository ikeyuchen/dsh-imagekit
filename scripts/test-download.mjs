#!/usr/bin/env node
/**
 * 下载器自测（离线）：本地 HTTP 服务 + 断点续传 + 大小/哈希校验。
 *
 *   npm install   # 宿主侧 peer 依赖已钉在 devDependencies
 *   node scripts/test-download.mjs
 *
 * 覆盖：全新下载、已存在跳过、.partial 续传、sha256 不符拒绝、大小不符拒绝。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { downloadTo, proxiedUrl } = await import(new URL('../lib/setup.js', import.meta.url).href)

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
// 代理链接改写：只代理 github.com 发布页链接（ghfast.top 不代 api.github.com，实测 403）
const ghRelease = 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip'
if (proxiedUrl(ghRelease, '') !== null) fail('empty proxy should not rewrite')
if (proxiedUrl(ghRelease, 'https://ghfast.top/') !== `https://ghfast.top/${ghRelease}`) fail('proxy rewrite wrong')
if (proxiedUrl(ghRelease, 'https://ghfast.top') !== `https://ghfast.top/${ghRelease}`) fail('proxy trailing slash not normalised')
if (proxiedUrl('https://api.github.com/repos/x/y/releases/assets/1', 'https://ghfast.top/') !== null) fail('api url must not be proxied')
if (proxiedUrl('https://huggingface.co/a/b', 'https://ghfast.top/') !== null) fail('non-github url must not be proxied')
console.log('✓ proxy rewrite only touches github.com release URLs')

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
  await downloadTo(base, dest, { sizeBytes: payload.length + 10, sha256: null, attempts: 1 })
} catch {
  threw = true
}
if (!threw) fail('size mismatch did not throw')
console.log('✓ size mismatch rejected (partial kept for resume)')

// 无数据超时：连上了但一个字节都不发，不能无限期挂着（旧实现会让设置页的升级按钮永远转圈）
const stallServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
  // 故意不 end：让客户端收不到数据
})
await new Promise((resolve) => stallServer.listen(0, '127.0.0.1', resolve))
const stallUrl = `http://127.0.0.1:${stallServer.address().port}/stall.bin`
const stallDest = path.join(dir, 'stall.bin')
const startedAt = Date.now()
threw = false
try {
  await downloadTo(stallUrl, stallDest, { sizeBytes: payload.length, attempts: 1, idleTimeoutMs: 200 })
} catch {
  threw = true
}
if (!threw) fail('stalled download did not time out')
if (Date.now() - startedAt > 5000) fail('stalled download timeout took too long')
stallServer.closeAllConnections?.()
stallServer.close()
console.log('✓ stalled download times out instead of hanging forever')

// 断流重试：第一次只发一半就僵住 → 超时中断 → 续传补齐
let stallOnce = true
const retryServer = createServer((req, res) => {
  const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
  const start = m ? Number(m[1]) : 0
  if (stallOnce) {
    stallOnce = false
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
    res.write(payload.subarray(0, half))
    return // 不 end：模拟断流
  }
  const slice = payload.subarray(start)
  res.writeHead(start > 0 ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(slice.length),
    ...(start > 0 ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
  })
  res.end(slice)
})
await new Promise((resolve) => retryServer.listen(0, '127.0.0.1', resolve))
const retryDest = path.join(dir, 'retry.bin')
const retried = await downloadTo(`http://127.0.0.1:${retryServer.address().port}/retry.bin`, retryDest, {
  sizeBytes: payload.length,
  sha256: sha,
  attempts: 2,
  idleTimeoutMs: 200,
})
if (retried.skipped) fail('retry download reported skipped')
if (!readFileSync(retryDest).equals(payload)) fail('resumed-after-stall file is corrupt')
retryServer.closeAllConnections?.()
retryServer.close()
console.log('✓ stalled download retries and resumes from the partial file')

// 代理兜底：主路径不可达时，改用 proxyBase 改写后的地址成功下载（本地服务器扮演代理）
const proxyServer = createServer((req, res) => {
  // 本地服务器充当 ghfast.top：URL 形如 /https://github.com/.../file.bin
  const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
  const start = m ? Number(m[1]) : 0
  const slice = payload.subarray(start)
  res.writeHead(start > 0 ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(slice.length),
    ...(start > 0 ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
  })
  res.end(slice)
})
await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
const proxyBase = `http://127.0.0.1:${proxyServer.address().port}`
const proxyDest = path.join(dir, 'via-proxy.bin')
const proxied = await downloadTo(
  // 指向一个不可能连通的 github.com 地址：只能靠 proxyBase 改写后成功
  'https://github.com/example-owner/example-repo/releases/download/v1.0.0/file.bin',
  proxyDest,
  { sizeBytes: payload.length, sha256: sha, proxyBase, attempts: 1, idleTimeoutMs: 5000 }
)
if (proxied.skipped) fail('proxy fallback reported skipped')
if (!readFileSync(proxyDest).equals(payload)) fail('proxy fallback bytes differ')
proxyServer.closeAllConnections?.()
proxyServer.close()
console.log('✓ proxyBase fallback downloads when the official host is unreachable')


server.close()
rmSync(dir, { recursive: true, force: true })
console.log('\n✓ 下载器 9 项检查全部通过')
