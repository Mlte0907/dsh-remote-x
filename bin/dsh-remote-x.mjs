#!/usr/bin/env node
// dsh-remote-x — 把 DeepSeek Harness 的远程控制页装进手机
//
// 用法：
//   dsh-remote-x                 局域网模式：手机同一 WiFi 扫码/输地址访问
//   dsh-remote-x --public        公网模式：cloudflared 隧道，人在外面也能访问
//   dsh-remote-x --port 3081     自定义代理端口（默认 3081；dsh web 保持 3080）
//   dsh-remote-x --token <口令>  打印带口令的可直接访问地址
//
// 前提：本机 dsh web 已在 127.0.0.1:3080 运行（不另起第二个实例，避免会话并发写）。
// 手机上看到的就是桌面端同一批会话，流式实时同步。

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { startRemoteProxy, defaultTokenFile } from '../lib/proxy.mjs'
import { lanIPv4, preferredLanIPv4, isValidIpv4 } from '../lib/ip.mjs'

const require = createRequire(import.meta.url)

const HELP = `dsh-remote-x — 手机访问电脑上的 DeepSeek Harness 远程控制页

用法：
  dsh-remote-x                     局域网模式（手机同一 WiFi）
  dsh-remote-x --access-key <口令> 固定访问口令（推荐）：手机地址永不过期，
                                   后端重启时自动代换最新登录口令
  dsh-remote-x --public            公网模式（cloudflared 隧道，人在外面）
  dsh-remote-x --port 3081         自定义代理端口
  dsh-remote-x --token <口令>      （无 access-key 时）打印带口令的地址
  dsh-remote-x --lan-ip <IP>       指定对外展示的局域网地址
  dsh-remote-x --help              帮助

前提：本机 dsh web 已在 127.0.0.1:3080 运行。
建议用 systemd 管后端：systemctl --user restart dsh-web

安全提醒：远程控制页能执行代码。二维码/URL 就是钥匙，请勿发给别人。`

function parseArgs(argv) {
  const args = {
    port: 3081,
    public: false,
    token: process.env.REMOTE_X_TOKEN ?? '',
    accessKey: process.env.REMOTE_X_ACCESS_KEY ?? '',
    lanIp: '',
    upstream: { host: '127.0.0.1', port: 3080 },
    tokenFile: existsSync(defaultTokenFile()) ? defaultTokenFile() : undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--public') args.public = true
    else if (a === '--port') args.port = Number(argv[++i]) || 3081
    else if (a === '--upstream-port') args.upstream.port = Number(argv[++i]) || 3080
    else if (a === '--access-key') args.accessKey = argv[++i] ?? ''
    else if (a === '--token') args.token = argv[++i] ?? ''
    else if (a === '--lan-ip') args.lanIp = argv[++i] ?? ''
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    }
  }
  if (args.lanIp && !isValidIpv4(args.lanIp)) {
    console.error(`dsh-remote-x: --lan-ip 不是合法 IPv4：${args.lanIp}`)
    process.exit(1)
  }
  return args
}

/** 终端二维码：缺依赖时优雅降级，不阻断主流程。 */
function printQr(text) {
  try {
    const qrcode = require('qrcode-terminal')
    console.log('\n扫码访问：')
    qrcode.generate(text, { small: true })
  } catch {
    console.log('\n（未安装 qrcode-terminal，跳过二维码；可直接输入上面的地址）')
  }
}

/** 对外展示地址：优先固定 access-key（永不过期），否则退回一次性 token。
 *  用 path 形式（/k/、/t/）——Edge 等浏览器扫码会剥离 URL 查询参数。 */
function publicUrl(base, args) {
  if (args.accessKey) return `${base}/k/${encodeURIComponent(args.accessKey)}/`
  return args.token ? `${base}/t/${encodeURIComponent(args.token)}/` : `${base}/`
}

/** 启动 cloudflared 快速隧道，解析出对外 https 地址。 */
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    const scan = (text) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)
      if (match && !settled) {
        settled = true
        resolve({ url: match[0], child })
      }
    }
    child.stdout.on('data', data => scan(String(data)))
    child.stderr.on('data', data => scan(String(data)))
    child.on('error', () => {
      if (!settled) {
        settled = true
        reject(new Error('未找到 cloudflared（公网模式需要它）。局域网模式无需安装。'))
      }
    })
    setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('cloudflared 启动超时，未拿到隧道地址'))
      }
    }, 30000)
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const lan = args.lanIp || preferredLanIPv4()

  await startRemoteProxy({
    port: args.port,
    host: '0.0.0.0',
    upstream: args.upstream,
    accessKey: args.accessKey || undefined,
    tokenFile: args.accessKey ? args.tokenFile : undefined,
    onError: ({ kind, error }) => console.error(`dsh-remote-x: ${kind} 出错：${error.message}`),
  })

  console.log(`dsh-remote-x: 代理已启动 → 本机 dsh web ${args.upstream.host}:${args.upstream.port}`)
  console.log(`  监听：0.0.0.0:${args.port}`)
  if (args.accessKey) console.log('  固定访问口令已启用：地址不随后端重启失效\n')
  else console.log('')

  const list = args.lanIp ? [args.lanIp] : lanIPv4()
  if (list.length === 0) {
    console.log('未探测到局域网地址（可能只连了 loopback）。可用 --lan-ip 手动指定。')
  }
  console.log('局域网地址（手机同一 WiFi）：')
  for (const ip of list) {
    const url = publicUrl(`http://${ip}:${args.port}`, args)
    console.log(`  ${url}${ip === lan ? '   ← 推荐' : ''}`)
  }
  if (lan) printQr(publicUrl(`http://${lan}:${args.port}`, args))

  if (args.public) {
    try {
      const { url, child } = await startTunnel(args.port)
      console.log('公网地址（cloudflared 隧道）：')
      console.log(`  ${publicUrl(url, args)}`)
      printQr(publicUrl(url, args))
      const stop = () => {
        child.kill('SIGTERM')
        process.exit(0)
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    } catch (error) {
      console.error(`dsh-remote-x: 公网模式失败 — ${error.message}`)
      console.log('局域网访问不受影响，继续使用上面的局域网地址即可。')
    }
  }
}

main().catch((error) => {
  console.error(`dsh-remote-x: ${error.message}`)
  process.exit(1)
})
