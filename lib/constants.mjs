export const TOKEN_CACHE_MS = 5_000
export const LOG_TAIL_BYTES = 65_536
export const NONCE_TTL_MS = 10 * 60_000
export const MAX_BODY_BYTES = 4_000_000
export const TUNNEL_TIMEOUT_MS = 30_000
export const MAX_SOCKETS = 16
/** 等上游响应头的上限：dsh 在本机回环，正常毫秒级；超时即销毁重试（proxy.mjs） */
export const UPSTREAM_HEADER_TIMEOUT_MS = 10_000
export const QR_CACHE_MAX = 64
export const BACKOFF_SCHEDULE = [1_000, 2_000, 4_000, 8_000, 16_000, 60_000]
export const HEALTH_CHECK_MAX_FAILURES = 3
export const HEALTH_CHECK_INTERVAL_MS = 30_000
export const HEAD_BUFFER_BYTES = 32
export const COMPRESS_MIN_BYTES = 1_024
export const REMEMBER_COOKIE_MAX_AGE = 31_536_000