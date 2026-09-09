import { strict as assert } from 'node:assert'
import { PolyfillInjectTransform, pickEncoding, shouldCompress, CompressTransform, DecompressTransform } from '../lib/compress.mjs'
import { UpstreamAgent } from '../lib/agent.mjs'
import { timingSafeEqualStr } from '../lib/timing-safe-equal.mjs'
import { ClientError, UnauthorizedError, ForbiddenError, PayloadTooLargeError, UpstreamUnavailableError, ServerError } from '../lib/errors.mjs'
import { TunnelSupervisor, TunnelHealthChecker, TunnelMetrics, resolveTunnelRegion } from '../lib/tunnel-supervisor.mjs'
import { BACKOFF_SCHEDULE, HEALTH_CHECK_MAX_FAILURES, COMPRESS_MIN_BYTES, MAX_BODY_BYTES, QR_CACHE_MAX } from '../lib/constants.mjs'
import { Readable, Writable } from 'node:stream'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

let passed = 0, failed = 0
const tests = []
function test(name, fn) { tests.push({ name, fn: async () => fn() }) }
function testAsync(name, fn) { tests.push({ name, fn }) }

async function runAll() {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`) }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`) }
  }
  console.log(`\n━━ 结果 ━━`)
  console.log(`${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

console.log('━━ 12.1 工具类单元测试 ━━')

test('timingSafeEqual 等长相等', () => {
  assert.equal(timingSafeEqualStr('abc123', 'abc123'), true)
})
test('timingSafeEqual 等长不等值', () => {
  assert.equal(timingSafeEqualStr('abc123', 'abc124'), false)
})
test('timingSafeEqual 不等长', () => {
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false)
})
test('timingSafeEqual 空字符串', () => {
  assert.equal(timingSafeEqualStr('', ''), true)
  assert.equal(timingSafeEqualStr('', 'a'), false)
})
test('timingSafeEqual 耗时与内容无关', () => {
  const a = 'x'.repeat(64), b = 'y'.repeat(64), c = 'x'.repeat(63) + 'y'
  const t1 = Date.now(); timingSafeEqualStr(a, b); const d1 = Date.now() - t1
  const t2 = Date.now(); timingSafeEqualStr(a, c); const d2 = Date.now() - t2
  assert.ok(Math.abs(d1 - d2) <= 5, `耗时差 ${Math.abs(d1 - d2)}ms > 5ms`)
})

test('pickEncoding br 优先', () => { assert.equal(pickEncoding('gzip, br, deflate'), 'br') })
test('pickEncoding 仅 gzip', () => { assert.equal(pickEncoding('gzip'), 'gzip') })
test('pickEncoding 不支持返回 null', () => { assert.equal(pickEncoding(''), null); assert.equal(pickEncoding('deflate'), null) })
test('shouldCompress 文本+大体积', () => {
  const r = shouldCompress({ 'content-type': 'text/html' }, 'text/html', 'br', 10000)
  assert.equal(r.compress, true); assert.equal(r.encoding, 'br')
})
test('shouldCompress 小体积不压缩', () => {
  assert.equal(shouldCompress({ 'content-type': 'text/html' }, 'text/html', 'br', 100).compress, false)
})
test('shouldCompress 二进制不压缩', () => {
  assert.equal(shouldCompress({ 'content-type': 'image/png' }, 'image/png', 'br', 10000).compress, false)
})
test('shouldCompress 不支持编码', () => {
  assert.equal(shouldCompress({ 'content-type': 'text/html' }, 'text/html', null, 10000).compress, false)
})

test('ClientError statusCode=400', () => { assert.equal(new ClientError('x').statusCode, 400) })
test('UnauthorizedError statusCode=401', () => { assert.equal(new UnauthorizedError().statusCode, 401) })
test('ForbiddenError statusCode=403', () => { assert.equal(new ForbiddenError().statusCode, 403) })
test('PayloadTooLargeError statusCode=413', () => { assert.equal(new PayloadTooLargeError().statusCode, 413) })
test('UpstreamUnavailableError statusCode=502', () => { assert.equal(new UpstreamUnavailableError().statusCode, 502) })
test('ServerError statusCode=500', () => { assert.equal(new ServerError().statusCode, 500) })

console.log('\n━━ 12.2 网络层单元测试 ━━')

testAsync('CompressTransform+DecompressTransform gzip 往返', async () => {
  const original = '<html><body>' + 'A'.repeat(5000) + '</body></html>'
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await new Promise((resolve) => {
    Readable.from([Buffer.from(original)]).pipe(new CompressTransform('gzip')).pipe(new DecompressTransform('gzip')).pipe(sink)
    sink.on('finish', resolve)
  })
  assert.equal(Buffer.concat(chunks).toString(), original)
})

testAsync('CompressTransform+DecompressTransform br 往返', async () => {
  const original = '{"data":"' + 'X'.repeat(3000) + '"}'
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await new Promise((resolve) => {
    Readable.from([Buffer.from(original)]).pipe(new CompressTransform('br')).pipe(new DecompressTransform('br')).pipe(sink)
    sink.on('finish', resolve)
  })
  assert.equal(Buffer.concat(chunks).toString(), original)
})

testAsync('PolyfillInjectTransform 含 <head> 注入', async () => {
  const html = '<html><head><title>Test</title></head><body>hello</body></html>'
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await new Promise((resolve) => {
    Readable.from([Buffer.from(html)]).pipe(new PolyfillInjectTransform('/* POLYFILL */')).pipe(sink)
    sink.on('finish', resolve)
  })
  const result = Buffer.concat(chunks).toString()
  assert.ok(result.includes('/* POLYFILL */'))
  assert.ok(result.includes('<title>Test</title>'))
})

testAsync('PolyfillInjectTransform 不含 <head> 不注入', async () => {
  const html = '<div>no head here</div>'
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await new Promise((resolve) => {
    Readable.from([Buffer.from(html)]).pipe(new PolyfillInjectTransform('/* POLYFILL */')).pipe(sink)
    sink.on('finish', resolve)
  })
  assert.ok(!Buffer.concat(chunks).toString().includes('/* POLYFILL */'))
})

testAsync('PolyfillInjectTransform 跨 chunk 检测 <head>', async () => {
  const html = '<html><head><title>X</title></head><body>data</body></html>'
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await new Promise((resolve) => {
    Readable.from([Buffer.from(html.slice(0, 7)), Buffer.from(html.slice(7))]).pipe(new PolyfillInjectTransform('/* P */')).pipe(sink)
    sink.on('finish', resolve)
  })
  assert.ok(Buffer.concat(chunks).toString().includes('/* P */'))
})

testAsync('PolyfillInjectTransform 已含 marker 不重复注入', async () => {
  const html = '<html><head><script data-dsh-remote-x-polyfill></script><title>T</title></head><body>x</body></html>'
  const chunks = []
  const sink = new Writable({ write(c, _, cb) { chunks.push(c); cb() } })
  await new Promise((resolve) => {
    Readable.from([Buffer.from(html)]).pipe(new PolyfillInjectTransform('/* POLYFILL */')).pipe(sink)
    sink.on('finish', resolve)
  })
  const result = Buffer.concat(chunks).toString()
  assert.ok(!result.includes('/* POLYFILL */'), '已含 marker 不应注入')
})

testAsync('UpstreamAgent keep-alive 连接复用', async () => {
  const server = createServer((req, res) => { res.end('ok') })
  await new Promise(r => server.listen(0, r))
  const port = server.address().port
  const agent = new UpstreamAgent({ keepAlive: true, maxSockets: 4 })
  const http = await import('node:http')
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      const req = http.default.request(`http://127.0.0.1:${port}/`, { agent: agent.agent }, (res) => { res.resume(); res.on('end', resolve) })
      req.end()
    })
  }
  const stats = agent.getConnectionStats()
  assert.ok(stats.created <= 4, `created=${stats.created} 应 ≤4`)
  agent.destroy(); server.close()
})

testAsync('UpstreamAgent keepAlive=false 请求成功', async () => {
  const server = createServer((req, res) => { res.end('ok') })
  await new Promise(r => server.listen(0, r))
  const port = server.address().port
  const agent = new UpstreamAgent({ keepAlive: false })
  const http = await import('node:http')
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => {
      const req = http.default.request(`http://127.0.0.1:${port}/`, { agent: agent.agent }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { assert.equal(d, 'ok'); resolve() })
      })
      req.end()
    })
  }
  agent.destroy(); server.close()
})

console.log('\n━━ 12.3 隧道监管单元测试 ━━')

testAsync('TunnelSupervisor 正常启动→connected', async () => {
  const states = []
  const mockChild = new EventEmitter(); mockChild.kill = () => {}
  const sup = new TunnelSupervisor({ startChild: async () => ({ child: mockChild }), onStateChange: s => states.push(s), maxReconnect: 3 })
  await sup.start()
  assert.equal(sup.state, 'connected')
  sup.stop()
})

testAsync('TunnelSupervisor 主动 stop 不重连', async () => {
  const states = []
  const mockChild = new EventEmitter(); mockChild.kill = () => {}
  const sup = new TunnelSupervisor({ startChild: async () => ({ child: mockChild }), onStateChange: s => states.push(s), maxReconnect: 3 })
  await sup.start()
  sup.stop()
  assert.equal(sup.state, 'disconnected')
  assert.ok(!states.includes('reconnecting'))
})

testAsync('TunnelSupervisor child 异常退出触发重连', async () => {
  const states = []
  const sup = new TunnelSupervisor({
    startChild: async () => {
      const child = new EventEmitter(); child.kill = () => {}
      setTimeout(() => child.emit('exit', 1, null), 10)
      return { child }
    },
    onStateChange: s => states.push(s), maxReconnect: 3, healthCheckMs: 999999,
  })
  await sup.start()
  await new Promise(r => setTimeout(r, 200))
  assert.ok(states.includes('reconnecting'))
  sup.stop()
})

testAsync('TunnelSupervisor 重连耗尽→disconnected', async () => {
  const sup = new TunnelSupervisor({
    startChild: async () => {
      const child = new EventEmitter(); child.kill = () => {}
      setTimeout(() => child.emit('exit', 1, null), 5)
      return { child }
    },
    onStateChange: () => {}, maxReconnect: 1, healthCheckMs: 999999,
  })
  await sup.start()
  await new Promise(r => setTimeout(r, 2000))
  assert.equal(sup.state, 'disconnected')
  sup.stop()
})

test('TunnelHealthChecker 构造与初始值', () => {
  const hc = new TunnelHealthChecker({ probeUrl: 'http://127.0.0.1:9999', intervalMs: 1000, maxFailures: 3 })
  assert.equal(hc.getLatencyMs(), null); hc.stop()
})

test('TunnelMetrics 构造与初始值', () => {
  const m = new TunnelMetrics(0)
  assert.equal(m.getMetrics().totalStreams, 0); m.stop()
})

test('TunnelMetrics metricsPort=0 不启动', () => {
  const m = new TunnelMetrics(0); m.start(); assert.equal(m._timer, null); m.stop()
})

testAsync('resolveTunnelRegion 显式区域直返', async () => {
  assert.equal(await resolveTunnelRegion('ap'), 'ap')
  assert.equal(await resolveTunnelRegion('us'), 'us')
  assert.equal(await resolveTunnelRegion('eu'), 'eu')
})

testAsync('resolveTunnelRegion auto 回退', async () => {
  const r = await resolveTunnelRegion('auto')
  assert.ok(['auto', 'ap', 'us', 'eu'].includes(r))
})

console.log('\n━━ 12.4 前端渲染单元测试（DOM mock）━━')

function createClientClasses() {
  function DisposableRegistry() {
    var items = []
    this.register = function(r) { items.push(r); return r }
    this.registerTimer = function(id) { items.push({ dispose: function() { clearTimeout(id); clearInterval(id) } }); return id }
    this.registerListener = function(target, type, listener, opts) {
      target.addEventListener(type, listener, opts)
      items.push({ dispose: function() { target.removeEventListener(type, listener, opts) } })
      return listener
    }
    this.disposeAll = function() {
      for (var i = items.length - 1; i >= 0; i--) {
        try { var r = items[i]
          if (r && typeof r.dispose === 'function') r.dispose()
          else if (r && typeof r.unsubscribe === 'function') r.unsubscribe()
          else if (r && typeof r.disconnect === 'function') r.disconnect()
          else if (r && typeof r.close === 'function') r.close()
        } catch(e) {}
      }
      items = []
    }
    this.size = function() { return items.length }
  }
  function IncrementalRenderer(container) {
    var prevSig = null, prevStatus = null
    this.update = function(sig, statusMap, fullRender) {
      if (sig !== prevSig) { fullRender(); prevSig = sig; prevStatus = statusMap; return }
      prevStatus = statusMap
    }
    this.reset = function() { prevSig = null; prevStatus = null }
    this.dispose = function() {}
  }
  function VirtualList(container, opts) {
    var itemHeight = opts.itemHeight || 60, bufferSize = opts.bufferSize || 10
    var items = [], lastStart = -1, lastEnd = -1
    var topSpacer = { style: {} }, content = { innerHTML: '' }, bottomSpacer = { style: {} }
    container.appendChild(topSpacer); container.appendChild(content); container.appendChild(bottomSpacer)
    function renderVisible() {
      var scrollTop = container.scrollTop
      var visibleStart = Math.floor(scrollTop / itemHeight)
      var visibleCount = Math.ceil(container.clientHeight / itemHeight)
      var startIdx = Math.max(0, visibleStart - bufferSize)
      var endIdx = Math.min(items.length, visibleStart + visibleCount + bufferSize)
      if (startIdx === lastStart && endIdx === lastEnd) return
      lastStart = startIdx; lastEnd = endIdx
      topSpacer.style.height = (startIdx * itemHeight) + 'px'
      bottomSpacer.style.height = Math.max(0, (items.length - endIdx) * itemHeight) + 'px'
      var html = ''
      for (var i = startIdx; i < endIdx; i++) html += opts.renderItem(items[i], i)
      content.innerHTML = html
    }
    container.addEventListener('scroll', function() {}, { passive: true })
    this.setItems = function(newItems) { items = newItems; lastStart = -1; lastEnd = -1; renderVisible() }
    this.scrollTo = function(index) { container.scrollTop = index * itemHeight }
    this.dispose = function() { container.removeEventListener('scroll') }
  }
  return { DisposableRegistry, IncrementalRenderer, VirtualList }
}

test('DisposableRegistry register+disposeAll', () => {
  const { DisposableRegistry } = createClientClasses()
  let disposed = 0, unsubbed = 0, disconnected = 0
  const dr = new DisposableRegistry()
  dr.register({ dispose: () => { disposed++ } })
  dr.register({ dispose: () => { unsubbed++ } })
  dr.register({ disconnect: () => { disconnected++ } })
  dr.disposeAll()
  assert.equal(disposed, 1); assert.equal(unsubbed, 1); assert.equal(disconnected, 1)
})

testAsync('DisposableRegistry registerTimer 清理', async () => {
  const { DisposableRegistry } = createClientClasses()
  const dr = new DisposableRegistry()
  let fired = false
  dr.registerTimer(setTimeout(() => { fired = true }, 10000))
  dr.disposeAll()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(fired, false)
})

test('DisposableRegistry registerListener', () => {
  const { DisposableRegistry } = createClientClasses()
  const dr = new DisposableRegistry()
  let calls = 0
  const target = { _l: {}, addEventListener(t, l) { this._l[t] = l }, removeEventListener(t) { this._l[t] = null } }
  dr.registerListener(target, 'click', () => { calls++ })
  target._l.click()
  assert.equal(calls, 1)
  dr.disposeAll()
  assert.equal(target._l.click, null)
})

test('IncrementalRenderer 结构变化→全量重建', () => {
  const { IncrementalRenderer } = createClientClasses()
  let count = 0
  const ir = new IncrementalRenderer({ querySelector: () => null })
  ir.update('sig1', {}, () => { count++ })
  ir.update('sig2', {}, () => { count++ })
  assert.equal(count, 2)
})

test('IncrementalRenderer 结构不变→跳过全量', () => {
  const { IncrementalRenderer } = createClientClasses()
  let count = 0
  const ir = new IncrementalRenderer({ querySelector: () => null })
  ir.update('sig1', { s1: { running: true, blank: false, state: 'run' } }, () => { count++ })
  ir.update('sig1', { s1: { running: true, blank: false, state: 'run' } }, () => { count++ })
  assert.equal(count, 1)
})

test('VirtualList setItems 渲染可见区域', () => {
  const { VirtualList } = createClientClasses()
  const container = { scrollTop: 0, clientHeight: 600, children: [], appendChild(c) { this.children.push(c) }, addEventListener() {}, removeEventListener() {} }
  const items = Array.from({ length: 200 }, (_, i) => ({ id: 's' + i, title: 'Task ' + i }))
  const vl = new VirtualList(container, { itemHeight: 60, bufferSize: 5, renderItem: s => `<div>${s.title}</div>` })
  vl.setItems(items)
  assert.ok(container.children.length >= 3)
  vl.dispose()
})

await runAll()
