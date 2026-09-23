// dsh-remote-x — 自建 frps 服务器接入：frpc 配置生成与进程托管
//
// 归属边界：只管理本插件生成的 ~/.dsh/frpc-remote-x.toml 与由它拉起的 frpc 进程。
// 用户自己的 frpc 配置（~/.config/frp/frpc.toml，例如 opencode 隧道的 frpc.service）
// 只读取、绝不改写或停启。
//
// 进程形态与 lib/tunnel.mjs 的 cloudflared 同型：
//   1. 配置写 ~/.dsh/frpc-remote-x.toml（内含 frps token，0600）；
//   2. pidfile 记 pid，/proc cmdline 校验配置文件名防 PID 复用误杀；
//   3. 启动前扫上一进程的孤儿（dsh 被 kill -9 时 frpc 不会跟着死）；
//   4. loginFailExit=false：frps 短暂不可达由 frpc 自己重连，不产生退出循环。

import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 本插件专属 frpc 配置路径（与用户自己的 frpc.toml 隔离）。 */
function defaultConfigFile() {
  return path.join(homedir(), '.dsh', 'frpc-remote-x.toml')
}

/** 记录当前 frpc 的 pid，供下一次启动清扫孤儿。 */
function defaultPidFile() {
  return path.join(homedir(), '.dsh', 'remote-x-frpc.pid')
}

/** 用户本机 frpc 配置：绑定卡片"一键预填"的数据源（只读）。 */
function localFrpcFile() {
  return path.join(homedir(), '.config', 'frp', 'frpc.toml')
}

/** 运行时状态（单实例：一个插件只托管一条 frps 接入）。 */
const state = {
  running: false,
  pid: null,
  since: 0,
  lastError: null,
}

/** 当前由本插件拉起的 frpc 进程；null = 未在跑。 */
let currentChild = null

/** stopFrpc 主动发起的停止：exit 处理器据此不把退出记成故障。 */
let stopping = false

/** frpc 候选路径：本机常见安装位置优先，PATH 兜底（dsh 服务环境常无 ~/.local/bin）。 */
export function resolveFrpcBinary() {
  const candidates = [
    path.join(homedir(), '.local', 'bin', 'frpc'),
    path.join(homedir(), 'bin', 'frpc'),
    '/usr/local/bin/frpc',
    '/opt/homebrew/bin/frpc',
    '/usr/bin/frpc',
    'frpc',
  ]
  for (const candidate of candidates) {
    if (candidate === 'frpc') return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'frpc'
}

/**
 * frpc 是否可用（--version 退出码 0，5s 超时）。
 * @returns {Promise<boolean>} 二进制可执行且能跑起来
 */
export function frpcAvailable() {
  return new Promise((resolve) => {
    execFile(resolveFrpcBinary(), ['--version'], { timeout: 5_000 }, (error) => resolve(error === null))
  })
}

/**
 * 解析用户本机 frpc 配置的绑定三要素（serverAddr / serverPort / auth.token）。
 * token 由服务端持有，任何 API 响应都不得携带它（见 /frps-prefill 的响应裁剪）。
 * @param {string} [file] 配置路径（测试注入）
 * @returns {{addr: string, port: number, token: string} | null} 解析结果；缺失或不完整返回 null
 */
export function parseLocalFrpcConfig(file = localFrpcFile()) {
  try {
    const raw = readFileSync(file, 'utf8')
    const addr = /^serverAddr\s*=\s*"([^"]+)"/m.exec(raw)?.[1]
    const portText = /^serverPort\s*=\s*(\d+)/m.exec(raw)?.[1]
    const token = /^auth\.token\s*=\s*"([^"]+)"/m.exec(raw)?.[1]
    if (addr === undefined || portText === undefined || token === undefined) return null
    return { addr, port: Number(portText), token }
  } catch {
    return null
  }
}

/** TOML basic string 与 JSON 字符串是同一子集，直接用 JSON.stringify 转义。 */
function tomlString(value) {
  return JSON.stringify(String(value))
}

/**
 * 写本插件专属 frpc 配置（0600：文件含 frps token）。
 * @param {{addr: string, port: number, token: string, remotePort: number}} binding 绑定参数
 * @param {number} localPort 本机代理端口（frpc 把流量转到它）
 * @param {string} [file] 输出路径（测试注入）
 * @returns {string} 写入的配置路径
 */
export function writeFrpcConfig(binding, localPort, file = defaultConfigFile()) {
  const config = [
    `serverAddr = ${tomlString(binding.addr)}`,
    `serverPort = ${binding.port}`,
    `auth.token = ${tomlString(binding.token)}`,
    // frps 不可达时不退出进程：重连交给 frpc 自己，避免崩溃-重启循环
    'loginFailExit = false',
    '',
    '[[proxies]]',
    'name = "dsh-remote-x"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
    `remotePort = ${binding.remotePort}`,
    '',
  ].join('\n')
  writeFileSync(file, config, { mode: 0o600 })
  chmodSync(file, 0o600) // 已存在文件不受 mode 影响，补一次收敛权限
  return file
}

/**
 * 删除本插件生成的配置（解绑时；用户自己的配置不受影响）。
 * @param {string} [file] 配置路径
 */
export function removeFrpcConfig(file = defaultConfigFile()) {
  try { unlinkSync(file) } catch { /* 本来就没有 */ }
}

/**
 * /proc/<pid>/cmdline 是否为本插件拉起的 frpc（含 frpc 与本插件配置名两个标记，
 * 防 PID 复用误杀；用户 frpc.service 的配置名不同，不会命中）。
 * @param {number} pid 进程号
 * @param {string} configFile 本插件配置路径
 * @returns {boolean} 是否确认是我们的进程
 */
function isOurFrpc(pid, configFile) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmdline.includes('frpc') && cmdline.includes(path.basename(configFile))
  } catch {
    return false
  }
}

/**
 * 清扫孤儿 frpc：上一个 dsh 进程被强杀后它还活着，不清扫就会"假关"
 * （界面显示停用，隧道实际仍挂在公网上）。绝不触碰用户自己的 frpc.service。
 * @param {string} [pidFile] pid 文件路径（测试注入）
 * @param {string} [configFile] 本插件配置路径（pid 校验用）
 * @returns {Promise<boolean>} 是否清掉了至少一个进程
 */
export async function sweepOrphanFrpc(pidFile = defaultPidFile(), configFile = defaultConfigFile()) {
  let killed = false
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isInteger(pid) && pid > 0 && isOurFrpc(pid, configFile)) {
      process.kill(pid, 'SIGTERM')
      killed = true
    }
  } catch { /* pidfile 不存在或 pid 不可信：跳过 */ }
  try { unlinkSync(pidFile) } catch { /* 本来就没有 */ }
  try {
    // 兜底：早期版本没有 pidfile 也可能留过孤儿。模式锁定"frpc -c + 本插件
    // 配置完整路径"：用户 frpc.service 用 ~/.config/frp/frpc.toml 不会命中，
    // 测试注入的临时路径也不会误伤生产实例。
    const pattern = `frpc -c ${configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    await new Promise((resolve) => {
      execFile('pkill', ['-f', pattern], { timeout: 5_000 }, (error) => {
        if (!error) killed = true
        resolve()
      })
    })
  } catch { /* pkill 不存在/不可用：接受 */ }
  return killed
}

/**
 * 启动 frpc：先停本实例旧进程、扫上一进程孤儿，再按绑定参数生成配置并拉起。
 * 成功判定：看到 frpc 注册成功日志；超时仍存活也算启动成功（连接问题由 frpc
 * 自行重连，详情进 lastError）；进程已退出则 reject。
 *
 * @param {{addr: string, port: number, token: string, remotePort: number}} binding 绑定参数
 * @param {number} localPort 本机代理端口
 * @param {{onError?: (info: {kind: string, error: Error}) => void, configFile?: string, pidFile?: string, startTimeoutMs?: number}} [opts] 配置/测试注入项
 * @returns {Promise<{running: boolean, pid: number | null}>} 启动结果
 */
export async function startFrpc(binding, localPort, opts = {}) {
  const configFile = opts.configFile ?? defaultConfigFile()
  const pidFile = opts.pidFile ?? defaultPidFile()
  const startTimeoutMs = opts.startTimeoutMs ?? 4_000

  stopFrpc()
  await sweepOrphanFrpc(pidFile, configFile)
  writeFrpcConfig(binding, localPort, configFile)
  state.running = false
  state.pid = null
  state.since = 0
  state.lastError = null

  const bin = resolveFrpcBinary()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-c', configFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    currentChild = child
    stopping = false
    if (child.pid) {
      // pidfile 供下一次启动（或插件重载）清扫孤儿
      try { writeFileSync(pidFile, String(child.pid)) } catch { /* 尽力 */ }
    }

    let settled = false
    const tail = []
    const succeed = () => {
      if (settled) return
      settled = true
      state.running = true
      state.pid = child.pid ?? null
      state.since = Date.now()
      resolve({ running: true, pid: child.pid ?? null })
    }

    const scan = (data) => {
      for (const line of String(data).split('\n')) {
        const text = line.trim()
        if (text === '') continue
        tail.push(text)
        if (tail.length > 20) tail.shift()
        // 登录失败不是进程失败（loginFailExit=false 会重试），但状态行要可见
        if (/login to server failure|connect to server.*fail|token.*(incorrect|invalid)|authentication failed/i.test(text)) {
          state.lastError = text
        }
        if (/start proxy success|login to server success/i.test(text)) succeed()
      }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)

    child.on('error', (error) => {
      if (settled) {
        opts.onError?.({ kind: 'runtime', error })
        return
      }
      settled = true
      state.running = false
      state.pid = null
      state.lastError = error.code === 'ENOENT'
        ? `未找到 frpc：安装 frpc 或放入 ${path.join(homedir(), '.local', 'bin')}`
        : `frpc 启动失败：${error.message}`
      reject(new Error(state.lastError))
    })

    child.on('exit', (code, signal) => {
      const active = currentChild === child
      if (active) currentChild = null
      // stopFrpc 后紧跟新实例：旧进程的退出属于陈旧事件，pidfile 已归新实例
      if (!active) return
      try { unlinkSync(pidFile) } catch { /* 尽力 */ }
      const wasStopping = stopping
      stopping = false
      state.running = false
      state.pid = null
      if (wasStopping) return
      const reason = signal !== null && signal !== undefined
        ? `frpc 被信号 ${signal} 终止`
        : `frpc 已退出（code ${code}）${tail.length > 0 ? `：${tail.at(-1)}` : ''}`
      state.lastError = reason
      if (!settled) {
        settled = true
        reject(new Error(reason))
        return
      }
      opts.onError?.({ kind: 'exit', error: new Error(reason) })
    })

    setTimeout(() => {
      // 超时仍存活：算启动成功（连接细节已在 lastError），不无限等日志
      if (!settled) succeed()
    }, startTimeoutMs).unref?.()
  })
}

/**
 * 停掉本插件拉起的 frpc（SIGTERM；状态与 pidfile 由其 exit 处理器收敛）。
 * 幂等：没有在跑的实例直接返回。绝不触碰用户自己的 frpc 进程。
 */
export function stopFrpc() {
  const child = currentChild
  if (child === null) return
  stopping = true
  state.running = false
  state.pid = null
  try { child.kill('SIGTERM') } catch { /* 已退出：exit 事件会兜底 */ }
}

/**
 * 当前 frpc 运行状态快照（卡片状态行数据源）。
 * @returns {{running: boolean, pid: number | null, since: number, lastError: string | null}} 状态
 */
export function frpcStatus() {
  return { running: state.running, pid: state.pid, since: state.since, lastError: state.lastError }
}
