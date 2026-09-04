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

const TMP_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const TIMEOUT_MS = 30_000

/**
 * 解析 cloudflared 可执行文件路径：优先常见安装位置（含 ~/.local/bin，
 * systemd user service 的 PATH 往往不含它），最后回退到 PATH 查找。
 */
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
 * @param {{ token?: string, domain?: string }} [opts] 命名隧道参数
 * @returns {Promise<{ url: string, child: import('node:child_process').ChildProcess, stop: () => void }>}
 */
export function startTunnel(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = []
    if (opts.token && opts.domain) {
      args.push('tunnel', '--token', opts.token)
    } else {
      args.push('tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate')
    }
    const child = spawn(resolveBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const scan = (text) => {
      if (opts.token && opts.domain) {
        // 命名隧道：域名已知，cloudflared 起来即视为就绪
        finish(resolve, {
          url: `https://${opts.domain}`,
          child,
          stop: () => { try { child.kill('SIGTERM') } catch { /* ignore */ } },
        })
        return
      }
      const match = TMP_RE.exec(text)
      if (match) {
        finish(resolve, {
          url: match[0],
          child,
          stop: () => { try { child.kill('SIGTERM') } catch { /* ignore */ } },
        })
      }
    }

    child.stdout.on('data', (data) => scan(String(data)))
    child.stderr.on('data', (data) => scan(String(data)))
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        finish(reject, new Error('未找到 cloudflared（公网模式需要它）：macOS 用 `brew install cloudflared`，其它平台见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'))
      } else {
        finish(reject, new Error(`cloudflared 启动失败：${err.message}`))
      }
    })
    setTimeout(() => {
      finish(reject, new Error('cloudflared 启动超时（30s 内未拿到隧道地址）'))
    }, TIMEOUT_MS)
  })
}
