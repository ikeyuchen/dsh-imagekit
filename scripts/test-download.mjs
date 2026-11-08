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
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { downloadTo, proxiedUrl, formatError } = await import(new URL('../lib/setup.js', import.meta.url).href)

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


// ---- 多连接分片 ----
const BIG_MB = 16
const bigPayload = Buffer.alloc(BIG_MB * 1024 * 1024)
for (let i = 0; i < bigPayload.length; i += 1) bigPayload[i] = (i * 7) % 251
const bigSha = createHash('sha256').update(bigPayload).digest('hex')

let activeParts = 0
let peakParts = 0
const multiServer = createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''))
  const start = m ? Number(m[1]) : 0
  const end = m && m[2] !== '' ? Number(m[2]) : bigPayload.length - 1
  if (m && end - start + 1 > 1) {
    activeParts += 1
    peakParts = Math.max(peakParts, activeParts)
    req.on('close', () => { activeParts -= 1 })
  }
  const slice = bigPayload.subarray(start, end + 1)
  res.writeHead(m ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(slice.length),
    'accept-ranges': 'bytes',
    ...(m ? { 'content-range': `bytes ${start}-${end}/${bigPayload.length}` } : {}),
  })
  // 每连接限速：每 60ms 发 128KB，模拟单连接被限速
  let offset = 0
  const step = 128 * 1024
  const timer = setInterval(() => {
    if (offset >= slice.length) { clearInterval(timer); res.end(); return }
    res.write(slice.subarray(offset, offset + step))
    offset += step
  }, 60)
  req.on('close', () => clearInterval(timer))
})
await new Promise((resolve) => multiServer.listen(0, '127.0.0.1', resolve))
const multiUrl = `http://127.0.0.1:${multiServer.address().port}/big.bin`

// 4 连接：真的并发 4 段、拼出的文件与 sha256 正确
const multiDest = path.join(dir, 'multi.bin')
let progressCalls = 0
let lastWritten = 0
const multiRes = await downloadTo(multiUrl, multiDest, {
  sizeBytes: bigPayload.length,
  sha256: bigSha,
  connections: 4,
  onProgress: (p) => { progressCalls += 1; lastWritten = p.written },
})
if (multiRes.connections !== 4) fail(`expected 4 connections, got ${multiRes.connections}`)
if (peakParts !== 4) fail(`expected 4 concurrent part requests, peaked at ${peakParts}`)
if (!readFileSync(multiDest).equals(bigPayload)) fail('multi-connection file differs from source')
if (lastWritten !== bigPayload.length) fail(`progress should end at ${bigPayload.length}, got ${lastWritten}`)
if (progressCalls < 10) fail('multi-connection should report progress repeatedly')
console.log('✓ 4 connections download in parallel and reassemble byte-identical')

// 段内续传：只留前一半的第 2 段，重跑应从断点继续
rmSync(path.join(dir, 'multi.bin'))
const part2 = multiDest + '.partial.1'
const partHalf = Math.floor((bigPayload.length / 4) / 2)
writeFileSync(part2, bigPayload.subarray(Math.floor(bigPayload.length / 4), Math.floor(bigPayload.length / 4) + partHalf))
const resumedMulti = await downloadTo(multiUrl, multiDest, { sizeBytes: bigPayload.length, sha256: bigSha, connections: 4 })
if (!readFileSync(multiDest).equals(bigPayload)) fail('resumed multi-connection file differs')
if (existsSync(part2)) fail('part file should be cleaned after successful reassembly')
console.log('✓ multi-connection resumes from an existing part file')

// 服务端忽略 Range（永远 200）→ 自动回退单流，文件仍正确
const noRangeServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bigPayload.length) })
  let offset = 0
  const step = 1024 * 1024
  const timer = setInterval(() => {
    if (offset >= bigPayload.length) { clearInterval(timer); res.end(); return }
    res.write(bigPayload.subarray(offset, offset + step))
    offset += step
  }, 5)
})
await new Promise((resolve) => noRangeServer.listen(0, '127.0.0.1', resolve))
const fallbackDest = path.join(dir, 'fallback.bin')
const fallbackRes = await downloadTo(`http://127.0.0.1:${noRangeServer.address().port}/x`, fallbackDest, {
  sizeBytes: bigPayload.length,
  sha256: bigSha,
  connections: 4,
})
if (fallbackRes.connections !== 1) fail(`expected fallback to single stream, got ${fallbackRes.connections}`)
if (!readFileSync(fallbackDest).equals(bigPayload)) fail('fallback download differs from source')
console.log('✓ falls back to single stream when the server ignores Range')

// 分片请求持续失败 → 回退单流并清掉 .partial.N（否则残留分段会占 GB 空间、下次还走同一段路）
const flakyServer = createServer((req, res) => {
  const raw = String(req.headers.range ?? '')
  const m = /^bytes=(\d+)-(\d*)$/.exec(raw)
  const isProbe = m !== null && m[1] === '0' && m[2] === '0'
  const isPart = m !== null && !isProbe && m[2] !== '' && Number(m[2]) > Number(m[1])
  if (isPart) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
    return
  }
  const start = m ? Number(m[1]) : 0
  const slice = bigPayload.subarray(start)
  res.writeHead(m ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(slice.length),
    'accept-ranges': 'bytes',
    ...(m ? { 'content-range': `bytes ${start}-${bigPayload.length - 1}/${bigPayload.length}` } : {}),
  })
  res.end(slice)
})
await new Promise((resolve) => flakyServer.listen(0, '127.0.0.1', resolve))
const flakyDest = path.join(dir, 'flaky.bin')
const flakyRes = await downloadTo(`http://127.0.0.1:${flakyServer.address().port}/x`, flakyDest, {
  sizeBytes: bigPayload.length,
  sha256: bigSha,
  connections: 4,
})
if (flakyRes.connections !== 1) fail(`expected single-stream fallback, got ${flakyRes.connections}`)
if (!readFileSync(flakyDest).equals(bigPayload)) fail('fallback after part failures produced wrong bytes')
for (let i = 0; i < 4; i += 1) {
  if (existsSync(`${flakyDest}.partial.${i}`)) fail(`stale part file left behind: .partial.${i}`)
}
console.log('✓ 分片持续失败时回退单流并清理分段文件')

// 错误文案：对象被 throw 时不能变成 [object Object]
if (formatError(new Error('boom')) !== 'boom') fail('formatError(Error) should return the message')
if (formatError('plain') !== 'plain') fail('formatError(string) should pass through')
if (formatError({ code: 'ETIMEDOUT', url: 'x' }) !== '{"code":"ETIMEDOUT","url":"x"}') {
  fail(`formatError(object) unexpected: ${formatError({ code: 'ETIMEDOUT', url: 'x' })}`)
}
if (formatError(undefined) !== 'unknown error') fail('formatError(undefined) should be readable')
console.log('✓ 错误文案对 Error / 字符串 / 对象都可读')

multiServer.closeAllConnections?.()
multiServer.close()
noRangeServer.closeAllConnections?.()
flakyServer.closeAllConnections?.()
flakyServer.close()
noRangeServer.close()

server.close()
rmSync(dir, { recursive: true, force: true })
console.log('\n✓ 下载器 14 项检查全部通过')
