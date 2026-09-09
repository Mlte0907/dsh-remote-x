import { strict as assert } from 'node:assert'
import { PolyfillInjectTransform, pickEncoding, shouldCompress, CompressTransform, DecompressTransform } from '../lib/compress.mjs'
import { UpstreamAgent } from '../lib/agent.mjs'
import { timingSafeEqualStr } from '../lib/timing-safe-equal.mjs'
import { ClientError, UnauthorizedError, UpstreamUnavailableError } from '../lib/errors.mjs'
import { TOKEN_CACHE_MS, LOG_TAIL_BYTES, BACKOFF_SCHEDULE, COMPRESS_MIN_BYTES } from '../lib/constants.mjs'

let passed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`) }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`) }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`) }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`) }
}

console.log('━━ P0 验证 ━━')

// constants
test('constants 导出正确值', () => {
  assert.equal(TOKEN_CACHE_MS, 5_000)
  assert.equal(LOG_TAIL_BYTES, 65_536)
  assert.deepEqual(BACKOFF_SCHEDULE, [1_000, 2_000, 4_000, 8_000, 16_000, 60_000])
  assert.equal(COMPRESS_MIN_BYTES, 1_024)
})

// timing-safe-equal
test('timingSafeEqualStr 等值返回 true', () => {
  assert.equal(timingSafeEqualStr('abc123', 'abc123'), true)
})
test('timingSafeEqualStr 不等值返回 false', () => {
  assert.equal(timingSafeEqualStr('abc123', 'abc456'), false)
})
test('timingSafeEqualStr 不等长返回 false', () => {
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false)
})

// errors
test('errors 携带正确 statusCode', () => {
  assert.equal(new ClientError().statusCode, 400)
  assert.equal(new UnauthorizedError().statusCode, 401)
  assert.equal(new UpstreamUnavailableError().statusCode, 502)
})

// pickEncoding
test('pickEncoding br 优先', () => {
  assert.equal(pickEncoding('gzip, br, deflate'), 'br')
})
test('pickEncoding gzip 回退', () => {
  assert.equal(pickEncoding('gzip, deflate'), 'gzip')
})
test('pickEncoding 不支持返回 null', () => {
  assert.equal(pickEncoding('identity'), null)
})

// shouldCompress
test('shouldCompress 文本+大体积→compress', () => {
  const r = shouldCompress({}, 'text/html', 'br', 10_000)
  assert.equal(r.compress, true)
  assert.equal(r.encoding, 'br')
})
test('shouldCompress 小体积→不压缩', () => {
  const r = shouldCompress({}, 'text/html', 'br', 100)
  assert.equal(r.compress, false)
})
test('shouldCompress 二进制→不压缩', () => {
  const r = shouldCompress({}, 'image/png', 'br', 10_000)
  assert.equal(r.compress, false)
})

// UpstreamAgent
test('UpstreamAgent 创建并暴露 agent', () => {
  const ua = new UpstreamAgent()
  assert.ok(ua.agent)
  assert.ok(ua.getConnectionStats)
  ua.destroy()
})

// PolyfillInjectTransform
await testAsync('PolyfillInjectTransform 注入 polyfill', async () => {
  const transform = new PolyfillInjectTransform('<script>TEST</script>')
  const chunks = []
  transform.on('data', (c) => chunks.push(c))
  transform.on('end', () => {})
  transform.write(Buffer.from('<html><head><title>Test</title></head><body></body></html>'))
  transform.end()
  await new Promise((r) => transform.on('end', r))
  const result = Buffer.concat(chunks).toString('utf8')
  assert.ok(result.includes('<script>TEST</script>'), 'polyfill should be injected')
  assert.ok(result.includes('<head><script>TEST</script>'), 'should be after <head>')
})

await testAsync('PolyfillInjectTransform 不重复注入', async () => {
  const transform = new PolyfillInjectTransform('<script>TEST</script>')
  const chunks = []
  transform.on('data', (c) => chunks.push(c))
  const html = '<html><head data-dsh-remote-x-polyfill="1"><title>Test</title></head></html>'
  transform.write(Buffer.from(html))
  transform.end()
  await new Promise((r) => transform.on('end', r))
  const result = Buffer.concat(chunks).toString('utf8')
  const count = (result.match(/<script>TEST<\/script>/g) || []).length
  assert.equal(count, 0, 'should not inject when marker already present')
})

// CompressTransform / DecompressTransform round-trip
await testAsync('Compress+Decompress gzip 往返', async () => {
  const original = 'Hello World! '.repeat(100)
  const compress = new CompressTransform('gzip')
  const decompress = new DecompressTransform('gzip')
  const compChunks = []
  compress.on('data', (c) => compChunks.push(c))
  compress.write(Buffer.from(original, 'utf8'))
  compress.end()
  await new Promise((r) => compress.on('end', r))
  const compressed = Buffer.concat(compChunks)
  assert.ok(compressed.length < original.length, 'compressed should be smaller')
  const decompChunks = []
  decompress.on('data', (c) => decompChunks.push(c))
  decompress.write(compressed)
  decompress.end()
  await new Promise((r) => decompress.on('end', r))
  const result = Buffer.concat(decompChunks).toString('utf8')
  assert.equal(result, original, 'round-trip should preserve original')
})

console.log(`\n通过 ${passed} 项验证`)