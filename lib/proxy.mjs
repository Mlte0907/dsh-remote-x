// dsh-remote-x 网络层：Host/Origin 改写反向代理（+ 固定访问口令）
//
// 为什么需要它（学自 dsh-pocket）：
// dsh web 的浏览器信任栅栏只认 loopback（127.0.0.1）或 `--trusted-host` 白名单，
// 官方禁用 0.0.0.0 绑定——防止把"能执行代码的 web"直接暴露到网络。
// 本代理把入站请求的 Host / Origin 统一改写成 loopback 权威后转发给本机 dsh web，
// 于是栅栏永远看到 loopback：
//   - 局域网：手机访问 http://<电脑IP>:<代理端口>
//   - 公网：cloudflared 等隧道指到本代理，任意域名都能进
// 全程不需要改动 dsh 的任何配置，也不另起第二个 harness 实例（避免会话并发写）。
//
// 固定访问口令（accessKey）解决 dsh 登录口令每次重启都变的问题：
//   - 手机 URL 固定为 ?key=<口令>，书签/二维码永不过期
//   - proxy 校验 key 后，动态读取 dsh 启动日志里最新的登录口令并代换转发，
//     dsh 正常下发认证 cookie；后端重启对手机完全无感
//   - 已登录设备（带 dsh-auth-* cookie）与记忆设备（remote-x-key cookie）直接放行
//
// 透传保证：普通请求与 WebSocket / SSE（流式推送）都原样转发，
// 手机上看到的流式效果与桌面端一致。

import { createServer, request as httpRequest } from 'node:http'
import { createGzip } from 'node:zlib'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { TOKEN_CACHE_MS, LOG_TAIL_BYTES, REMEMBER_COOKIE_MAX_AGE, UPSTREAM_HEADER_TIMEOUT_MS } from './constants.mjs'
import { UpstreamAgent } from './agent.mjs'
import { PolyfillInjectTransform, pickEncoding, DecompressTransform } from './compress.mjs'
import { timingSafeEqualStr } from './timing-safe-equal.mjs'

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 }
const REMEMBER_COOKIE = 'remote-x-key'
const TOKEN_RE = /token=([A-Za-z0-9_-]+)/g

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，dsh 连接层会用：
 *   1. crypto.randomUUID —— 缺了 mint RPC id 直接抛错；
 *   2. AbortSignal.any —— 老版本 Android WebView 没有，消息发不出去。
 * 带 data-dsh-remote-x-polyfill 标记做判重，避免页面里恰好出现同名字串时误判。
 */
export const POLYFILL = `<script data-dsh-remote-x-polyfill="1">!function(){try{
if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}
if(typeof AbortSignal!=="undefined"&&!AbortSignal.any){AbortSignal.any=function(signals){var c=new AbortController();var list=signals||[];for(var i=0;i<list.length;i++){var s=list[i];if(!s)continue;if(s.aborted){c.abort(s.reason);break;}s.addEventListener&&s.addEventListener("abort",function(){c.abort(s.reason);});}return c.signal;};}
if(typeof AbortSignal!=="undefined"&&!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new Error("Timeout"));},ms);return c.signal;};}
if(!Array.prototype.at){Array.prototype.at=function(n){var l=this.length;n=Math.trunc(n)||0;if(n<0)n+=l;if(n<0||n>=l)return undefined;return this[n];};}
if(typeof self.structuredClone==="undefined"){self.structuredClone=function(o){return JSON.parse(JSON.stringify(o));};}
}catch(e){}}();</script>`

/* ---------------- dsh 登录口令动态读取（5s 缓存） ---------------- */

let tokenCache = { value: undefined, at: 0 }

/** 扫描 dsh 启动日志尾部，取最新一次打印的 `?token=` 登录口令。 */
async function readDshToken(tokenFile) {
  if (Date.now() - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.value
  let value
  try {
    const handle = await open(tokenFile, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - LOG_TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      const matches = [...buf.toString('utf8').matchAll(TOKEN_RE)]
      value = matches.at(-1)?.[1]
    } finally {
      await handle.close()
    }
  } catch {
    value = undefined
  }
  tokenCache = { value, at: Date.now() }
  return value
}

/** dsh 默认启动日志路径（desktop/systemd 部署）；不存在则返回 undefined。 */
export function defaultTokenFile() {
  const p = path.join(homedir(), '.dsh', 'desktop', 'backend.log')
  return p
}

function cookieHas(headers, prefix) {
  const raw = headers.cookie
  if (typeof raw !== 'string') return false
  return raw.split(';').some(c => c.trim().startsWith(prefix))
}

/** 把 set-cookie 值合并进（可能为数组的）响应头，返回新头对象。 */
function mergeSetCookie(headers, extra) {
  const existing = headers['set-cookie']
  const list = Array.isArray(existing) ? [...existing] : existing ? [existing] : []
  list.push(extra)
  return { ...headers, 'set-cookie': list }
}

/* ---------------- 头部改写 ---------------- */

/** 把入站请求头改写成 loopback 权威，并去掉压缩以便注入/改写响应体。 */
function rewriteRequestHeaders(headers, upstream) {
  const out = { ...headers }
  out.host = `${upstream.host}:${upstream.port}`
  if (out.origin) out.origin = `http://${upstream.host}:${upstream.port}`
  if (out.referer) {
    out.referer = String(out.referer).replace(
      /^https?:\/\/[^/]+/,
      `http://${upstream.host}:${upstream.port}`,
    )
  }
  delete out['content-length']
  return out
}

/** 把上游响应头里的绝对地址改回对外可访问的形式。 */
function rewriteResponseHeaders(headers, upstream) {
  const out = { ...headers }
  const upstreamAuthority = `${upstream.host}:${upstream.port}`
  for (const key of ['location', 'content-location', 'referer']) {
    const value = out[key]
    if (typeof value === 'string' && value.includes(upstreamAuthority)) {
      out[key] = value.replace(new RegExp(`https?://${upstreamAuthority.replace('.', '\\.')}`, 'g'), '')
    }
  }
  delete out['content-length']
  delete out['transfer-encoding']
  delete out['content-security-policy']
  return out
}

/** 是否值得注入 polyfill（只处理 HTML 文档）。 */
function isHtml(headers) {
  return /text\/html/i.test(String(headers['content-type'] ?? ''))
}

/**
 * 给 upgrade 拿到的裸 socket 挂上 'error' 兜底。
 *
 * `upgrade` 事件交出的是裸 `net.Socket`，不是 `ServerResponse`：Node 的 http
 * 服务器只替普通请求的 socket 挂了 error 监听，upgrade 路径完全由我们自己负责。
 * 漏挂的后果不是"这条连接报个错"，而是整个进程被 Node 结束——对端用一个 RST
 * 回应我们刚写的 401/500/502 响应时，错误事件无人接管，Node 直接
 * `throw er; // Unhandled 'error' event` 并 exit 1（实测复现，堆栈与生产崩溃逐字节一致）。
 *
 * 认证失败与上游不可达恰恰是最常见的两条路径，它们都只写一个响应就返回，
 * 覆盖不到"成功升级后"才建立的 pipe 级监听（见本函数调用点下方的 cleanup）。
 * 因此兜底必须挂在 handler 入口，而不是散落在各分支里。
 *
 * destroy() 幂等，与成功分支自己的 cleanup 并存无副作用。
 *
 * @param socket 本次 upgrade 的客户端裸 socket
 */
function guardUpgradeSocket(socket) {
  socket.on('error', () => socket.destroy())
}

function injectPolyfill(html) {
  if (html.includes('data-dsh-remote-x-polyfill')) return html
  return html.replace(/<head([^>]*)>/i, `<head$1>${POLYFILL}`)
}

/**
 * 在转发 URL 上追加 dsh 登录口令（先清掉可能残留的旧 token）。
 * 纯字符串操作：`new URL()` 会破坏 DSH 的 `??` 拼接格式。
 */
function withToken(raw, token) {
  let out = raw.replace(/([?&])token=[^&]*/g, '$1')
  out = out.replace(/\?&/, '?').replace(/&&+/g, '&').replace(/[?&]$/, '')
  return out + (out.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

/* ---------------- 启动反代 ---------------- */

/**
 * 启动反代。
 * @param {object} options
 * @param {number} options.port 对外监听端口
 * @param {string} [options.host] 对外监听地址，默认 0.0.0.0（手机/隧道可达）
 * @param {{host: string, port: number}} [options.upstream] dsh web 地址
 * @param {string} [options.accessKey] 固定访问口令（?key=）；设置后未携带且未登录的请求 401
 * @param {string} [options.token] dsh 登录口令（进程内直传，优先于 tokenFile）
 * @param {string} [options.tokenFile] dsh 启动日志路径（用于动态代换最新登录口令）
 * @param {(info: object) => void} [options.onError]
 * @returns {Promise<import('node:http').Server>}
 */
export function startRemoteProxy(options) {
  const upstream = options.upstream ?? DEFAULT_UPSTREAM
  const accessKey = typeof options.accessKey === 'string' && options.accessKey.length > 0
    ? options.accessKey
    : undefined
  // 宿主插件在进程内直接托管代理时，能拿到权威的登录口令，无需扫日志。
  // 未直传时沿用原来的日志扫描（CLI / systemd 部署）。
  const staticToken = typeof options.token === 'string' && options.token.length > 0
    ? options.token
    : undefined
  const tokenFile = options.tokenFile
  const upstreamAgent = new UpstreamAgent(options.upstreamAgent ?? {})

  /** 校验请求的 key / 记忆 cookie / dsh 登录态，返回 URL 改写结果或 401 响应。 */
  async function gate(req) {
    let raw = req.url ?? '/'
    const authed = cookieHas(req.headers, 'dsh-auth-')
    const remembered = cookieHas(req.headers, `${REMEMBER_COOKIE}=`)
    // path 形式（Edge 等浏览器扫码会剥离 URL 查询参数，path 不会被清洗）：
    //   /k/<key>/rest…  固定访问口令
    //   /t/<token>/rest…  一次性 dsh 登录口令（设置页二维码）
    let pathKey
    let pathToken
    const km = /^\/k\/([^/]+)(\/[\s\S]*)?$/.exec(raw)
    if (km !== null) {
      pathKey = decodeURIComponent(km[1])
      raw = km[2] ?? '/'
    } else {
      const tm = /^\/t\/([^/]+)(\/[\s\S]*)?$/.exec(raw)
      if (tm !== null) {
        pathToken = decodeURIComponent(tm[1])
        raw = tm[2] ?? '/'
      }
    }
    // 快速检查 ?key= 是否匹配（避免对所有请求做完整 URL 解析）。
    // 比较走 timing-safe：accessKey 是长期固定口令，成本为零的保险。
    const keyMatch = accessKey !== undefined ? /[?&]key=([^&]*)/.exec(raw) : null
    const keyOk = accessKey !== undefined
      && ((keyMatch !== null && timingSafeEqualStr(decodeURIComponent(keyMatch[1]), accessKey))
        || (pathKey !== undefined && timingSafeEqualStr(pathKey, accessKey)))
    // 设置页二维码走 dsh 登录口令（?token= 或 /t/<token>/）：与启动日志最新口令一致才放行
    let tokenOk = false
    if (!keyOk && !authed && !remembered) {
      const tokenMatch = /[?&]token=([^&]*)/.exec(raw)
      let provided = pathToken
      if (provided === undefined && tokenMatch !== null) {
        provided = decodeURIComponent(tokenMatch[1].replace(/\+/g, ' '))
      }
      if (provided !== undefined && provided.length > 0) {
        const latest = await readDshToken(tokenFile)
        tokenOk = latest !== undefined && timingSafeEqualStr(provided, latest)
      }
      if (!tokenOk) return { denied: true }
    }
    // 原始字符串操作：避免 new URL() 破坏 DSH 的 ?? 拼接格式
    let out = raw
    // 删除 ?key= 或 &key=
    out = out.replace(/[?&]key=[^&]*/, '')
    out = out.replace(/^\?/, '?') // 清理开头多余的 ?
    // 未登录的新设备：代换最新 dsh 登录口令（已登录请求转发 cookie 即可）
    // /plugins/ 静态资源不需要 token（DSH 不认证），跳过以避免破坏 ?? 拼接格式
    let sentToken = false
    if (!authed && !out.startsWith('/plugins/')) {
      if (pathToken !== undefined) {
        // path 形式的口令转成标准 ?token= 查询参数转发（raw 已剥掉 /t/ 前缀）
        out += (out.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(pathToken)
        sentToken = true
      } else if (tokenOk) {
        // 请求已携带最新口令（query 形式），原样保留即可
        sentToken = true
      } else {
        const token = staticToken ?? (await readDshToken(tokenFile))
        if (token !== undefined) {
          out = withToken(out, token)
          sentToken = true
        }
      }
    }
    return {
      url: out,
      remember: keyOk && !authed && !remembered,
      sentToken,
    }
  }

  const server = createServer(async (req, res) => {
    // 客户端 socket 层的错误（手机息屏/切网导致的 RST 等）必须有人接管，
    // 否则就是 uncaughtException 把整个 dsh 进程带走。
    res.on('error', () => res.destroy())
    let gated
    try {
      gated = await gate(req)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsh-remote-x: gate error: ${error.message}`)
      return
    }
    if (gated.denied) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-remote-x: 需要访问口令 — 在 URL 后追加 ?key=<口令>，或在设置页重新扫码')
      return
    }
    const headers = rewriteRequestHeaders(req.headers, upstream)

    /** 把上游响应写回客户端（注入 polyfill、补记忆 cookie）。 */
    const respond = (upstreamRes) => {
      // pipe() 不转发 error：链上任何一段（解压/注入/gzip）报错若无监听，
      // 就是 uncaughtException 带崩 dsh 进程（03:36 的 ws 崩溃即同型）。
      // 统一收尾：销毁上游与客户端连接，错误走 onError 日志。
      let finished = false
      res.on('finish', () => { finished = true })
      res.on('close', () => {
        // 客户端中途断开（手机息屏/切网）：掐断上游，防流与 socket 泄漏
        if (!finished) upstreamRes.destroy()
      })
      upstreamRes.on('error', (error) => {
        options.onError?.({ kind: 'respond', error })
        res.destroy()
      })
      const guardStream = (stream) => stream.on('error', (error) => {
        options.onError?.({ kind: 'respond', error })
        upstreamRes.destroy()
        res.destroy()
      })

      let outHeaders = rewriteResponseHeaders(upstreamRes.headers, upstream)
      if (gated.remember) {
        outHeaders = mergeSetCookie(
          outHeaders,
          `${REMEMBER_COOKIE}=${encodeURIComponent(accessKey)}; Path=/; HttpOnly; Max-Age=${REMEMBER_COOKIE_MAX_AGE}; SameSite=Strict`,
        )
      }
      if (!isHtml(upstreamRes.headers)) {
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
        upstreamRes.pipe(res)
        return
      }
      // HTML: stream through PolyfillInjectTransform (TTFB ≈ upstream TTFB + ≤5ms)
      const upstreamEncoding = upstreamRes.headers['content-encoding']
      const wasCompressed = upstreamEncoding === 'br' || upstreamEncoding === 'gzip' || upstreamEncoding === 'deflate'
      const finalHeaders = { ...outHeaders, 'content-type': 'text/html; charset=utf-8' }
      delete finalHeaders['content-length']
      delete finalHeaders['content-encoding']
      // 注入 polyfill 必须解压；但解压后不再回压会让手机（蜂窝/隧道）多拉几倍
      // 流量——DSH 上游本身开着 gzip，代理把它拆了就该还回去。
      if (wasCompressed) finalHeaders['content-encoding'] = 'gzip'
      res.writeHead(upstreamRes.statusCode ?? 502, finalHeaders)
      const injector = new PolyfillInjectTransform(POLYFILL)
      guardStream(injector)
      if (wasCompressed) {
        const decompressor = new DecompressTransform(upstreamEncoding)
        const gzipStream = createGzip()
        guardStream(decompressor)
        guardStream(gzipStream)
        upstreamRes.pipe(decompressor).pipe(injector).pipe(gzipStream).pipe(res)
      } else {
        upstreamRes.pipe(injector).pipe(res)
      }
    }

    /** 丢掉失效的会话 cookie、改用登录口令重发一次（仅无请求体的方法）。 */
    const retryWithToken = async () => {
      const token = staticToken ?? (await readDshToken(tokenFile))
      if (token === undefined) {
        if (!res.headersSent) res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-remote-x: 无法从 dsh 获取登录口令，请在插件配置中设置 token')
        return
      }
      const retryHeaders = { ...headers }
      delete retryHeaders.cookie
      const retried = httpRequest(
        {
          host: upstream.host,
          port: upstream.port,
          path: withToken(gated.url, token),
          method: req.method,
          headers: retryHeaders,
          agent: upstreamAgent.agent,
        },
        respond,
      )
      retried.on('error', (error) => {
        options.onError?.({ kind: 'proxy', error })
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`dsh-remote-x: 无法连接本机 dsh web（${upstream.host}:${upstream.port}）：${error.message}`)
      })
      retried.end()
    }

    let gotHeaders = false
    let retried = false

    const dispatch = (freshConnection) => {
      const proxied = httpRequest(
        {
          host: upstream.host,
          port: upstream.port,
          path: gated.url,
          method: req.method,
          headers,
          // 超时只覆盖"等响应头"阶段：没有它，写进被上游关掉的死连接的请求
          // 会永远挂起（2026-09-13 转发面瘫痪的根因）。响应头到了立刻撤掉
          // （见下），SSE 等长流式响应允许间歇静默，不被误杀。
          timeout: UPSTREAM_HEADER_TIMEOUT_MS,
          agent: freshConnection ? false : upstreamAgent.agent,
        },
        (upstreamRes) => {
          gotHeaders = true
          proxied.setTimeout(0)
          // 客户端带了一个对本进程已失效的 dsh-auth-* cookie 时，gate 认定它「已登录」
          // 而跳过口令代换，dsh 于是直接回 401 —— 且这个 cookie 永远刷不掉，
          // 连重新扫码都没用（症状：手机一直显示 dsh web authentication required）。
          // 丢掉旧 cookie、补上口令重试一次，让 dsh 走口令交换下发新 cookie。
          if (upstreamRes.statusCode === 401 && !gated.sentToken
            && (req.method === 'GET' || req.method === 'HEAD')) {
            upstreamRes.resume()
            retryWithToken().catch((error) => {
              options.onError?.({ kind: 'proxy', error })
              if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('dsh-remote-x: 会话恢复重试失败')
            })
            return
          }
          respond(upstreamRes)
        },
      )
      proxied.on('timeout', () => {
        if (!gotHeaders) proxied.destroy(new Error(`upstream 未在 ${UPSTREAM_HEADER_TIMEOUT_MS}ms 内返回响应头`))
      })
      proxied.on('error', (error) => {
        options.onError?.({ kind: 'proxy', error })
        if (res.headersSent) { res.destroy(); return }
        // 死连接/瞬时故障：幂等方法销毁后换全新连接重试一次（带请求体的方法
        // body 已被消费，不能重试），仍失败才回 502/504。
        if (!retried && !gotHeaders && (req.method === 'GET' || req.method === 'HEAD')) {
          retried = true
          dispatch(true)
          return
        }
        const status = /timeout/i.test(error.message) ? 504 : 502
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`dsh-remote-x: 无法连接本机 dsh web（${upstream.host}:${upstream.port}）：${error.message}`)
      })
      req.on('error', () => proxied.destroy())
      req.pipe(proxied)
    }
    dispatch(false)
  })

  server.on('upgrade', async (req, socket, head) => {
    // 裸 socket 先兜底：下面每个 socket.end()/socket.write() 分支（500/401/502）
    // 都可能被对端 RST 回应，没有这个监听就是整个进程 exit 1。
    // 本 handler 的每条出口都会 destroy() 掉该 socket，监听随 socket 一起消失，
    // 无需手动摘除。
    guardUpgradeSocket(socket)
    let gated
    try {
      gated = await gate(req)
    } catch {
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
      return
    }
    if (gated.denied) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\ndsh-remote-x: 需要访问口令 (?key=)')
      socket.destroy()
      return
    }
    const headers = rewriteRequestHeaders(req.headers, upstream)
    const proxied = httpRequest({
      host: upstream.host,
      port: upstream.port,
      path: gated.url,
      method: req.method,
      headers: { ...headers, connection: 'upgrade', upgrade: req.headers.upgrade ?? 'websocket' },
      agent: upstreamAgent.agent,
    })
    proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`
      const headLines = []
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (key.toLowerCase() === 'content-encoding') continue
        if (Array.isArray(value)) value.forEach(v => headLines.push(`${key}: ${v}`))
        else headLines.push(`${key}: ${value}`)
      }
      socket.write([statusLine, ...headLines, '', ''].join('\r\n'))
      // 两侧握手包里都可能粘着紧随其后的 WebSocket 帧字节，必须各回各家：
      //   head（客户端粘包）→ 服务端；upstreamHead（服务端粘包）→ 客户端。
      // 旧实现把 upstreamHead 写回了服务端自己——服务端→客户端的帧按协议
      // 不带掩码，被当客户端帧解析就是 "MASK must be set" fatal（dsh 整机
      // 崩溃，03:36/04:50 两次实测）；head 则被静默丢弃造成字节错位。
      if (upstreamHead?.length) socket.write(upstreamHead)
      if (head?.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      const cleanup = () => {
        socket.destroy()
        upstreamSocket.destroy()
      }
      socket.on('error', cleanup)
      upstreamSocket.on('error', cleanup)
    })
    proxied.on('error', (error) => {
      options.onError?.({ kind: 'upgrade', error })
      socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\ndsh-remote-x: upstream unavailable: ${error.message}`)
      socket.destroy()
    })
    proxied.end()
  })

  // 代理被宿主进程内托管时会随开关反复启停，进程级监听器必须成对回收，
  // 否则频繁切换会累积监听器并触发 MaxListenersExceededWarning。
  const onSigterm = () => upstreamAgent.destroy()
  process.on('SIGTERM', onSigterm)
  server.on('close', () => {
    upstreamAgent.destroy()
    process.off('SIGTERM', onSigterm)
  })

  return new Promise((resolve, reject) => {
    // 双栈监听（2026-09-12）：默认 '::' 在 ipv6Only=false 下同时收 IPv6 与
    // IPv4（IPv4 以 ::ffff: 映射地址进入），LAN 手机与 IPv6 公网（手机蜂窝
    // 直连场景）都能到达代理端口。无 IPv6 内核的机器监听 '::' 会报
    // EADDRNOTAVAIL，自动回落纯 IPv4 '0.0.0.0'，保证旧环境可用。
    const tryListen = (host, isFallback) => {
      const onListen = () => {
        cleanup()
        resolve(server)
      }
      const onError = (error) => {
        cleanup()
        if (!isFallback && host === '::' && error?.code === 'EADDRNOTAVAIL') {
          tryListen('0.0.0.0', true)
          return
        }
        reject(error)
      }
      const cleanup = () => {
        server.off('listening', onListen)
        server.off('error', onError)
      }
      server.once('listening', onListen)
      server.once('error', onError)
      server.listen(options.port, host)
    }
    tryListen(options.host ?? '::', false)
  })
}
