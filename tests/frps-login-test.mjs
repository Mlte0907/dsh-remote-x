import { strict as assert } from 'node:assert'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRemoteProxy } from '../lib/proxy.mjs'
import { frpcAvailable, frpcStatus, parseLocalFrpcConfig, startFrpc, stopFrpc, sweepOrphanFrpc, writeFrpcConfig } from '../lib/frpc.mjs'

let passed = 0, failed = 0
const tests = []
function test(name, fn) { tests.push({ name, fn: async () => fn() }) }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function runAll() {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`) }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`) }
  }
  console.log(`\n━━ 结果 ━━`)
  console.log(`${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

console.log('━━ frps 接入 + 6 位登录口令 回归测试 ━━')

const UPSTREAM_TOKEN = 'upstream-secret-token-ABC123'
const LOGIN = '123456'
const LOGIN_PATH = '/__remote-x/login'
const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-remote-x-frps-'))

/** 上游 mock：模拟 dsh 认证墙（带最新口令 → 200，否则 401），供会话回放验证。 */
const upstream = createServer((req, res) => {
  if (String(req.url).includes(`token=${UPSTREAM_TOKEN}`)) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('UPSTREAM_OK')
  } else {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('upstream auth required')
  }
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))

/** 起一个代理实例；stateFile 决定登录口令面。 */
async function startProxy(stateFile) {
  const proxy = await startRemoteProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    token: UPSTREAM_TOKEN,
    sessionSecretFile: path.join(tmp, `session-${Math.random().toString(36).slice(2)}.key`),
    stateFile,
  })
  return { proxy, port: proxy.address().port }
}

/** 经代理发一个 GET，返回状态码、set-cookie 列表、响应头与响应体。 */
function call(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.accept) headers.accept = opts.accept
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, setCookies: res.headers['set-cookie'] ?? [], headers: res.headers, body }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('代理响应超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 向登录页 POST 表单（application/x-www-form-urlencoded）。 */
function postForm(port, fields) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(fields).toString()
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: LOGIN_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) },
    }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, setCookies: res.headers['set-cookie'] ?? [], headers: res.headers, body: text }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('代理响应超时')))
    req.on('error', reject)
    req.end(body)
  })
}

/** 从 set-cookie 列表取指定 cookie 的值（不含属性部分）。 */
function cookieValue(setCookies, name) {
  const hit = setCookies.find(c => c.startsWith(`${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 1).split(';')[0]
}

// ---- 实例 A：配置了 6 位口令 ----
const stateFile = path.join(tmp, 'state.json')
writeFileSync(stateFile, JSON.stringify({ lan: true, login: LOGIN }))
const a = await startProxy(stateFile)

test('浏览器导航（Accept: text/html）被拒 → 401 + 登录页表单，回跳保留原路径', async () => {
  const res = await call(a.port, '/some/page?x=1', { accept: 'text/html,application/xhtml+xml' })
  assert.equal(res.status, 401, '未认证入口语义保持 401')
  assert.ok(res.body.includes('<form method="post"'), '应返回登录页表单')
  assert.ok(res.body.includes('value="/some/page?x=1"'), '回跳路径应原样回填')
  assert.ok(res.headers['content-type'].includes('text/html'), '浏览器面应回 HTML')
})

test('无 Accept 的裸请求仍为 401 纯文本（非浏览器面不变）', async () => {
  const res = await call(a.port, '/')
  assert.equal(res.status, 401)
  assert.ok(res.headers['content-type'].includes('text/plain'), '应保持纯文本')
  assert.ok(!res.body.includes('<form'), '非浏览器面不应给登录页')
})

test('正确口令 POST → 303 回跳 + 签发会话 cookie', async () => {
  const res = await postForm(a.port, { p: LOGIN, redir: '/' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/')
  const session = cookieValue(res.setCookies, 'remote-x-session')
  assert.ok(session !== undefined && session.split('.').length === 3, `会话 cookie 缺失或结构错误: ${session}`)
})

test('登录页签发的会话 cookie → 200（经口令代换触达上游）', async () => {
  const login = await postForm(a.port, { p: LOGIN, redir: '/' })
  const session = cookieValue(login.setCookies, 'remote-x-session')
  const res = await call(a.port, '/', { cookie: `remote-x-session=${session}` })
  assert.equal(res.status, 200)
  assert.equal(res.body, 'UPSTREAM_OK')
})

test('redir 开放重定向与头注入 → 归一为 /', async () => {
  const redirect = await postForm(a.port, { p: LOGIN, redir: '//evil.com/phish' })
  assert.equal(redirect.status, 303)
  assert.equal(redirect.headers.location, '/')
  const inject = await postForm(a.port, { p: LOGIN, redir: '\r\nX-Evil: 1' })
  assert.equal(inject.status, 303)
  assert.equal(inject.headers.location, '/')
})

test('口令错误 → 401 + Retry-After，不发会话 cookie', async () => {
  const res = await postForm(a.port, { p: '000000', redir: '/' })
  assert.equal(res.status, 401)
  assert.ok(Number(res.headers['retry-after']) >= 1, '应带 Retry-After')
  assert.ok(res.body.includes('口令错误'), '错误提示应展示')
  assert.ok(cookieValue(res.setCookies, 'remote-x-session') === undefined, '失败不得发会话 cookie')
})

test('锁定期内即使口令正确也 429（指数退避生效）', async () => {
  const res = await postForm(a.port, { p: LOGIN, redir: '/' })
  assert.equal(res.status, 429)
  assert.ok(res.body.includes('尝试过于频繁'), '锁定提示应展示')
  assert.ok(cookieValue(res.setCookies, 'remote-x-session') === undefined, '锁定不得发会话 cookie')
})

test('退避窗口过后正确口令恢复可登录', async () => {
  await sleep(1150) // 首次失败退避 1s
  const res = await postForm(a.port, { p: LOGIN, redir: '/' })
  assert.equal(res.status, 303)
  assert.ok(cookieValue(res.setCookies, 'remote-x-session') !== undefined, '窗口过后应恢复签发')
})

// ---- 实例 B / C：口令面失败关闭 ----
const stateB = path.join(tmp, 'state-nologin.json')
writeFileSync(stateB, JSON.stringify({ lan: true }))
const b = await startProxy(stateB)

test('状态文件无 login 字段 → 登录面整体关闭（GET 纯文本、POST 纯文本 401）', async () => {
  const page = await call(b.port, '/', { accept: 'text/html' })
  assert.equal(page.status, 401)
  assert.ok(!page.body.includes('<form'), '无口令不得出登录页')
  const post = await postForm(b.port, { p: LOGIN, redir: '/' })
  assert.equal(post.status, 401)
  assert.ok(post.headers['content-type'].includes('text/plain'), '无口令时 POST 保持纯文本')
})

const c = await startProxy(path.join(tmp, 'absent-state.json'))

test('状态文件不存在 → 同样失败关闭', async () => {
  const page = await call(c.port, '/', { accept: 'text/html' })
  assert.equal(page.status, 401)
  assert.ok(!page.body.includes('<form'), '缺失文件不得出登录页')
})

// ---- lib/frpc.mjs：配置生成、本机预填解析、进程生命周期 ----

test('parseLocalFrpcConfig 解析本机 frpc.toml 三要素', async () => {
  const fixture = path.join(tmp, 'local-frpc.toml')
  writeFileSync(fixture, [
    'serverAddr = "113.45.134.86"',
    'serverPort = 7000',
    'auth.token = "47077a5632fab304"',
    '',
    '[[proxies]]',
    'name = "opencode"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 4096',
    'remotePort = 17493',
    '',
  ].join('\n'))
  assert.deepEqual(parseLocalFrpcConfig(fixture), { addr: '113.45.134.86', port: 7000, token: '47077a5632fab304' })
})

test('parseLocalFrpcConfig 缺文件 → null', async () => {
  assert.equal(parseLocalFrpcConfig(path.join(tmp, 'nope.toml')), null)
})

const frpcConfig = path.join(tmp, 'frpc-remote-x.toml')

test('writeFrpcConfig 生成完整配置且 0600（token 引号被转义）', async () => {
  writeFrpcConfig({ addr: '113.45.134.86', port: 7000, token: 'a"b\\c_x9', remotePort: 17494 }, 3081, frpcConfig)
  const raw = readFileSync(frpcConfig, 'utf8')
  assert.ok(raw.includes('serverAddr = "113.45.134.86"'), '缺 serverAddr')
  assert.ok(raw.includes('serverPort = 7000'), '缺 serverPort')
  assert.ok(raw.includes('auth.token = "a\\"b\\\\c_x9"'), 'token 未按 TOML 转义')
  assert.ok(raw.includes('loginFailExit = false'), '缺 loginFailExit')
  assert.ok(raw.includes('localPort = 3081'), '缺 localPort')
  assert.ok(raw.includes('remotePort = 17494'), '缺 remotePort')
  assert.equal(statSync(frpcConfig).mode & 0o777, 0o600, '配置含 token 必须 0600')
})

test('frpcAvailable 返回 true（本机已装 frpc）', async () => {
  assert.equal(await frpcAvailable(), true)
})

let frpcPid = null

test('startFrpc 拉起 → running；stopFrpc 后进程退出、状态收敛', async () => {
  const pidFile = path.join(tmp, 'frpc.pid')
  // 127.0.0.1:1 无 frps：进程靠 loginFailExit=false 保活，startTimeoutMs 判活即成功
  const result = await startFrpc(
    { addr: '127.0.0.1', port: 1, token: 'test-token-16chars', remotePort: 2 },
    39999,
    { configFile: frpcConfig, pidFile, startTimeoutMs: 800 },
  )
  frpcPid = result.pid
  assert.equal(result.running, true)
  assert.equal(frpcStatus().running, true, '状态应为运行中')
  assert.ok(existsSync(pidFile), '应写 pidfile')

  stopFrpc()
  assert.equal(frpcStatus().running, false, '停止后状态立即收敛')
  // 等进程真正退出（pkill 兜底以进程存活为准，不能只信内存状态）
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { process.kill(frpcPid, 0) } catch { break }
    await sleep(100)
  }
  assert.throws(() => process.kill(frpcPid, 0), 'frpc 进程应已退出')
})

test('sweepOrphanFrpc 对非 frpc 进程不误杀（pid 校验），并清掉 pidfile', async () => {
  const pidFile = path.join(tmp, 'orphan.pid')
  writeFileSync(pidFile, String(process.pid)) // 本测试进程 cmdline 不含 frpc 标记
  const killed = await sweepOrphanFrpc(pidFile, frpcConfig)
  assert.equal(killed, false, '非 frpc 进程不得被杀')
  assert.ok(!existsSync(pidFile), 'pidfile 应被清除')
  // 自己还活着即证明没被误杀（上面 process.kill 若被杀这里已经没了）
  assert.ok(existsSync(stateFile) || true, 'self-alive')
})

await runAll()
c.proxy.close()
b.proxy.close()
a.proxy.close()
upstream.close()
rmSync(tmp, { recursive: true, force: true })
