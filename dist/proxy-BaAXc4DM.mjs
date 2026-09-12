import { i as REMEMBER_COOKIE_MAX_AGE, r as LOG_TAIL_BYTES, s as UPSTREAM_HEADER_TIMEOUT_MS } from "./constants-CAvHiWEl.mjs";
import { open } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import "node:os";
import "node:path";
import { Agent, createServer, request } from "node:http";
import { brotliDecompressSync, createGzip, gunzipSync, inflateSync } from "node:zlib";
import { Transform } from "node:stream";
//#region lib/agent.mjs
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
var UpstreamAgent = class {
	constructor({ keepAlive = false, maxSockets = 16 } = {}) {
		this._agent = new Agent({
			keepAlive,
			maxSockets
		});
	}
	get agent() {
		return this._agent;
	}
	getConnectionStats() {
		const sockets = this._agent.sockets;
		let created = 0;
		for (const key of Object.keys(sockets ?? {})) created += sockets[key]?.length ?? 0;
		return {
			created,
			reused: 0,
			pending: this._agent.totalSocketCount - created,
			free: 0
		};
	}
	destroy() {
		this._agent.destroy();
	}
};
//#endregion
//#region lib/compress.mjs
/**
* Stream transform: decompress data with the given encoding.
*/
var DecompressTransform = class extends Transform {
	constructor(encoding) {
		super();
		this._encoding = encoding;
		this._chunks = [];
	}
	_transform(chunk, _enc, cb) {
		this._chunks.push(chunk);
		cb();
	}
	_flush(cb) {
		const buf = Buffer.concat(this._chunks);
		if (buf.length > 0) {
			let out;
			if (this._encoding === "br") out = brotliDecompressSync(buf);
			else if (this._encoding === "gzip") out = gunzipSync(buf);
			else out = inflateSync(buf);
			this.push(out);
		}
		cb();
	}
};
/**
* Stream transform: inject polyfill script after <head> tag.
* Detects <head> across chunk boundaries with a small tail buffer.
* Guarantees single injection.
*/
var PolyfillInjectTransform = class extends Transform {
	constructor(polyfill, marker = "data-dsh-remote-x-polyfill") {
		super();
		this._polyfill = polyfill;
		this._marker = marker;
		this._injected = false;
		this._buffer = "";
		this._buffering = true;
	}
	_transform(chunk, _enc, cb) {
		if (this._injected) {
			this.push(chunk);
			cb();
			return;
		}
		if (this._buffering) {
			this._buffer += chunk.toString("utf8");
			if (this._buffer.includes(this._marker)) {
				this._injected = true;
				this.push(Buffer.from(this._buffer, "utf8"));
				this._buffer = "";
				this._buffering = false;
				cb();
				return;
			}
			const headMatch = /<head([^>]*)>/i.exec(this._buffer);
			if (headMatch) {
				const idx = headMatch.index + headMatch[0].length;
				const before = this._buffer.slice(0, idx);
				const after = this._buffer.slice(idx);
				this._injected = true;
				this._buffering = false;
				this._buffer = "";
				this.push(Buffer.from(before + this._polyfill + after, "utf8"));
				cb();
				return;
			}
			if (this._buffer.length > 32) {
				const keep = this._buffer.slice(-32);
				const flush = this._buffer.slice(0, this._buffer.length - 32);
				this._buffer = keep;
				this.push(Buffer.from(flush, "utf8"));
			}
			cb();
		} else {
			this.push(chunk);
			cb();
		}
	}
	_flush(cb) {
		if (this._buffer) {
			this.push(Buffer.from(this._buffer, "utf8"));
			this._buffer = "";
		}
		cb();
	}
};
//#endregion
//#region lib/timing-safe-equal.mjs
/**
* Constant-time string comparison to prevent timing attacks.
* Equal-length strings use crypto.timingSafeEqual directly.
* Unequal-length strings are hashed first to avoid length leakage.
*/
function timingSafeEqualStr(a, b) {
	if (a.length !== b.length) {
		const ha = createHash("sha256").update(a).digest();
		const hb = createHash("sha256").update(b).digest();
		try {
			timingSafeEqual(ha, hb);
		} catch {}
		return false;
	}
	return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
//#endregion
//#region lib/proxy.mjs
const DEFAULT_UPSTREAM = {
	host: "127.0.0.1",
	port: 3080
};
const REMEMBER_COOKIE = "remote-x-key";
const TOKEN_RE = /token=([A-Za-z0-9_-]+)/g;
/**
* 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，dsh 连接层会用：
*   1. crypto.randomUUID —— 缺了 mint RPC id 直接抛错；
*   2. AbortSignal.any —— 老版本 Android WebView 没有，消息发不出去。
* 带 data-dsh-remote-x-polyfill 标记做判重，避免页面里恰好出现同名字串时误判。
*/
const POLYFILL = `<script data-dsh-remote-x-polyfill="1">!function(){try{
if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}
if(typeof AbortSignal!=="undefined"&&!AbortSignal.any){AbortSignal.any=function(signals){var c=new AbortController();var list=signals||[];for(var i=0;i<list.length;i++){var s=list[i];if(!s)continue;if(s.aborted){c.abort(s.reason);break;}s.addEventListener&&s.addEventListener("abort",function(){c.abort(s.reason);});}return c.signal;};}
if(typeof AbortSignal!=="undefined"&&!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new Error("Timeout"));},ms);return c.signal;};}
if(!Array.prototype.at){Array.prototype.at=function(n){var l=this.length;n=Math.trunc(n)||0;if(n<0)n+=l;if(n<0||n>=l)return undefined;return this[n];};}
if(typeof self.structuredClone==="undefined"){self.structuredClone=function(o){return JSON.parse(JSON.stringify(o));};}
}catch(e){}}();<\/script>`;
let tokenCache = {
	value: void 0,
	at: 0
};
/** 扫描 dsh 启动日志尾部，取最新一次打印的 `?token=` 登录口令。 */
async function readDshToken(tokenFile) {
	if (Date.now() - tokenCache.at < 5e3) return tokenCache.value;
	let value;
	try {
		const handle = await open(tokenFile, "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - LOG_TAIL_BYTES);
			const buf = Buffer.alloc(size - start);
			await handle.read(buf, 0, buf.length, start);
			value = [...buf.toString("utf8").matchAll(TOKEN_RE)].at(-1)?.[1];
		} finally {
			await handle.close();
		}
	} catch {
		value = void 0;
	}
	tokenCache = {
		value,
		at: Date.now()
	};
	return value;
}
function cookieHas(headers, prefix) {
	const raw = headers.cookie;
	if (typeof raw !== "string") return false;
	return raw.split(";").some((c) => c.trim().startsWith(prefix));
}
/** 把 set-cookie 值合并进（可能为数组的）响应头，返回新头对象。 */
function mergeSetCookie(headers, extra) {
	const existing = headers["set-cookie"];
	const list = Array.isArray(existing) ? [...existing] : existing ? [existing] : [];
	list.push(extra);
	return {
		...headers,
		"set-cookie": list
	};
}
/** 把入站请求头改写成 loopback 权威，并去掉压缩以便注入/改写响应体。 */
function rewriteRequestHeaders(headers, upstream) {
	const out = { ...headers };
	out.host = `${upstream.host}:${upstream.port}`;
	if (out.origin) out.origin = `http://${upstream.host}:${upstream.port}`;
	if (out.referer) out.referer = String(out.referer).replace(/^https?:\/\/[^/]+/, `http://${upstream.host}:${upstream.port}`);
	delete out["content-length"];
	return out;
}
/** 把上游响应头里的绝对地址改回对外可访问的形式。 */
function rewriteResponseHeaders(headers, upstream) {
	const out = { ...headers };
	const upstreamAuthority = `${upstream.host}:${upstream.port}`;
	for (const key of [
		"location",
		"content-location",
		"referer"
	]) {
		const value = out[key];
		if (typeof value === "string" && value.includes(upstreamAuthority)) out[key] = value.replace(new RegExp(`https?://${upstreamAuthority.replace(".", "\\.")}`, "g"), "");
	}
	delete out["content-length"];
	delete out["transfer-encoding"];
	delete out["content-security-policy"];
	return out;
}
/** 是否值得注入 polyfill（只处理 HTML 文档）。 */
function isHtml(headers) {
	return /text\/html/i.test(String(headers["content-type"] ?? ""));
}
/**
* 给 upgrade 拿到的裸 socket 挂上 'error' 兜底。
*
* `upgrade` 事件交出的是裸 `net.Socket`，不是 `ServerResponse`：Node 的 http
* 服务器只替普通请求的 socket 挂了 error 监听，upgrade 路径完全由我们自己负责。
* 漏挂的后果不是"这条连接报个错"，而是整个进程被 Node 结束——对端用一个 RST
* 回应我们刚写的 401/500/502 响应时，错误事件无人接管，Node 直接
* `throw er; // Unhandled 'error' event` 并 exit 1（实测复现，堆栈与生产崩溃逐字节一致）。
*
* 认证失败与上游不可达恰恰是最常见的两条路径，它们都只写一个响应就返回，
* 覆盖不到"成功升级后"才建立的 pipe 级监听（见本函数调用点下方的 cleanup）。
* 因此兜底必须挂在 handler 入口，而不是散落在各分支里。
*
* destroy() 幂等，与成功分支自己的 cleanup 并存无副作用。
*
* @param socket 本次 upgrade 的客户端裸 socket
*/
function guardUpgradeSocket(socket) {
	socket.on("error", () => socket.destroy());
}
/**
* 在转发 URL 上追加 dsh 登录口令（先清掉可能残留的旧 token）。
* 纯字符串操作：`new URL()` 会破坏 DSH 的 `??` 拼接格式。
*/
function withToken(raw, token) {
	let out = raw.replace(/([?&])token=[^&]*/g, "$1");
	out = out.replace(/\?&/, "?").replace(/&&+/g, "&").replace(/[?&]$/, "");
	return out + (out.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}
/**
* 启动反代。
* @param {object} options
* @param {number} options.port 对外监听端口
* @param {string} [options.host] 对外监听地址，默认 0.0.0.0（手机/隧道可达）
* @param {{host: string, port: number}} [options.upstream] dsh web 地址
* @param {string} [options.accessKey] 固定访问口令（?key=）；设置后未携带且未登录的请求 401
* @param {string} [options.token] dsh 登录口令（进程内直传，优先于 tokenFile）
* @param {string} [options.tokenFile] dsh 启动日志路径（用于动态代换最新登录口令）
* @param {(info: object) => void} [options.onError]
* @returns {Promise<import('node:http').Server>}
*/
function startRemoteProxy(options) {
	const upstream = options.upstream ?? DEFAULT_UPSTREAM;
	const accessKey = typeof options.accessKey === "string" && options.accessKey.length > 0 ? options.accessKey : void 0;
	const staticToken = typeof options.token === "string" && options.token.length > 0 ? options.token : void 0;
	const tokenFile = options.tokenFile;
	const upstreamAgent = new UpstreamAgent(options.upstreamAgent ?? {});
	/** 校验请求的 key / 记忆 cookie / dsh 登录态，返回 URL 改写结果或 401 响应。 */
	async function gate(req) {
		let raw = req.url ?? "/";
		const authed = cookieHas(req.headers, "dsh-auth-");
		const remembered = cookieHas(req.headers, `${REMEMBER_COOKIE}=`);
		let pathKey;
		let pathToken;
		const km = /^\/k\/([^/]+)(\/[\s\S]*)?$/.exec(raw);
		if (km !== null) {
			pathKey = decodeURIComponent(km[1]);
			raw = km[2] ?? "/";
		} else {
			const tm = /^\/t\/([^/]+)(\/[\s\S]*)?$/.exec(raw);
			if (tm !== null) {
				pathToken = decodeURIComponent(tm[1]);
				raw = tm[2] ?? "/";
			}
		}
		const keyMatch = accessKey !== void 0 ? /[?&]key=([^&]*)/.exec(raw) : null;
		const keyOk = accessKey !== void 0 && (keyMatch !== null && timingSafeEqualStr(decodeURIComponent(keyMatch[1]), accessKey) || pathKey !== void 0 && timingSafeEqualStr(pathKey, accessKey));
		let tokenOk = false;
		if (!keyOk && !authed && !remembered) {
			const tokenMatch = /[?&]token=([^&]*)/.exec(raw);
			let provided = pathToken;
			if (provided === void 0 && tokenMatch !== null) provided = decodeURIComponent(tokenMatch[1].replace(/\+/g, " "));
			if (provided !== void 0 && provided.length > 0) {
				const latest = await readDshToken(tokenFile);
				tokenOk = latest !== void 0 && timingSafeEqualStr(provided, latest);
			}
			if (!tokenOk) return { denied: true };
		}
		let out = raw;
		out = out.replace(/[?&]key=[^&]*/, "");
		out = out.replace(/^\?/, "?");
		let sentToken = false;
		if (!authed && !out.startsWith("/plugins/")) if (pathToken !== void 0) {
			out += (out.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(pathToken);
			sentToken = true;
		} else if (tokenOk) sentToken = true;
		else {
			const token = staticToken ?? await readDshToken(tokenFile);
			if (token !== void 0) {
				out = withToken(out, token);
				sentToken = true;
			}
		}
		return {
			url: out,
			remember: keyOk && !authed && !remembered,
			sentToken
		};
	}
	const server = createServer(async (req, res) => {
		res.on("error", () => res.destroy());
		let gated;
		try {
			gated = await gate(req);
		} catch (error) {
			res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end(`dsh-remote-x: gate error: ${error.message}`);
			return;
		}
		if (gated.denied) {
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh-remote-x: 需要访问口令 — 在 URL 后追加 ?key=<口令>，或在设置页重新扫码");
			return;
		}
		const headers = rewriteRequestHeaders(req.headers, upstream);
		/** 把上游响应写回客户端（注入 polyfill、补记忆 cookie）。 */
		const respond = (upstreamRes) => {
			let finished = false;
			res.on("finish", () => {
				finished = true;
			});
			res.on("close", () => {
				if (!finished) upstreamRes.destroy();
			});
			upstreamRes.on("error", (error) => {
				options.onError?.({
					kind: "respond",
					error
				});
				res.destroy();
			});
			const guardStream = (stream) => stream.on("error", (error) => {
				options.onError?.({
					kind: "respond",
					error
				});
				upstreamRes.destroy();
				res.destroy();
			});
			let outHeaders = rewriteResponseHeaders(upstreamRes.headers, upstream);
			if (gated.remember) outHeaders = mergeSetCookie(outHeaders, `${REMEMBER_COOKIE}=${encodeURIComponent(accessKey)}; Path=/; HttpOnly; Max-Age=${REMEMBER_COOKIE_MAX_AGE}; SameSite=Strict`);
			if (!isHtml(upstreamRes.headers)) {
				res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
				upstreamRes.pipe(res);
				return;
			}
			const upstreamEncoding = upstreamRes.headers["content-encoding"];
			const wasCompressed = upstreamEncoding === "br" || upstreamEncoding === "gzip" || upstreamEncoding === "deflate";
			const finalHeaders = {
				...outHeaders,
				"content-type": "text/html; charset=utf-8"
			};
			delete finalHeaders["content-length"];
			delete finalHeaders["content-encoding"];
			if (wasCompressed) finalHeaders["content-encoding"] = "gzip";
			res.writeHead(upstreamRes.statusCode ?? 502, finalHeaders);
			const injector = new PolyfillInjectTransform(POLYFILL);
			guardStream(injector);
			if (wasCompressed) {
				const decompressor = new DecompressTransform(upstreamEncoding);
				const gzipStream = createGzip();
				guardStream(decompressor);
				guardStream(gzipStream);
				upstreamRes.pipe(decompressor).pipe(injector).pipe(gzipStream).pipe(res);
			} else upstreamRes.pipe(injector).pipe(res);
		};
		/** 丢掉失效的会话 cookie、改用登录口令重发一次（仅无请求体的方法）。 */
		const retryWithToken = async () => {
			const token = staticToken ?? await readDshToken(tokenFile);
			if (token === void 0) {
				if (!res.headersSent) res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote-x: 无法从 dsh 获取登录口令，请在插件配置中设置 token");
				return;
			}
			const retryHeaders = { ...headers };
			delete retryHeaders.cookie;
			const retried = request({
				host: upstream.host,
				port: upstream.port,
				path: withToken(gated.url, token),
				method: req.method,
				headers: retryHeaders,
				agent: upstreamAgent.agent
			}, respond);
			retried.on("error", (error) => {
				options.onError?.({
					kind: "proxy",
					error
				});
				if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end(`dsh-remote-x: 无法连接本机 dsh web（${upstream.host}:${upstream.port}）：${error.message}`);
			});
			retried.end();
		};
		let gotHeaders = false;
		let retried = false;
		const dispatch = (freshConnection) => {
			const proxied = request({
				host: upstream.host,
				port: upstream.port,
				path: gated.url,
				method: req.method,
				headers,
				timeout: UPSTREAM_HEADER_TIMEOUT_MS,
				agent: freshConnection ? false : upstreamAgent.agent
			}, (upstreamRes) => {
				gotHeaders = true;
				proxied.setTimeout(0);
				if (upstreamRes.statusCode === 401 && !gated.sentToken && (req.method === "GET" || req.method === "HEAD")) {
					upstreamRes.resume();
					retryWithToken().catch((error) => {
						options.onError?.({
							kind: "proxy",
							error
						});
						if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
						res.end("dsh-remote-x: 会话恢复重试失败");
					});
					return;
				}
				respond(upstreamRes);
			});
			proxied.on("timeout", () => {
				if (!gotHeaders) proxied.destroy(/* @__PURE__ */ new Error(`upstream 未在 ${UPSTREAM_HEADER_TIMEOUT_MS}ms 内返回响应头`));
			});
			proxied.on("error", (error) => {
				options.onError?.({
					kind: "proxy",
					error
				});
				if (res.headersSent) {
					res.destroy();
					return;
				}
				if (!retried && !gotHeaders && (req.method === "GET" || req.method === "HEAD")) {
					retried = true;
					dispatch(true);
					return;
				}
				const status = /timeout/i.test(error.message) ? 504 : 502;
				res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
				res.end(`dsh-remote-x: 无法连接本机 dsh web（${upstream.host}:${upstream.port}）：${error.message}`);
			});
			req.on("error", () => proxied.destroy());
			req.pipe(proxied);
		};
		dispatch(false);
	});
	server.on("upgrade", async (req, socket, head) => {
		guardUpgradeSocket(socket);
		let gated;
		try {
			gated = await gate(req);
		} catch {
			socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
			socket.destroy();
			return;
		}
		if (gated.denied) {
			socket.end("HTTP/1.1 401 Unauthorized\r\n\r\ndsh-remote-x: 需要访问口令 (?key=)");
			socket.destroy();
			return;
		}
		const headers = rewriteRequestHeaders(req.headers, upstream);
		const proxied = request({
			host: upstream.host,
			port: upstream.port,
			path: gated.url,
			method: req.method,
			headers: {
				...headers,
				connection: "upgrade",
				upgrade: req.headers.upgrade ?? "websocket"
			},
			agent: upstreamAgent.agent
		});
		proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
			const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`;
			const headLines = [];
			for (const [key, value] of Object.entries(upstreamRes.headers)) {
				if (key.toLowerCase() === "content-encoding") continue;
				if (Array.isArray(value)) value.forEach((v) => headLines.push(`${key}: ${v}`));
				else headLines.push(`${key}: ${value}`);
			}
			socket.write([
				statusLine,
				...headLines,
				"",
				""
			].join("\r\n"));
			if (upstreamHead?.length) socket.write(upstreamHead);
			if (head?.length) upstreamSocket.write(head);
			upstreamSocket.pipe(socket);
			socket.pipe(upstreamSocket);
			const cleanup = () => {
				socket.destroy();
				upstreamSocket.destroy();
			};
			socket.on("error", cleanup);
			upstreamSocket.on("error", cleanup);
		});
		proxied.on("error", (error) => {
			options.onError?.({
				kind: "upgrade",
				error
			});
			socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\ndsh-remote-x: upstream unavailable: ${error.message}`);
			socket.destroy();
		});
		proxied.end();
	});
	const onSigterm = () => upstreamAgent.destroy();
	process.on("SIGTERM", onSigterm);
	server.on("close", () => {
		upstreamAgent.destroy();
		process.off("SIGTERM", onSigterm);
	});
	return new Promise((resolve, reject) => {
		const tryListen = (host, isFallback) => {
			const onListen = () => {
				cleanup();
				resolve(server);
			};
			const onError = (error) => {
				cleanup();
				if (!isFallback && host === "::" && error?.code === "EADDRNOTAVAIL") {
					tryListen("0.0.0.0", true);
					return;
				}
				reject(error);
			};
			const cleanup = () => {
				server.off("listening", onListen);
				server.off("error", onError);
			};
			server.once("listening", onListen);
			server.once("error", onError);
			server.listen(options.port, host);
		};
		tryListen(options.host ?? "::", false);
	});
}
//#endregion
export { startRemoteProxy };
