import { setTimeout as sleep } from 'node:timers/promises'
import { BACKOFF_SCHEDULE, HEALTH_CHECK_MAX_FAILURES, HEALTH_CHECK_INTERVAL_MS } from './constants.mjs'

/**
 * Tunnel supervisor: manages child lifecycle with exponential backoff reconnection.
 * State machine: connected → reconnecting → connected/disconnected
 */
export class TunnelSupervisor {
  constructor({ startChild, onStateChange, maxReconnect = 10, healthCheckMs = HEALTH_CHECK_INTERVAL_MS, metricsPort = 0 } = {}) {
    this._startChild = startChild
    this._onStateChange = onStateChange
    this._maxReconnect = maxReconnect
    this._healthCheckMs = healthCheckMs
    this._metricsPort = metricsPort
    this._state = 'disconnected'
    this._child = null
    this._currentAttempt = 0
    this._reconnectCount = 0
    this._stopping = false
    this._reconnectTimer = null
    this._healthChecker = null
  }

  get state() { return this._state }
  get reconnectCount() { return this._reconnectCount }
  get child() { return this._child }

  _setState(state) {
    this._state = state
    this._onStateChange?.(state)
  }

  async start() {
    this._stopping = false
    await this._spawn()
  }

  async _spawn() {
    try {
      const result = await this._startChild()
      this._child = result.child ?? null
      this._currentAttempt = 0
      this._setState('connected')
      if (this._child) {
        this._child.on('exit', (code, signal) => {
          if (this._stopping) return
          this._onExit(code, signal)
        })
      }
      return result
    } catch (err) {
      this._onExit(1, null)
      throw err
    }
  }

  _onExit(_code, _signal) {
    this._child = null
    if (this._reconnectCount >= this._maxReconnect) {
      this._setState('disconnected')
      return
    }
    this._setState('reconnecting')
    const delay = BACKOFF_SCHEDULE[Math.min(this._currentAttempt, BACKOFF_SCHEDULE.length - 1)]
    this._currentAttempt += 1
    this._reconnectCount += 1
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this._spawn()
      } catch {
        this._onExit(1, null)
      }
    }, delay)
  }

  stop() {
    this._stopping = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    if (this._healthChecker) this._healthChecker.stop()
    if (this._child) {
      try { this._child.kill('SIGTERM') } catch { /* ignore */ }
    }
    this._setState('disconnected')
  }

  async reconnect() {
    if (this._child) {
      try { this._child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }

  getRuntimeState() {
    return {
      status: this._state,
      reconnectCount: this._reconnectCount,
      child: this._child,
    }
  }
}

/**
 * Health checker: probes the tunnel URL periodically.
 * After maxFailures consecutive failures, triggers onUnhealthy.
 */
export class TunnelHealthChecker {
  constructor({ probeUrl, intervalMs = HEALTH_CHECK_INTERVAL_MS, maxFailures = HEALTH_CHECK_MAX_FAILURES, onUnhealthy } = {}) {
    this._probeUrl = probeUrl
    this._intervalMs = intervalMs
    this._maxFailures = maxFailures
    this._onUnhealthy = onUnhealthy
    this._failCount = 0
    this._latencyMs = null
    this._timer = null
  }

  start() {
    this._timer = setInterval(() => this._probe(), this._intervalMs)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  async _probe() {
    const start = Date.now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5_000)
      await fetch(this._probeUrl, { method: 'HEAD', signal: controller.signal })
      clearTimeout(timeout)
      this._latencyMs = Date.now() - start
      this._failCount = 0
    } catch {
      this._failCount += 1
      if (this._failCount >= this._maxFailures) {
        this._onUnhealthy?.()
      }
    }
  }

  getLatencyMs() { return this._latencyMs }
}

/**
 * Metrics scraper: fetches Prometheus metrics from cloudflared --metrics endpoint.
 */
export class TunnelMetrics {
  constructor(metricsPort = 0) {
    this._metricsPort = metricsPort
    this._timer = null
    this._metrics = { totalStreams: 0, latencyMs: 0, reconnects: 0, raw: '' }
  }

  start() {
    if (this._metricsPort === 0) return
    this._timer = setInterval(() => this._scrape(), 10_000)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  async _scrape() {
    try {
      const res = await fetch(`http://127.0.0.1:${this._metricsPort}/metrics`)
      const text = await res.text()
      this._metrics.raw = text
      const streamMatch = /tunnel_total_streams\s+(\d+)/.exec(text)
      const latencyMatch = /latency\s+([\d.]+)/.exec(text)
      const reconnectMatch = /reconnects\s+(\d+)/.exec(text)
      if (streamMatch) this._metrics.totalStreams = parseInt(streamMatch[1], 10)
      if (latencyMatch) this._metrics.latencyMs = parseFloat(latencyMatch[1])
      if (reconnectMatch) this._metrics.reconnects = parseInt(reconnectMatch[1], 10)
    } catch { /* metrics endpoint unavailable */ }
  }

  getMetrics() { return { ...this._metrics } }
}

/**
 * Resolve the nearest Cloudflare edge region.
 * 'auto' probes via /cdn-cgi/trace; explicit regions pass through.
 */
export async function resolveTunnelRegion(region = 'auto') {
  if (region !== 'auto') return region
  try {
    const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(3_000) })
    const text = await res.text()
    const locMatch = /loc=(\w+)/.exec(text)
    if (locMatch) {
      const loc = locMatch[1]
      if (['CN', 'HK', 'TW', 'JP', 'KR'].includes(loc)) return 'ap'
      if (['US', 'CA', 'MX'].includes(loc)) return 'us'
      return 'eu'
    }
  } catch { /* probe failed */ }
  return 'auto'
}