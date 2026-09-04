// 局域网地址探测：给用户可直接在手机浏览器里输入的地址。
import { networkInterfaces } from 'node:os'

/** 私有网段判定，避免把虚拟网卡/容器网段当成"手机能连的局域网地址"。 */
function isPrivateV4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 192) return false
  if (parts[0] === 192 && parts[1] === 168) return true
  return false
}

/**
 * 本机局域网 IPv4 列表（已排除 loopback / docker / 虚拟网卡中的公网地址）。
 * @returns {string[]} 形如 ['192.168.5.8']
 */
export function lanIPv4() {
  const found = []
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const info of ifaces ?? []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue
      if (info.internal) continue
      if (!isPrivateV4(info.address)) continue
      found.push(info.address)
    }
  }
  return [...new Set(found)]
}

/** 首选局域网地址（挑最常见的 192.168.* / 10.*）。 */
export function preferredLanIPv4() {
  const list = lanIPv4()
  return list.find(ip => ip.startsWith('192.168.')) ?? list.find(ip => ip.startsWith('10.')) ?? list[0]
}

/** 校验 IPv4 字面量（供 --lan-ip 覆盖参数使用）。 */
export function isValidIpv4(value) {
  const m = String(value ?? '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return m !== null && m.slice(1).every(part => {
    const n = Number(part)
    return n >= 0 && n <= 255
  })
}
