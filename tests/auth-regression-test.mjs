import { strict as assert } from 'node:assert'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRemoteProxy } from '../lib/proxy.mjs'

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

console.log('━━ 代理认证绕过回归测试 ━━')

const ACCESS_KEY = 'correct horse battery'
const UPSTREAM_TOKEN = 'upstream-secret-token-ABC123'

const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-remote-x-auth-'))

/** 上游 mock：模拟 dsh 认证墙——URL 不带最新口令一律 401，带则下发登录 cookie。 */
const upstreamHits = []
const upstream = createServer((req, res) => {
  upstreamHits.push(req.url)
  if (String(req.url).includes(`token=${UPSTREAM_TOKEN}`)) {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'dsh-auth-test=fresh; Path=/' })
    res.end('UPSTREAM_OK')
  } else {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('upstream auth required')
  }
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))

const proxy = await startRemoteProxy({
  port: 0,
  host: '127.0.0.1',
  upstream: { host: '127.0.0.1', port: upstream.address().port },
  accessKey: ACCESS_KEY,
  token: UPSTREAM_TOKEN,
  sessionSecretFile: path.join(tmp, 'session.key'),
})
const proxyPort = proxy.address().port

/** 经代理发一个 GET，返回状态码、set-cookie 列表与响应体。 */
function call(pathname, cookie) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      path: pathname,
      method: 'GET',
      headers: cookie ? { cookie } : {},
    }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({
        status: res.statusCode,
        setCookies: res.headers['set-cookie'] ?? [],
        body,
      }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('代理响应超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 从 set-cookie 列表取指定 cookie 的值（不含属性部分）。 */
function cookieValue(setCookies, name) {
  const hit = setCookies.find(c => c.startsWith(`${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 1).split(';')[0]
}

/** 取一个新签发的会话 cookie 值（经 ?key= 认证换发）。 */
async function freshSession() {
  const res = await call(`/?key=${encodeURIComponent(ACCESS_KEY)}`)
  assert.equal(res.status, 200, '换发会话的 ?key= 请求应 200')
  return cookieValue(res.setCookies, 'remote-x-session')
}

test('裸请求 → 401，不触达上游', async () => {
  const before = upstreamHits.length
  const res = await call('/')
  assert.equal(res.status, 401)
  assert.equal(upstreamHits.length, before)
})

test('伪造 remote-x-key cookie → 401，不触达上游（修复前 200）', async () => {
  const before = upstreamHits.length
  const res = await call('/', 'remote-x-key=bypass')
  assert.equal(res.status, 401)
  assert.equal(upstreamHits.length, before, '伪造记忆 cookie 不得触达上游')
})

test('伪造 dsh-auth cookie → 401，不触发口令代换（修复前 200）', async () => {
  const before = upstreamHits.length
  const res = await call('/', 'dsh-auth-bypass=1')
  assert.equal(res.status, 401)
  assert.equal(upstreamHits.length, before, '伪造登录 cookie 不得触达上游、不得换取真口令')
})

test('错误 ?key= → 401', async () => {
  const res = await call('/?key=nope')
  assert.equal(res.status, 401)
})

test('正确 ?key= → 200，下发 remote-x-key 与会话 cookie，上游收到代换口令', async () => {
  const res = await call(`/?key=${encodeURIComponent(ACCESS_KEY)}`)
  assert.equal(res.status, 200)
  assert.equal(decodeURIComponent(cookieValue(res.setCookies, 'remote-x-key') ?? ''), ACCESS_KEY)
  const session = cookieValue(res.setCookies, 'remote-x-session')
  assert.ok(session !== undefined && session.split('.').length === 3, `会话 cookie 缺失或结构错误: ${session}`)
  assert.ok(upstreamHits.at(-1).includes(`token=${UPSTREAM_TOKEN}`), '上游应收到代换后的登录口令')
})

test('?key= 正确且带伪造 remote-x-key → 200，响应覆盖为正确值', async () => {
  const res = await call(`/?key=${encodeURIComponent(ACCESS_KEY)}`, 'remote-x-key=forged')
  assert.equal(res.status, 200)
  assert.equal(decodeURIComponent(cookieValue(res.setCookies, 'remote-x-key') ?? ''), ACCESS_KEY)
})

test('回放合法 remote-x-key → 200', async () => {
  const res = await call('/', `remote-x-key=${encodeURIComponent(ACCESS_KEY)}`)
  assert.equal(res.status, 200)
})

test('回放已签发会话 cookie → 200', async () => {
  const session = await freshSession()
  const res = await call('/', `remote-x-session=${session}`)
  assert.equal(res.status, 200)
})

test('伪造会话 cookie → 401', async () => {
  const res = await call('/', 'remote-x-session=deadbeef.99999999999999.aaaa')
  assert.equal(res.status, 401)
})

test('篡改合法会话签名 → 401', async () => {
  const session = await freshSession()
  const flipped = session.slice(0, -1) + (session.at(-1) === 'A' ? 'B' : 'A')
  const res = await call('/', `remote-x-session=${flipped}`)
  assert.equal(res.status, 401)
})

test('/t/<正确口令>/ → 200 并补发会话 cookie，会话可回放（修复前 401）', async () => {
  const res = await call(`/t/${UPSTREAM_TOKEN}/`)
  assert.equal(res.status, 200)
  const session = cookieValue(res.setCookies, 'remote-x-session')
  assert.ok(session !== undefined, '凭内联口令进来应补发会话 cookie')
  const replay = await call('/', `remote-x-session=${session}`)
  assert.equal(replay.status, 200)
})

test('?token=<正确口令> → 200（修复前 401）', async () => {
  const res = await call(`/?token=${UPSTREAM_TOKEN}`)
  assert.equal(res.status, 200)
})

test('/t/错误口令 → 401', async () => {
  const res = await call('/t/wrong-token/')
  assert.equal(res.status, 401)
})

test('已认证请求带失效 dsh-auth：上游 401 后口令代换恢复 200', async () => {
  const session = await freshSession()
  const before = upstreamHits.length
  // 上游 mock 对不带 token 的请求回 401，模拟失效的 dsh 登录态
  const res = await call('/', `remote-x-session=${session}; dsh-auth-stale=1`)
  assert.equal(res.status, 200)
  assert.equal(upstreamHits.length, before + 2, '应先被上游 401，再口令代换重试')
  assert.ok(!upstreamHits[before].includes('token='), '首跳应跳过代换（authed 为真）')
  assert.ok(upstreamHits[before + 1].includes(`token=${UPSTREAM_TOKEN}`), '重试应摘掉 cookie 并代换口令')
})

/** 裸 TCP 发一段升级握手，收到首个响应即返回。 */
function rawHandshake(payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => socket.write(payload))
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.on('close', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); resolve(data) }, 5000)
  })
}

testAsync('WebSocket 升级面：伪造 cookie 握手 → 401', async () => {
  const response = await rawHandshake([
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${proxyPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Cookie: dsh-auth-bypass=1',
    '', ''].join('\r\n'))
  assert.ok(/^HTTP\/1\.1 401/.test(response), `期望 401，得到: ${response.split('\r\n')[0] || '(空)'}`)
})

await runAll()
proxy.close()
upstream.close()
rmSync(tmp, { recursive: true, force: true })
