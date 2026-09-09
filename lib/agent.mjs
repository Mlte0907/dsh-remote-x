import { Agent } from 'node:http'
import { MAX_SOCKETS, MAX_FREE_SOCKETS, KEEPALIVE_MSECS, SOCKET_TIMEOUT } from './constants.mjs'

/**
 * Wraps an http.Agent with keepAlive for upstream connection reuse.
 * Eliminates per-request TCP handshake (+30-50ms) after the first request.
 */
export class UpstreamAgent {
  constructor({ keepAlive = true, maxSockets = MAX_SOCKETS, keepAliveMsecs = KEEPALIVE_MSECS } = {}) {
    this._agent = new Agent({
      keepAlive,
      keepAliveMsecs,
      maxSockets,
      maxFreeSockets: MAX_FREE_SOCKETS,
      timeout: SOCKET_TIMEOUT,
    })
  }

  get agent() {
    return this._agent
  }

  getConnectionStats() {
    const sockets = this._agent.sockets
    const freeSockets = this._agent.freeSockets
    let created = 0
    let pending = 0
    let free = 0
    for (const key of Object.keys(sockets ?? {})) {
      created += (sockets[key]?.length ?? 0)
    }
    for (const key of Object.keys(freeSockets ?? {})) {
      free += (freeSockets[key]?.length ?? 0)
    }
    pending = this._agent.totalSocketCount - created - free
    return { created, reused: created - free, pending, free }
  }

  destroy() {
    this._agent.destroy()
  }
}