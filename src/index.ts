/**
 * dsh-remote-x — DSH 网页端移动适配层 + 远程接入信息面板。
 *
 * 两件事：
 * 1. 经 `webserver/index-inject` 向网页端注入移动端覆盖 CSS：窄屏（默认 <768px）
 *    时把三栏 grid 单列化，其余全部复用网页端自身。宽屏零影响。
 * 2. 恢复设置页「远程控制」标签（client 半，见 src/client/index.ts）背后的
 *    数据 API：拼好手机访问地址（局域网 + proxy 端口 + 登录口令）并生成二维码。
 *    API 挂在 DSH 原生认证墙内（同源已登录方可访问），口令不进 window 全局。
 *
 * 布局锚点基于探针实测（2026-09-03）：dsh-web-app 的 CSS Modules hash 只在前缀，
 * 后缀语义化且全页唯一（_frame / _sidebarCol / _centerCol / _detailsCol），
 * 因此用 [class*="_xxx"] 后缀匹配，不依赖会变的 hash。
 */

import { open, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { startTunnel } from '../lib/tunnel.mjs'

/** Stable Cordis plugin name. */
export const name = 'dsh-remote-x'

/** Services required before apply runs. */
export const inject = ['webServer', 'sessions', 'agents', 'connection']

/** Plugin config. */
export interface Config {
  /** Max viewport width (px) the mobile layer applies to. Default 768. */
  breakpoint?: number
  /** LAN proxy port phones connect through. Default 3081; 0 = not deployed. */
  proxyPort?: number
  /** Section label. Default '远程控制'. */
  title?: string
  /** Manual override for the login token (auto-detected by default). */
  token?: string
  /** Proxy access-key for QR entry URL. When set, QR links use ?key= instead of ?token=. */
  accessKey?: string
  /** Cloudflare tunnel region: 'auto' | 'ap' | 'us' | 'eu'. Default 'auto'. */
  tunnelRegion?: string
  /** Cloudflare tunnel protocol: 'quic' | 'http2'. Default 'quic'. */
  tunnelProtocol?: string
  /** Enable tunnel auto-reconnect on crash. Default true. */
  tunnelReconnect?: boolean
  /** Metrics port for cloudflared --metrics (0 = disabled). Default 0. */
  tunnelMetricsPort?: number
  /** Health check interval in ms. Default 30000. */
  tunnelHealthCheckMs?: number
  /** Max reconnection attempts before giving up. Default 10. */
  tunnelMaxReconnect?: number
  /** Enable upstream keep-alive connection pooling. Default true. */
  proxyKeepAlive?: boolean
  /** Enable response compression passthrough. Default true. */
  proxyCompress?: boolean
  /** Enable debug logging. Default false. */
  debug?: boolean
}

export const Config: z<Config> = z.object({
  breakpoint: z.number().default(768),
  proxyPort: z.number().default(3081),
  title: z.string().default('远程控制'),
  token: z.string(),
  accessKey: z.string(),
  cloudflareToken: z.string(),
  publicDomain: z.string(),
  tunnelRegion: z.string().default('auto'),
  tunnelProtocol: z.string().default('quic'),
  tunnelReconnect: z.boolean().default(true),
  tunnelMetricsPort: z.number().default(0),
  tunnelHealthCheckMs: z.number().default(30_000),
  tunnelMaxReconnect: z.number().default(10),
  proxyKeepAlive: z.boolean().default(true),
  proxyCompress: z.boolean().default(true),
  debug: z.boolean().default(false),
})

/* ------------------------------------------------------------------ */
/* token detection: config → runtime probe → boot log scan            */
/* ------------------------------------------------------------------ */

const TOKEN_RE = /token=([A-Za-z0-9_-]+)/g

/**
 * 首选口令来源：Connection 的进程启动口令交换。
 *
 * 原来的两级回落（webServer 软探测 + 启动日志扫描）都依赖运气：前者要求
 * webServer 上恰好有个 token 形状的字符串字段，后者要求 dsh 把带 token 的
 * URL 写进 ~/.dsh/desktop/backend.log —— 而源码态 / journald 部署根本没有
 * 这个日志文件，于是 tokenDetected 恒为 false，代理拿不到口令，手机一律 401。
 * `connection.authenticatedUrl()` 是官方且稳定的取口令通道（BrowserAuth
 * 用它给浏览器下发登录链接），进程内恒定可用。
 */
function probeConnectionToken(ctx: Context): string | undefined {
  try {
    // 必须已在 inject 中声明 'connection'，否则 cordis 拒绝按属性取服务
    const connection = (ctx as unknown as { connection?: { authenticatedUrl?: (base: string) => string } }).connection
    const url = connection?.authenticatedUrl?.('http://127.0.0.1')
    if (typeof url !== 'string') return undefined
    return new URL(url).searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

/** Soft-probe the webServer service object for a token-shaped string field. */
function probeRuntimeToken(ctx: Context): string | undefined {
  try {
    const ws = ctx.webServer as Record<string, unknown> | undefined
    for (const [key, value] of Object.entries(ws ?? {})) {
      if (/token/i.test(key) && typeof value === 'string' && value.length >= 16) return value
    }
  } catch {
    // 软探测：字段不存在直接跳过
  }
  return undefined
}

/** Scan the tail of the backend boot log (desktop deployment standard). */
async function scanTokenFromLog(): Promise<string | undefined> {
  try {
    const logPath = path.join(homedir(), '.dsh', 'desktop', 'backend.log')
    const handle = await open(logPath, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - 65_536)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      const matches = [...buf.toString('utf8').matchAll(TOKEN_RE)]
      return matches.at(-1)?.[1]
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

async function resolveToken(ctx: Context, config: Config): Promise<string | undefined> {
  if (config.token !== undefined && config.token.length > 0) return config.token
  const launch = probeConnectionToken(ctx)
  if (launch !== undefined) {
    ctx.logger.info('dsh-remote-x: token resolved from Connection launch token')
    return launch
  }
  const probed = probeRuntimeToken(ctx)
  if (probed !== undefined) {
    ctx.logger.info('dsh-remote-x: token resolved from webServer runtime probe')
    return probed
  }
  const scanned = await scanTokenFromLog()
  if (scanned !== undefined) {
    ctx.logger.info('dsh-remote-x: token resolved from boot log scan')
    return scanned
  }
  return undefined
}

/**
 * 惰性 token 解析（按进程缓存一次）。不能在 apply 时解析：
 * 启动日志里的 `dsh web: ?token=` 行在 webserver 就绪后才打印，
 * apply 早于它，且旧的 token 行会随重启滑出扫描窗口。
 */
let tokenCache: string | undefined | null = null
let tokenWarned = false

function resolveTokenLazy(ctx: Context, config: Config): Promise<string | undefined> {
  if (tokenCache !== null) return Promise.resolve(tokenCache)
  return resolveToken(ctx, config).then((token) => {
    // 只缓存成功结果：启动早期（connection 未就绪等）解析失败时，
    // undefined 一旦被缓存就永久失效，tokenDetected 恒 false、手机一律 401。
    // 失败时下次调用重新探测（三级探测都是进程内/本地读取，代价可忽略）。
    if (token !== undefined) {
      tokenCache = token
    } else if (!tokenWarned) {
      tokenWarned = true
      ctx.logger.warn('dsh-remote-x: login token not detected — set config.token to enable the QR panel')
    }
    return token
  })
}

/* ------------------------------------------------------------------ */
/* task list (mobile drawer) — 工作区分组任务列表，同网页端标题来源      */
/* ------------------------------------------------------------------ */

interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data: any
}

interface SessionHeaderLike {
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

interface SessionLike {
  readonly id: SessionId
  readonly header: SessionHeaderLike
  snapshotEvents(): readonly SessionEventLike[]
}

function textOfBlocks(blocks: readonly any[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
}

function firstUserText(events: readonly SessionEventLike[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data ?? {}
    if (data.source?.kind !== 'user') continue
    const text = textOfBlocks(data.content).trim()
    if (text.length > 0) return text.length > 40 ? `${text.slice(0, 39)}…` : text
  }
  return undefined
}

function isTopLevel(header: SessionHeaderLike): boolean {
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/** 在线会话标题：走网页端同一个 sessionTitle 服务。 */
function liveTitle(ctx: Context, session: unknown): string | undefined {
  try {
    const titles = ctx.get('sessionTitle') as { get?: (s: unknown) => { title?: unknown } | undefined } | undefined
    const title = titles?.get?.(session)?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  } catch {
    return undefined
  }
}

/** 冷会话标题：批量折叠（readTitleSnapshots），失败逐条回退。 */
async function coldTitles(query: any, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const results = (await query.readTitleSnapshots?.(ids)) ?? []
    for (const item of results) {
      if (item?.status !== 'fulfilled') continue
      const title = item.value?.title?.title
      const id = String(item.sessionId ?? item.value?.session?.id ?? '')
      if (typeof title === 'string' && title.length > 0 && id.length > 0) out.set(id, title)
    }
  } catch {
    for (const id of ids) {
      try {
        const title = await query.readTitle?.(id)?.then?.((s: any) => s?.title)
        if (typeof title === 'string' && title.length > 0) out.set(id, title)
      } catch { /* skip */ }
    }
  }
  return out
}

async function buildTaskList(ctx: Context): Promise<{ groups: any[]; taskCount: number }> {
  const query = ctx.get('sessionQuery')
  // 诊断：dump 会话 header 字段与 listSessions 结构（用于对齐网页端侧栏过滤）
  try {
    const live0 = (ctx.sessions.list() as readonly SessionLike[])[0]
    if (live0 !== undefined) {
      ctx.logger.info(`remote-x-diag live header keys=${JSON.stringify(Object.keys(live0.header))} payload=${JSON.stringify(live0.header)}`)
    }
    if (query !== undefined) {
      const recs = await query.listSessions()
      ctx.logger.info(`remote-x-diag listSessions count=${recs.length} firstKeys=${JSON.stringify(Object.keys(recs[0] ?? {}))} first=${JSON.stringify(recs[0]?.header ?? recs[0])}`)
    }
  } catch (error) {
    ctx.logger.info(`remote-x-diag failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const sessions = new Map<string, { header: SessionHeaderLike; live: boolean; events?: readonly SessionEventLike[] }>()

  for (const session of ctx.sessions.list() as readonly SessionLike[]) {
    if (!isTopLevel(session.header)) continue
    sessions.set(session.id, { header: session.header, live: true, events: session.snapshotEvents() })
  }
  if (query !== undefined) {
    try {
      for (const record of await query.listSessions()) {
        const header = record.header as SessionHeaderLike
        if (!isTopLevel(header) || sessions.has(header.id)) continue
        sessions.set(header.id, { header, live: record.live === true })
      }
    } catch { /* 持久化列表不可用时退化为在线会话 */ }
  }

  const coldIds = [...sessions.entries()]
    .filter(([, entry]) => !entry.live)
    .sort((a, b) => b[1].header.createdAt - a[1].header.createdAt)
    .slice(0, 50)
    .map(([id]) => id)
  const folded = query === undefined ? new Map<string, string>() : await coldTitles(query, coldIds)

  const tasks: any[] = []
  for (const [id, entry] of sessions) {
    const agent = ctx.agents.get(entry.header.id)
    const running = agent?.status === 'running'
    let title: string | undefined
    if (entry.live) title = liveTitle(ctx, ctx.sessions.get(entry.header.id))
    if (title === undefined) title = folded.get(id)
    if (title === undefined) continue
    const lastActivityAt = entry.events !== undefined
      ? (entry.events.at(-1)?.time ?? entry.header.createdAt)
      : entry.header.createdAt
    tasks.push({ id, title, cwd: entry.header.cwd, updatedAt: lastActivityAt, running, live: entry.live })
  }
  tasks.sort((a: any, b: any) => b.updatedAt - a.updatedAt)

  const byCwd = new Map<string, any[]>()
  for (const task of tasks) {
    const key = task.cwd ?? '(default)'
    if (!byCwd.has(key)) byCwd.set(key, [])
    byCwd.get(key)!.push(task)
  }
  const groups = [...byCwd.entries()].map(([cwd, list]) => ({
    cwd,
    label: cwd === '(default)' ? cwd : (cwd.split('/').pop() || cwd),
    tasks: list,
  })).sort((a: any, b: any) => {
    const maxA = Math.max(...a.tasks.map((t: any) => t.updatedAt))
    const maxB = Math.max(...b.tasks.map((t: any) => t.updatedAt))
    return maxB - maxA
  })
  return { groups, taskCount: tasks.length }
}

/* ------------------------------------------------------------------ */
/* nonce gate for the QR panel API                                    */
/* ------------------------------------------------------------------ */

/**
 * DSH 的认证墙保护 root/index 响应（未认证 401），但插件自定义 prefix 路由
 * 不在墙内，且本机 loopback 请求一律免认证——直接开放 qr-info 会让局域网内
 * 任何人经 proxy 免口令拿到登录口令。
 *
 * 防线：index HTML 只在通过认证后才渲染，因此随 HTML 注入一次性 nonce；
 * qr-info 要求请求头携带有效（未过期）nonce。攻击者未通过认证就看不到
 * nonce；已认证者本来就已持有口令，无增量泄露。
 */
const NONCE_TTL_MS = 10 * 60_000
const nonces = new Map<string, number>()

function issueNonce(): string {
  const nonce = randomBytes(16).toString('hex')
  nonces.set(nonce, Date.now())
  for (const [key, issuedAt] of nonces) {
    if (Date.now() - issuedAt > NONCE_TTL_MS) nonces.delete(key)
  }
  return nonce
}

function nonceValid(nonce: unknown): boolean {
  if (typeof nonce !== 'string' || nonce.length === 0) return false
  const issuedAt = nonces.get(nonce)
  if (issuedAt === undefined) return false
  if (Date.now() - issuedAt > NONCE_TTL_MS) {
    nonces.delete(nonce)
    return false
  }
  // 滑动续期：DSH 设置页长开是常态，nonce 又只在整页加载时注入一次，
  // 固定 TTL 会让开了超过 10 分钟的页面所有开关 401（实测复现）。
  // 改为最后一次成功使用后 10 分钟过期：闲置 nonce 照样淘汰，
  // 且能带有效 nonce 调 API 者本已通过认证，续期无增量泄露。
  nonces.set(nonce, Date.now())
  return true
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

function readJson(req: IncomingMessage, maxBytes = 4_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/** Non-internal IPv4 addresses, deduped. */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if ((net.family === 'IPv4' || net.family === 4) && net.internal !== true) out.push(net.address)
    }
  }
  return [...new Set(out)]
}

/**
 * 本机是否启用了可能拦截入站的防火墙。
 *
 * 局域网模式最典型的失败形态：代理明明在 0.0.0.0:3081 正常监听，本机 curl
 * 也通（本机流量走 lo，不受 ufw 管），但手机一律连不上 —— 因为 ufw 默认拒绝
 * 入站，而公网隧道连的是 127.0.0.1 所以毫发无伤。这种情况插件无法自行放行
 * （改防火墙要 root），至少要在界面上说清楚，别让人去怀疑插件。
 */
function firewallBlocker(): string | undefined {
  for (const unit of ['ufw', 'firewalld']) {
    try {
      if (execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8' }).trim() === 'active') return unit
    } catch { /* 未启用或 systemctl 不可用 */ }
  }
  return undefined
}

/** 本机端口是否已有监听者（用于识别由本进程之外托管的代理实例）。 */
function portInUse(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** LRU cache for QR SVG rendering (max 64 entries). */
const qrCache = new Map<string, string>()
const QR_CACHE_MAX = 64

/** Self-rendered QR SVG — uses the bundled zero-dependency encoder in lib/qr.mjs. */
async function renderQrSvg(text: string): Promise<string> {
  const cached = qrCache.get(text)
  if (cached !== undefined) return cached
  // 内置编码器（见 lib/qr.mjs）：原先依赖 qrcode 包，但它在本机从未安装成功，
  // 二维码接口一调用就抛错。改为零依赖后不再受宿主包管理影响。
  const { encodeQr } = await import('../lib/qr.mjs') as unknown as {
    encodeQr: (value: string) => { size: number; data: Uint8Array }
  }
  const qr = encodeQr(text)
  const size: number = qr.size
  const data: Uint8Array = qr.data
  const quiet = 2
  const total = size + quiet * 2
  const parts: string[] = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (data[row * size + col] === 1) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#ffffff"/>`
    + `<path d="${parts.join('')}" fill="#000000"/></svg>`
  if (qrCache.size >= QR_CACHE_MAX) {
    const firstKey = qrCache.keys().next().value
    if (firstKey !== undefined) qrCache.delete(firstKey)
  }
  qrCache.set(text, svg)
  return svg
}

/* ------------------------------------------------------------------ */
/* plugin                                                             */
/* ------------------------------------------------------------------ */

/* 公网隧道状态（运行时、进程内；不跨重启持久化） */
let publicTunnel: { url: string; stop: () => void; runtime?: { region?: string; protocol?: string; reconnectCount?: number; latencyMs?: () => number | null; status?: string } } | null = null

/* 局域网反代状态（运行时、进程内） */
let lanProxy: { server: Server; port: number } | null = null
/** 代理由本进程之外的机制托管（如用户级 systemd 单元）：沿用而不接管。 */
let lanProxyExternal = false

export async function apply(ctx: Context, config?: Config): Promise<void> {
  const breakpoint = typeof config?.breakpoint === 'number' && config.breakpoint > 0
    ? config.breakpoint
    : 768
  const proxyPort = typeof config?.proxyPort === 'number' ? config.proxyPort : 3081
  const sectionTitle = config?.title ?? '远程控制'

  /* ---------------- 1) mobile CSS injection ---------------- */

  const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inject', 'mobile.css')
  let css = await readFile(cssPath, 'utf8').catch(() => '')
  if (css.length > 0) {
    css = css.replace(/__BREAKPOINT__/g, String(breakpoint))
    // 极简 JS：设置 body viewport class + 兜底恢复
    const mobileJs = `(function(){
function setM(){var m=innerWidth<${breakpoint};if(m)document.body.classList.add('rm-x-mobile');else document.body.classList.remove('rm-x-mobile')}
setM();
var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(setM,100)});
/* 兜底：客户端模块加载失败时恢复桌面布局 */
setTimeout(function(){if(document.body.classList.contains('rm-x-mobile')&&!document.getElementById('rm-x-dashboard'))document.body.classList.remove('rm-x-mobile')},5000);
})();`
    ctx.on('webserver/index-inject', ((table: Array<Record<string, unknown>>) => {
      // 每次请求重读 mobile.css：调 CSS 后刷新页面即生效，无需重启宿主；
      // 读失败（文件被删/占用）时沿用启动快照，保证注入不断供。
      let fresh = css
      try { fresh = readFileSync(cssPath, 'utf8').replace(/__BREAKPOINT__/g, String(breakpoint)) } catch { /* 沿用快照 */ }
      table.push({ kind: 'style', text: fresh })
      table.push({ kind: 'script', placement: 'body', text: mobileJs })
      // 设置页标签（client 半）经同源 fetch 消费该 nonce 访问 qr-info
      table.push({ kind: 'global', name: '__REMOTE_X_NONCE__', value: issueNonce() })
    }) as never)
    ctx.logger.info(`dsh-remote-x: mobile layer injected (breakpoint ${breakpoint}px)`)
  } else {
    ctx.logger.warn('dsh-remote-x: inject/mobile.css missing — mobile layer disabled')
  }

  /* ---------------- 2) settings-page QR panel API ---------------- */

  const base = path.dirname(fileURLToPath(import.meta.url))

  /**
   * 启动局域网反代。
   *
   * 原先一律 `systemctl --user start dsh-remote-proxy.service` —— 但插件从未
   * 随包提供该单元，也没有安装步骤创建它，于是「开启」永远卡在
   * "Unit dsh-remote-proxy.service not found"，局域网与公网两个开关一起失效。
   * 改为在宿主进程内直接托管 lib/proxy.mjs 的反代，任何部署形态都可用。
   */
  async function startLanProxy(): Promise<void> {
    if (lanProxy !== null) return
    if (await portInUse(proxyPort)) {
      // 端口已被外部实例占用（例如用户仍用 systemd 单元托管）：沿用，不重复监听
      lanProxyExternal = true
      return
    }
    const { startRemoteProxy } = await import('../lib/proxy.mjs') as unknown as {
      startRemoteProxy: (options: Record<string, unknown>) => Promise<Server>
    }
    const upstreamPort = typeof (ctx.webServer as unknown as { port?: unknown })?.port === 'number'
      ? (ctx.webServer as unknown as { port: number }).port
      : 3080
    const server = await startRemoteProxy({
      port: proxyPort,
      // 监听地址不传，交给 lib 默认值（'::' 双栈，无 IPv6 内核自动回落 0.0.0.0）。
      // 之前这里硬编码 0.0.0.0，把 lib 的双栈改动整个覆盖成了纯 IPv4。
      upstream: { host: '127.0.0.1', port: upstreamPort },
      accessKey: config?.accessKey,
      // 进程内直传登录口令：手机首访时由代替换发 dsh 认证 cookie，
      // 否则没有口令来源（无 desktop/backend.log）时手机一律 401。
      token: await resolveTokenLazy(ctx, config),
      onError: ({ kind, error }: { kind: string; error: Error }) => {
        ctx.logger.warn(`dsh-remote-x: proxy ${kind} error: ${error.message}`)
      },
    })
    lanProxy = { server, port: proxyPort }
    lanProxyExternal = false
    const bound = server.address()
    const shown = bound !== null && typeof bound === 'object'
      ? `${bound.address}:${bound.port}`
      : String(bound)
    ctx.logger.info(`dsh-remote-x: LAN proxy ${shown} → 127.0.0.1:${upstreamPort}`)
  }

  async function stopLanProxy(): Promise<void> {
    if (lanProxy !== null) {
      const { server } = lanProxy
      lanProxy = null
      // 不能等 server.close() 的排空回调：手机经代理的 SSE/WebSocket/keep-alive
      // 连接可能长期不断开，await 它会让 lan-toggle 请求永久挂起（UI 卡死）。
      // 立即返回；空闲连接马上收，仍存活的连接给 3 秒宽限后强收。
      server.close()
      const closer = server as Server & {
        closeIdleConnections?: () => void
        closeAllConnections?: () => void
      }
      closer.closeIdleConnections?.()
      const grace = setTimeout(() => closer.closeAllConnections?.(), 3_000)
      grace.unref?.()
      return
    }
    if (lanProxyExternal) {
      // 外部托管的实例：尽力停掉；停不掉也不算失败，状态仍以端口探测为准
      try {
        execFileSync('systemctl', ['--user', 'stop', 'dsh-remote-proxy.service'], { stdio: 'ignore' })
      } catch { /* 单元不存在时忽略 */ }
      lanProxyExternal = false
    }
  }

  const route: WebRoute = {
    kind: 'prefix',
    path: '/dsh-remote-x/api',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sub = url.pathname.replace(/\/+$/, '').slice('/dsh-remote-x/api'.length)

      if (sub === '/qr-info' && req.method === 'GET') {
        if (!nonceValid(req.headers['x-remote-nonce'])) {
          sendError(res, 401, 'missing or invalid nonce')
          return
        }
        const ips = lanAddresses()
        const token = await resolveTokenLazy(ctx, config)
        const host = ips[0]
        const accessKey = config?.accessKey
        const entry = host !== undefined && proxyPort > 0
          ? accessKey
            ? `http://${host}:${proxyPort}/k/${encodeURIComponent(accessKey)}/`
            : token !== undefined
              ? `http://${host}:${proxyPort}/t/${encodeURIComponent(token)}/`
              : null
          : null
        sendJson(res, 200, {
          title: sectionTitle,
          lanIps: ips,
          proxyPort,
          tokenDetected: token !== undefined,
          accessKeySet: accessKey !== undefined,
          entry,
          lanEnabled: lanProxy !== null || lanProxyExternal || (await portInUse(proxyPort)),
          publicEnabled: publicTunnel !== null,
          publicUrl: publicTunnel?.url ?? null,
          tunnelRegion: publicTunnel?.runtime?.region ?? null,
          tunnelProtocol: publicTunnel?.runtime?.protocol ?? null,
          tunnelReconnectCount: publicTunnel?.runtime?.reconnectCount ?? 0,
          tunnelLatencyMs: typeof publicTunnel?.runtime?.latencyMs === 'function' ? (publicTunnel.runtime.latencyMs() ?? null) : null,
          tunnelStatus: publicTunnel?.runtime?.status ?? 'disabled',
          cloudflaredAvailable: (() => {
            try { execFileSync('cloudflared', ['--version'], { stdio: 'ignore' }); return true }
            catch { return false }
          })(),
          firewall: firewallBlocker() ?? null,
          version: '0.2.4',
        })
        return
      }

      if (sub === '/tasks' && req.method === 'GET') {
        try {
          sendJson(res, 200, await buildTaskList(ctx))
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (sub === '/qrcode' && req.method === 'GET') {
        const text = url.searchParams.get('text') ?? ''
        if (text.length === 0 || text.length > 512) {
          sendError(res, 400, 'text 长度需在 1..512 之间')
          return
        }
        if (!/^https?:\/\//i.test(text)) {
          sendError(res, 400, 'text 必须是 http(s) 链接')
          return
        }
        try {
          const svg = await renderQrSvg(text)
          res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
          res.end(svg)
        } catch (error) {
          // 不能让异常逃出 handler：未处理的 Promise 拒绝会让 Node 直接终止进程，
          // 之前依赖缺失时整个 dsh 实例就是这样被打挂的。
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (sub === '/lan-toggle' && req.method === 'POST') {
        if (!nonceValid(req.headers['x-remote-nonce'])) {
          sendError(res, 401, 'missing or invalid nonce')
          return
        }
        let raw = ''
        try { for await (const ch of req) raw += ch } catch {}
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw) } catch {}
        const enabled = body.enabled === true
        try {
          if (enabled) await startLanProxy()
          else await stopLanProxy()
          sendJson(res, 200, { ok: true, enabled })
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err))
        }
        return
      }

      if (sub === '/public-toggle' && req.method === 'POST') {
        if (!nonceValid(req.headers['x-remote-nonce'])) {
          sendError(res, 401, 'missing or invalid nonce')
          return
        }
        let raw = ''
        try { for await (const ch of req) raw += ch } catch {}
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw) } catch {}
        const enabled = body.enabled === true
        try {
          if (enabled) {
            if (!publicTunnel) {
              // 公网隧道指向本机代理；代理没起时隧道会 502，先确保它在跑
              await startLanProxy()
              const accessKey = config?.accessKey
              const token = await resolveTokenLazy(ctx, config)
              const t = await startTunnel(proxyPort, {
                token: config?.cloudflareToken, domain: config?.publicDomain,
                region: config?.tunnelRegion, protocol: config?.tunnelProtocol,
                metricsPort: config?.tunnelMetricsPort, reconnect: config?.tunnelReconnect,
                healthCheckMs: config?.tunnelHealthCheckMs, maxReconnect: config?.tunnelMaxReconnect,
              })
              const suffix = accessKey
                ? `/k/${encodeURIComponent(accessKey)}/`
                : token !== undefined
                  ? `/t/${encodeURIComponent(token)}/`
                  : '/'
              publicTunnel = { url: t.url + suffix, stop: t.stop, runtime: t.runtime }
            }
            sendJson(res, 200, { ok: true, enabled: true, url: publicTunnel.url })
          } else {
            publicTunnel?.stop?.()
            publicTunnel = null
            sendJson(res, 200, { ok: true, enabled: false })
          }
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : String(err))
        }
        return
      }

      sendError(res, 404, `no handler for ${req.method} ${url.pathname}`)
    },
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register(route)
    return () => {
      try { publicTunnel?.stop?.() } catch { /* ignore */ }
      publicTunnel = null
      // 反代由本进程托管，卸载时必须一起释放端口，否则重载后 3081 仍被占用
      void stopLanProxy().catch(() => { /* ignore */ })
      dispose()
    }
  }, 'dsh-remote-x: api route')
  ctx.logger.info('dsh-remote-x: QR panel API mounted at /dsh-remote-x/api (token resolved lazily per request)')
}
