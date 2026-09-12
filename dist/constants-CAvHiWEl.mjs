//#region lib/constants.mjs
const TOKEN_CACHE_MS = 5e3;
const LOG_TAIL_BYTES = 65536;
const TUNNEL_TIMEOUT_MS = 3e4;
/** 等上游响应头的上限：dsh 在本机回环，正常毫秒级；超时即销毁重试（proxy.mjs） */
const UPSTREAM_HEADER_TIMEOUT_MS = 1e4;
const BACKOFF_SCHEDULE = [
	1e3,
	2e3,
	4e3,
	8e3,
	16e3,
	6e4
];
const HEALTH_CHECK_INTERVAL_MS = 3e4;
const REMEMBER_COOKIE_MAX_AGE = 31536e3;
//#endregion
export { TOKEN_CACHE_MS as a, REMEMBER_COOKIE_MAX_AGE as i, HEALTH_CHECK_INTERVAL_MS as n, TUNNEL_TIMEOUT_MS as o, LOG_TAIL_BYTES as r, UPSTREAM_HEADER_TIMEOUT_MS as s, BACKOFF_SCHEDULE as t };
