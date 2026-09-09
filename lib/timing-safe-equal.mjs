import { timingSafeEqual, createHash } from 'node:crypto'

/**
 * Constant-time string comparison to prevent timing attacks.
 * Equal-length strings use crypto.timingSafeEqual directly.
 * Unequal-length strings are hashed first to avoid length leakage.
 */
export function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) {
    const ha = createHash('sha256').update(a).digest()
    const hb = createHash('sha256').update(b).digest()
    try { timingSafeEqual(ha, hb) } catch { /* lengths always match here */ }
    return false
  }
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return timingSafeEqual(ba, bb)
}