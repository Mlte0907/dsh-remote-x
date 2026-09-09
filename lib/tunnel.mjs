// dsh-remote-x — 公网隧道封装（抽自 bin/dsh-remote-x.mjs，改为可被插件 API 运行时调用）
//
// 两种模式：
//   1. 临时隧道（默认）：cloudflared tunnel --url http://127.0.0.1:<port>
//      → 解析 https://<id>.trycloudflare.com，每次启动前缀随机、旧链自动失效（安全特性）。
//   2. 命名隧道（可选）：cloudflared tunnel --token <CF_TOKEN>
//      → 固定域名（需 Cloudflare 账号 + 自有域名 + Zero Trust Tunnel）。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { TUNNEL_TIMEOUT_MS } from './constants.mjs'
import { TunnelSupervisor, TunnelHealthChecker, TunnelMetrics, resolveTunnelRegion } from './tunnel-supervisor.mjs'

const TMP_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

function resolveBinary() {
  const candidates = [
    path.join(homedir(), '.local', 'bin', 'cloudflared'),
    path.join(homedir(), 'bin', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/usr/bin/cloudflared',
    'cloudflared',
  ]
  for (const candidate of candidates) {
    if (candidate === 'cloudflared') return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'cloudflared'
}

/**
 * 启动 cloudflared 隧道，指向本机代理端口。
 * @param {number} port 本机代理端口（默认 3081）
 * @param {object} [opts]
 * @returns {Promise<{ url: string, child: ChildProcess, stop: () => void, runtime: TunnelRuntimeState }>}
 */
export async function startTunnel(port, opts = {}) {
  const {
    token, domain,
    region = 'auto', protocol = 'quic', metricsPort = 0,
    reconnect = true, healthCheckMs, maxReconnect, onStateChange,
  } = opts

  const resolvedRegion = await resolveTunnelRegion(region)
  let tunnelUrl = null
  let tunnelProtocol = protocol

  function buildArgs() {
    const args = []
    if (token && domain) {
      args.push('tunnel', '--token', token)
    } else {
      args.push('tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate')
    }
    if (resolvedRegion !== 'auto') args.push('--region', resolvedRegion)
    if (protocol) args.push('--protocol', protocol)
    if (metricsPort > 0) args.push('--metrics', `127.0.0.1:${metricsPort}`)
    return args
  }

  function startChild() {
    return new Promise((resolveChild, rejectChild) => {
      const args = buildArgs()
      const child = spawn(resolveBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] })

      let settled = false
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value) } }

      const scan = (text) => {
        if (/fallback to http2/i.test(text)) tunnelProtocol = 'http2'
        if (token && domain) {
          tunnelUrl = `https://${domain}`
          finish(resolveChild, { child, url: tunnelUrl })
          return
        }
        const match = TMP_RE.exec(text)
        if (match) {
          tunnelUrl = match[0]
          finish(resolveChild, { child, url: tunnelUrl })
        }
      }

      child.stdout.on('data', (data) => scan(String(data)))
      child.stderr.on('data', (data) => scan(String(data)))
      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          finish(rejectChild, new Error('未找到 cloudflared：macOS 用 `brew install cloudflared`，其它平台见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'))
        } else {
          finish(rejectChild, new Error(`cloudflared 启动失败：${err.message}`))
        }
      })
      setTimeout(() => {
        finish(rejectChild, new Error('cloudflared 启动超时（30s 内未拿到隧道地址）'))
      }, TUNNEL_TIMEOUT_MS)
    })
  }

  if (!reconnect) {
    const result = await startChild()
    return {
      url: result.url,
      child: result.child,
      stop: () => { try { result.child.kill('SIGTERM') } catch { /* ignore */ } },
      runtime: { url: result.url, status: 'connected', region: resolvedRegion, protocol: tunnelProtocol, reconnectCount: 0, latencyMs: null },
    }
  }

  const supervisor = new TunnelSupervisor({ startChild, onStateChange, maxReconnect, healthCheckMs, metricsPort })
  const result = await supervisor.start()
  const url = result?.url ?? tunnelUrl

  const healthChecker = new TunnelHealthChecker({
    probeUrl: url,
    intervalMs: healthCheckMs,
    onUnhealthy: () => supervisor.reconnect(),
  })
  healthChecker.start()

  const metrics = new TunnelMetrics(metricsPort)
  metrics.start()

  const runtime = {
    url,
    status: supervisor.state,
    region: resolvedRegion,
    protocol: tunnelProtocol,
    reconnectCount: supervisor.reconnectCount,
    latencyMs: () => healthChecker.getLatencyMs(),
    child: supervisor.child,
    stop: () => {
      healthChecker.stop()
      metrics.stop()
      supervisor.stop()
    },
    supervisor,
    metrics,
  }

  return { url, child: supervisor.child, stop: runtime.stop, runtime }
}
