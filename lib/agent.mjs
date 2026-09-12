import { Agent } from 'node:http'
import { MAX_SOCKETS } from './constants.mjs'

/**
 * Wraps an http.Agent for upstream requests.
 *
 * 故意不做 keep-alive 池化（2026-09-13）：上游是本机回环的 dsh web，握手是
 * 微秒级，池化没有收益；而 dsh web 的 keep-alive idle timeout 只有 5s，
 * 池里的空闲连接 5s 后就被对端关闭——一旦被派发给新请求，请求写进死连接
 * 后永远等不到响应（此前未设超时），积累后整个转发面瘫痪（实测复现：
 * 手机式请求 15s 0 字节，重建代理实例立即恢复）。
 * 每请求独立连接 + 请求级超时（见 proxy.mjs）才是可自愈的形态。
 */
export class UpstreamAgent {
  constructor({ keepAlive = false, maxSockets = MAX_SOCKETS } = {}) {
    this._agent = new Agent({ keepAlive, maxSockets })
  }

  get agent() {
    return this._agent
  }

  getConnectionStats() {
    const sockets = this._agent.sockets
    let created = 0
    for (const key of Object.keys(sockets ?? {})) {
      created += (sockets[key]?.length ?? 0)
    }
    return { created, reused: 0, pending: this._agent.totalSocketCount - created, free: 0 }
  }

  destroy() {
    this._agent.destroy()
  }
}