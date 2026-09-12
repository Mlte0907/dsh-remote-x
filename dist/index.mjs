import { n as HEALTH_CHECK_INTERVAL_MS, o as TUNNEL_TIMEOUT_MS, t as BACKOFF_SCHEDULE } from "./constants-CAvHiWEl.mjs";
import { open, readFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import z from "@deepseek-ai/schemastery";
//#region lib/tunnel-supervisor.mjs
/**
* Tunnel supervisor: manages child lifecycle with exponential backoff reconnection.
* State machine: connected → reconnecting → connected/disconnected
*/
var TunnelSupervisor = class {
	constructor({ startChild, onStateChange, maxReconnect = 10, healthCheckMs = HEALTH_CHECK_INTERVAL_MS, metricsPort = 0 } = {}) {
		this._startChild = startChild;
		this._onStateChange = onStateChange;
		this._maxReconnect = maxReconnect;
		this._healthCheckMs = healthCheckMs;
		this._metricsPort = metricsPort;
		this._state = "disconnected";
		this._child = null;
		this._currentAttempt = 0;
		this._reconnectCount = 0;
		this._stopping = false;
		this._reconnectTimer = null;
		this._healthChecker = null;
	}
	get state() {
		return this._state;
	}
	get reconnectCount() {
		return this._reconnectCount;
	}
	get child() {
		return this._child;
	}
	_setState(state) {
		this._state = state;
		this._onStateChange?.(state);
	}
	async start() {
		this._stopping = false;
		await this._spawn();
	}
	async _spawn() {
		try {
			const result = await this._startChild();
			this._child = result.child ?? null;
			this._currentAttempt = 0;
			this._setState("connected");
			if (this._child) this._child.on("exit", (code, signal) => {
				if (this._stopping) return;
				this._onExit(code, signal);
			});
			return result;
		} catch (err) {
			this._onExit(1, null);
			throw err;
		}
	}
	_onExit(_code, _signal) {
		this._child = null;
		if (this._reconnectCount >= this._maxReconnect) {
			this._setState("disconnected");
			return;
		}
		this._setState("reconnecting");
		const delay = BACKOFF_SCHEDULE[Math.min(this._currentAttempt, BACKOFF_SCHEDULE.length - 1)];
		this._currentAttempt += 1;
		this._reconnectCount += 1;
		this._reconnectTimer = setTimeout(async () => {
			try {
				await this._spawn();
			} catch {
				this._onExit(1, null);
			}
		}, delay);
	}
	stop() {
		this._stopping = true;
		if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
		if (this._healthChecker) this._healthChecker.stop();
		if (this._child) try {
			this._child.kill("SIGTERM");
		} catch {}
		this._setState("disconnected");
	}
	async reconnect() {
		if (this._child) try {
			this._child.kill("SIGTERM");
		} catch {}
	}
	getRuntimeState() {
		return {
			status: this._state,
			reconnectCount: this._reconnectCount,
			child: this._child
		};
	}
};
/**
* Health checker: probes the tunnel URL periodically.
* After maxFailures consecutive failures, triggers onUnhealthy.
*/
var TunnelHealthChecker = class {
	constructor({ probeUrl, intervalMs = HEALTH_CHECK_INTERVAL_MS, maxFailures = 3, onUnhealthy } = {}) {
		this._probeUrl = probeUrl;
		this._intervalMs = intervalMs;
		this._maxFailures = maxFailures;
		this._onUnhealthy = onUnhealthy;
		this._failCount = 0;
		this._latencyMs = null;
		this._timer = null;
	}
	start() {
		this._timer = setInterval(() => this._probe(), this._intervalMs);
	}
	stop() {
		if (this._timer) clearInterval(this._timer);
		this._timer = null;
	}
	async _probe() {
		const start = Date.now();
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5e3);
			await fetch(this._probeUrl, {
				method: "HEAD",
				signal: controller.signal
			});
			clearTimeout(timeout);
			this._latencyMs = Date.now() - start;
			this._failCount = 0;
		} catch {
			this._failCount += 1;
			if (this._failCount >= this._maxFailures) this._onUnhealthy?.();
		}
	}
	getLatencyMs() {
		return this._latencyMs;
	}
};
/**
* Metrics scraper: fetches Prometheus metrics from cloudflared --metrics endpoint.
*/
var TunnelMetrics = class {
	constructor(metricsPort = 0) {
		this._metricsPort = metricsPort;
		this._timer = null;
		this._metrics = {
			totalStreams: 0,
			latencyMs: 0,
			reconnects: 0,
			raw: ""
		};
	}
	start() {
		if (this._metricsPort === 0) return;
		this._timer = setInterval(() => this._scrape(), 1e4);
	}
	stop() {
		if (this._timer) clearInterval(this._timer);
		this._timer = null;
	}
	async _scrape() {
		try {
			const text = await (await fetch(`http://127.0.0.1:${this._metricsPort}/metrics`)).text();
			this._metrics.raw = text;
			const streamMatch = /tunnel_total_streams\s+(\d+)/.exec(text);
			const latencyMatch = /latency\s+([\d.]+)/.exec(text);
			const reconnectMatch = /reconnects\s+(\d+)/.exec(text);
			if (streamMatch) this._metrics.totalStreams = parseInt(streamMatch[1], 10);
			if (latencyMatch) this._metrics.latencyMs = parseFloat(latencyMatch[1]);
			if (reconnectMatch) this._metrics.reconnects = parseInt(reconnectMatch[1], 10);
		} catch {}
	}
	getMetrics() {
		return { ...this._metrics };
	}
};
/**
* Resolve the nearest Cloudflare edge region.
* 'auto' probes via /cdn-cgi/trace; explicit regions pass through.
*/
async function resolveTunnelRegion(region = "auto") {
	if (region !== "auto") return region;
	try {
		const text = await (await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(3e3) })).text();
		const locMatch = /loc=(\w+)/.exec(text);
		if (locMatch) {
			const loc = locMatch[1];
			if ([
				"CN",
				"HK",
				"TW",
				"JP",
				"KR"
			].includes(loc)) return "ap";
			if ([
				"US",
				"CA",
				"MX"
			].includes(loc)) return "us";
			return "eu";
		}
	} catch {}
	return "auto";
}
//#endregion
//#region lib/tunnel.mjs
const TMP_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** 记录当前 cloudflared 的 pid，供进程异常退出后下一次启动清扫孤儿。 */
function pidFilePath() {
	return path.join(homedir(), ".dsh", "remote-x-cloudflared.pid");
}
/** /proc/<pid>/cmdline 是否确实是本插件的 cloudflared（防 PID 复用误杀）。 */
function isOurCloudflared(pid) {
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		return cmdline.includes("cloudflared") && cmdline.includes("--url");
	} catch {
		return false;
	}
}
/**
* 清扫孤儿隧道进程。
*
* cloudflared 是插件 spawn 的子进程，dsh 崩溃/被 kill -9 时它不会跟着死，
* 变成孤儿后隧道仍然挂在公网上，而新进程内存里的开关状态是"已停用"——
* 公网等于假关。启动隧道前和插件加载时都应清扫：
*   1. pidfile 记录的 pid（校验 /proc cmdline 确实是 cloudflared --url）；
*   2. pkill 兜底匹配精确的 `cloudflared tunnel --url http://127.0.0.1:<port>`。
* @returns {Promise<boolean>} 是否清掉了至少一个进程
*/
async function sweepOrphanTunnel(port) {
	let killed = false;
	const pidFile = pidFilePath();
	try {
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		if (Number.isInteger(pid) && pid > 0 && isOurCloudflared(pid)) {
			process.kill(pid, "SIGTERM");
			killed = true;
		}
	} catch {}
	try {
		unlinkSync(pidFile);
	} catch {}
	try {
		const { execFile } = await import("node:child_process");
		await new Promise((resolve) => {
			execFile("pkill", ["-f", `cloudflared tunnel --url http://127.0.0.1:${port}`], { timeout: 5e3 }, (err) => {
				if (!err) killed = true;
				resolve();
			});
		});
	} catch {}
	return killed;
}
function resolveBinary() {
	const candidates = [
		path.join(homedir(), ".local", "bin", "cloudflared"),
		path.join(homedir(), "bin", "cloudflared"),
		"/usr/local/bin/cloudflared",
		"/opt/homebrew/bin/cloudflared",
		"/usr/bin/cloudflared",
		"cloudflared"
	];
	for (const candidate of candidates) {
		if (candidate === "cloudflared") return candidate;
		if (existsSync(candidate)) return candidate;
	}
	return "cloudflared";
}
/**
* 启动 cloudflared 隧道，指向本机代理端口。
* @param {number} port 本机代理端口（默认 3081）
* @param {object} [opts]
* @returns {Promise<{ url: string, child: ChildProcess, stop: () => void, runtime: TunnelRuntimeState }>}
*/
async function startTunnel(port, opts = {}) {
	const { token, domain, region = "auto", protocol = "quic", metricsPort = 0, reconnect = true, healthCheckMs, maxReconnect, onStateChange } = opts;
	const resolvedRegion = await resolveTunnelRegion(region);
	let tunnelUrl = null;
	let tunnelProtocol = protocol;
	await sweepOrphanTunnel(port);
	function buildArgs() {
		const args = [];
		if (token && domain) args.push("tunnel", "--token", token);
		else args.push("tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate");
		if (resolvedRegion !== "auto") args.push("--region", resolvedRegion);
		if (protocol) args.push("--protocol", protocol);
		if (metricsPort > 0) args.push("--metrics", `127.0.0.1:${metricsPort}`);
		return args;
	}
	function startChild() {
		return new Promise((resolveChild, rejectChild) => {
			const args = buildArgs();
			const child = spawn(resolveBinary(), args, { stdio: [
				"ignore",
				"pipe",
				"pipe"
			] });
			if (child.pid) try {
				writeFileSync(pidFilePath(), String(child.pid));
			} catch {}
			let settled = false;
			const finish = (fn, value) => {
				if (!settled) {
					settled = true;
					fn(value);
				}
			};
			const scan = (text) => {
				if (/fallback to http2/i.test(text)) tunnelProtocol = "http2";
				if (token && domain) {
					tunnelUrl = `https://${domain}`;
					finish(resolveChild, {
						child,
						url: tunnelUrl
					});
					return;
				}
				const match = TMP_RE.exec(text);
				if (match) {
					tunnelUrl = match[0];
					finish(resolveChild, {
						child,
						url: tunnelUrl
					});
				}
			};
			child.stdout.on("data", (data) => scan(String(data)));
			child.stderr.on("data", (data) => scan(String(data)));
			child.on("error", (err) => {
				if (err.code === "ENOENT") finish(rejectChild, /* @__PURE__ */ new Error("未找到 cloudflared：macOS 用 `brew install cloudflared`，其它平台见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"));
				else finish(rejectChild, /* @__PURE__ */ new Error(`cloudflared 启动失败：${err.message}`));
			});
			setTimeout(() => {
				finish(rejectChild, /* @__PURE__ */ new Error("cloudflared 启动超时（30s 内未拿到隧道地址）"));
			}, TUNNEL_TIMEOUT_MS);
		});
	}
	if (!reconnect) {
		const result = await startChild();
		return {
			url: result.url,
			child: result.child,
			stop: () => {
				try {
					result.child.kill("SIGTERM");
				} catch {}
				try {
					unlinkSync(pidFilePath());
				} catch {}
			},
			runtime: {
				url: result.url,
				status: "connected",
				region: resolvedRegion,
				protocol: tunnelProtocol,
				reconnectCount: 0,
				latencyMs: null
			}
		};
	}
	const supervisor = new TunnelSupervisor({
		startChild,
		onStateChange,
		maxReconnect,
		healthCheckMs,
		metricsPort
	});
	const url = (await supervisor.start())?.url ?? tunnelUrl;
	const healthChecker = new TunnelHealthChecker({
		probeUrl: url,
		intervalMs: healthCheckMs,
		onUnhealthy: () => supervisor.reconnect()
	});
	healthChecker.start();
	const metrics = new TunnelMetrics(metricsPort);
	metrics.start();
	const runtime = {
		url,
		status: supervisor.state,
		region: resolvedRegion,
		protocol: tunnelProtocol,
		reconnectCount: supervisor.reconnectCount,
		latencyMs: () => healthChecker.getLatencyMs(),
		child: supervisor.child,
		stop: () => {
			healthChecker.stop();
			metrics.stop();
			supervisor.stop();
			try {
				unlinkSync(pidFilePath());
			} catch {}
		},
		supervisor,
		metrics
	};
	return {
		url,
		child: supervisor.child,
		stop: runtime.stop,
		runtime
	};
}
//#endregion
//#region src/index.ts
/**
* dsh-remote-x — DSH 网页端移动适配层 + 远程接入信息面板。
*
* 两件事：
* 1. 经 `webserver/index-inject` 向网页端注入移动端覆盖 CSS：窄屏（默认 <768px）
*    时把三栏 grid 单列化，其余全部复用网页端自身。宽屏零影响。
* 2. 恢复设置页「远程控制」标签（client 半，见 src/client/index.ts）背后的
*    数据 API：拼好手机访问地址（局域网 + proxy 端口 + 登录口令）并生成二维码。
*    API 挂在 DSH 原生认证墙内（同源已登录方可访问），口令不进 window 全局。
*
* 布局锚点基于探针实测（2026-09-03）：dsh-web-app 的 CSS Modules hash 只在前缀，
* 后缀语义化且全页唯一（_frame / _sidebarCol / _centerCol / _detailsCol），
* 因此用 [class*="_xxx"] 后缀匹配，不依赖会变的 hash。
*/
/** Stable Cordis plugin name. */
const name = "dsh-remote-x";
/** Services required before apply runs. */
const inject = [
	"webServer",
	"sessions",
	"agents",
	"connection"
];
const Config = z.object({
	breakpoint: z.number().default(768),
	proxyPort: z.number().default(3081),
	title: z.string().default("远程控制"),
	token: z.string(),
	accessKey: z.string(),
	cloudflareToken: z.string(),
	publicDomain: z.string(),
	tunnelRegion: z.string().default("auto"),
	tunnelProtocol: z.string().default("quic"),
	tunnelReconnect: z.boolean().default(true),
	tunnelMetricsPort: z.number().default(0),
	tunnelHealthCheckMs: z.number().default(3e4),
	tunnelMaxReconnect: z.number().default(10),
	proxyKeepAlive: z.boolean().default(true),
	proxyCompress: z.boolean().default(true),
	debug: z.boolean().default(false)
});
const TOKEN_RE = /token=([A-Za-z0-9_-]+)/g;
/**
* 首选口令来源：Connection 的进程启动口令交换。
*
* 原来的两级回落（webServer 软探测 + 启动日志扫描）都依赖运气：前者要求
* webServer 上恰好有个 token 形状的字符串字段，后者要求 dsh 把带 token 的
* URL 写进 ~/.dsh/desktop/backend.log —— 而源码态 / journald 部署根本没有
* 这个日志文件，于是 tokenDetected 恒为 false，代理拿不到口令，手机一律 401。
* `connection.authenticatedUrl()` 是官方且稳定的取口令通道（BrowserAuth
* 用它给浏览器下发登录链接），进程内恒定可用。
*/
function probeConnectionToken(ctx) {
	try {
		const url = ctx.connection?.authenticatedUrl?.("http://127.0.0.1");
		if (typeof url !== "string") return void 0;
		return new URL(url).searchParams.get("token") ?? void 0;
	} catch {
		return;
	}
}
/** Soft-probe the webServer service object for a token-shaped string field. */
function probeRuntimeToken(ctx) {
	try {
		const ws = ctx.webServer;
		for (const [key, value] of Object.entries(ws ?? {})) if (/token/i.test(key) && typeof value === "string" && value.length >= 16) return value;
	} catch {}
}
/** Scan the tail of the backend boot log (desktop deployment standard). */
async function scanTokenFromLog() {
	try {
		const handle = await open(path.join(homedir(), ".dsh", "desktop", "backend.log"), "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - 65536);
			const buf = Buffer.alloc(size - start);
			await handle.read(buf, 0, buf.length, start);
			return [...buf.toString("utf8").matchAll(TOKEN_RE)].at(-1)?.[1];
		} finally {
			await handle.close();
		}
	} catch {
		return;
	}
}
async function resolveToken(ctx, config) {
	if (config.token !== void 0 && config.token.length > 0) return config.token;
	const launch = probeConnectionToken(ctx);
	if (launch !== void 0) {
		ctx.logger.info("dsh-remote-x: token resolved from Connection launch token");
		return launch;
	}
	const probed = probeRuntimeToken(ctx);
	if (probed !== void 0) {
		ctx.logger.info("dsh-remote-x: token resolved from webServer runtime probe");
		return probed;
	}
	const scanned = await scanTokenFromLog();
	if (scanned !== void 0) {
		ctx.logger.info("dsh-remote-x: token resolved from boot log scan");
		return scanned;
	}
}
/**
* 惰性 token 解析（按进程缓存一次）。不能在 apply 时解析：
* 启动日志里的 `dsh web: ?token=` 行在 webserver 就绪后才打印，
* apply 早于它，且旧的 token 行会随重启滑出扫描窗口。
*/
let tokenCache = null;
let tokenWarned = false;
function resolveTokenLazy(ctx, config) {
	if (tokenCache !== null) return Promise.resolve(tokenCache);
	return resolveToken(ctx, config).then((token) => {
		if (token !== void 0) tokenCache = token;
		else if (!tokenWarned) {
			tokenWarned = true;
			ctx.logger.warn("dsh-remote-x: login token not detected — set config.token to enable the QR panel");
		}
		return token;
	});
}
function isTopLevel(header) {
	return header.origin !== "subagent" && (header.delegationDepth ?? 0) === 0;
}
/** 在线会话标题：走网页端同一个 sessionTitle 服务。 */
function liveTitle(ctx, session) {
	try {
		const title = ctx.get("sessionTitle")?.get?.(session)?.title;
		return typeof title === "string" && title.length > 0 ? title : void 0;
	} catch {
		return;
	}
}
/** 冷会话标题：批量折叠（readTitleSnapshots），失败逐条回退。 */
async function coldTitles(query, ids) {
	const out = /* @__PURE__ */ new Map();
	if (ids.length === 0) return out;
	try {
		const results = await query.readTitleSnapshots?.(ids) ?? [];
		for (const item of results) {
			if (item?.status !== "fulfilled") continue;
			const title = item.value?.title?.title;
			const id = String(item.sessionId ?? item.value?.session?.id ?? "");
			if (typeof title === "string" && title.length > 0 && id.length > 0) out.set(id, title);
		}
	} catch {
		for (const id of ids) try {
			const title = await query.readTitle?.(id)?.then?.((s) => s?.title);
			if (typeof title === "string" && title.length > 0) out.set(id, title);
		} catch {}
	}
	return out;
}
async function buildTaskList(ctx, debug = false) {
	const query = ctx.get("sessionQuery");
	if (debug) try {
		const live0 = ctx.sessions.list()[0];
		if (live0 !== void 0) ctx.logger.info(`remote-x-diag live header keys=${JSON.stringify(Object.keys(live0.header))} payload=${JSON.stringify(live0.header)}`);
		if (query !== void 0) {
			const recs = await query.listSessions();
			ctx.logger.info(`remote-x-diag listSessions count=${recs.length} firstKeys=${JSON.stringify(Object.keys(recs[0] ?? {}))} first=${JSON.stringify(recs[0]?.header ?? recs[0])}`);
		}
	} catch (error) {
		ctx.logger.info(`remote-x-diag failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sessions = /* @__PURE__ */ new Map();
	for (const session of ctx.sessions.list()) {
		if (!isTopLevel(session.header)) continue;
		sessions.set(session.id, {
			header: session.header,
			live: true,
			events: session.snapshotEvents()
		});
	}
	if (query !== void 0) try {
		for (const record of await query.listSessions()) {
			const header = record.header;
			if (!isTopLevel(header) || sessions.has(header.id)) continue;
			sessions.set(header.id, {
				header,
				live: record.live === true
			});
		}
	} catch {}
	const coldIds = [...sessions.entries()].filter(([, entry]) => !entry.live).sort((a, b) => b[1].header.createdAt - a[1].header.createdAt).slice(0, 50).map(([id]) => id);
	const folded = query === void 0 ? /* @__PURE__ */ new Map() : await coldTitles(query, coldIds);
	const tasks = [];
	for (const [id, entry] of sessions) {
		const running = ctx.agents.get(entry.header.id)?.status === "running";
		let title;
		if (entry.live) title = liveTitle(ctx, ctx.sessions.get(entry.header.id));
		if (title === void 0) title = folded.get(id);
		if (title === void 0) continue;
		const lastActivityAt = entry.events !== void 0 ? entry.events.at(-1)?.time ?? entry.header.createdAt : entry.header.createdAt;
		tasks.push({
			id,
			title,
			cwd: entry.header.cwd,
			updatedAt: lastActivityAt,
			running,
			live: entry.live
		});
	}
	tasks.sort((a, b) => b.updatedAt - a.updatedAt);
	const byCwd = /* @__PURE__ */ new Map();
	for (const task of tasks) {
		const key = task.cwd ?? "(default)";
		if (!byCwd.has(key)) byCwd.set(key, []);
		byCwd.get(key).push(task);
	}
	return {
		groups: [...byCwd.entries()].map(([cwd, list]) => ({
			cwd,
			label: cwd === "(default)" ? cwd : cwd.split("/").pop() || cwd,
			tasks: list
		})).sort((a, b) => {
			const maxA = Math.max(...a.tasks.map((t) => t.updatedAt));
			return Math.max(...b.tasks.map((t) => t.updatedAt)) - maxA;
		}),
		taskCount: tasks.length
	};
}
/**
* DSH 的认证墙保护 root/index 响应（未认证 401），但插件自定义 prefix 路由
* 不在墙内，且本机 loopback 请求一律免认证——直接开放 qr-info 会让局域网内
* 任何人经 proxy 免口令拿到登录口令。
*
* 防线：index HTML 只在通过认证后才渲染，因此随 HTML 注入一次性 nonce；
* qr-info 要求请求头携带有效（未过期）nonce。攻击者未通过认证就看不到
* nonce；已认证者本来就已持有口令，无增量泄露。
*/
const NONCE_TTL_MS = 10 * 6e4;
const nonces = /* @__PURE__ */ new Map();
function issueNonce() {
	const nonce = randomBytes(16).toString("hex");
	nonces.set(nonce, Date.now());
	for (const [key, issuedAt] of nonces) if (Date.now() - issuedAt > NONCE_TTL_MS) nonces.delete(key);
	return nonce;
}
function nonceValid(nonce) {
	if (typeof nonce !== "string" || nonce.length === 0) return false;
	const issuedAt = nonces.get(nonce);
	if (issuedAt === void 0) return false;
	if (Date.now() - issuedAt > NONCE_TTL_MS) {
		nonces.delete(nonce);
		return false;
	}
	nonces.set(nonce, Date.now());
	return true;
}
function sendJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}
function sendError(res, status, message) {
	sendJson(res, status, { error: message });
}
/** Non-internal IPv4 addresses, deduped. */
function lanAddresses() {
	const out = [];
	for (const list of Object.values(networkInterfaces())) for (const net of list ?? []) if ((net.family === "IPv4" || net.family === 4) && net.internal !== true) out.push(net.address);
	return [...new Set(out)];
}
/**
* 本机是否启用了可能拦截入站的防火墙。
*
* 局域网模式最典型的失败形态：代理明明在 0.0.0.0:3081 正常监听，本机 curl
* 也通（本机流量走 lo，不受 ufw 管），但手机一律连不上 —— 因为 ufw 默认拒绝
* 入站，而公网隧道连的是 127.0.0.1 所以毫发无伤。这种情况插件无法自行放行
* （改防火墙要 root），至少要在界面上说清楚，别让人去怀疑插件。
*/
/** 异步跑一个子进程，仅关心退出码是否为 0。 */
function execFileOk(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 5e3 }, (error) => resolve(error === null));
	});
}
function cacheFresh(cache, ttlMs) {
	return cache !== null && Date.now() - cache.at < ttlMs ? cache.value : null;
}
let cloudflaredCache = null;
/** cloudflared 是否可用（60s 缓存）。探测在宿主主进程上执行，绝不能同步 spawn。 */
async function cloudflaredAvailableCached() {
	const fresh = cacheFresh(cloudflaredCache, 6e4);
	if (fresh !== null) return fresh;
	const value = await execFileOk("cloudflared", ["--version"]);
	cloudflaredCache = {
		value,
		at: Date.now()
	};
	return value;
}
let firewallCache = null;
/** 防火墙探测（60s 缓存）。systemctl is-active 仅对 active 返回 0。 */
async function firewallBlockerCached() {
	const fresh = cacheFresh(firewallCache, 6e4);
	if (fresh !== null) return fresh;
	let value = null;
	for (const unit of ["ufw", "firewalld"]) if (await execFileOk("systemctl", ["is-active", unit])) {
		value = unit;
		break;
	}
	firewallCache = {
		value,
		at: Date.now()
	};
	return value;
}
/** 本机端口是否已有监听者（用于识别由本进程之外托管的代理实例）。 */
function portInUse(port) {
	if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		const socket = connect({
			host: "127.0.0.1",
			port
		});
		const done = (value) => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(500);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}
/** LRU cache for QR SVG rendering (max 64 entries). */
const qrCache = /* @__PURE__ */ new Map();
const QR_CACHE_MAX = 64;
/** Self-rendered QR SVG — uses the bundled zero-dependency encoder in lib/qr.mjs. */
async function renderQrSvg(text) {
	const cached = qrCache.get(text);
	if (cached !== void 0) return cached;
	const { encodeQr } = await import("./qr-CMiyW3mr.mjs");
	const qr = encodeQr(text);
	const size = qr.size;
	const data = qr.data;
	const quiet = 2;
	const total = size + quiet * 2;
	const parts = [];
	for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (data[row * size + col] === 1) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${parts.join("")}" fill="#000000"/></svg>`;
	if (qrCache.size >= QR_CACHE_MAX) {
		const firstKey = qrCache.keys().next().value;
		if (firstKey !== void 0) qrCache.delete(firstKey);
	}
	qrCache.set(text, svg);
	return svg;
}
let publicTunnel = null;
let lanProxy = null;
/** 代理由本进程之外的机制托管（如用户级 systemd 单元）：沿用而不接管。 */
let lanProxyExternal = false;
async function apply(ctx, config) {
	const breakpoint = typeof config?.breakpoint === "number" && config.breakpoint > 0 ? config.breakpoint : 768;
	const proxyPort = typeof config?.proxyPort === "number" ? config.proxyPort : 3081;
	const sectionTitle = config?.title ?? "远程控制";
	const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "inject", "mobile.css");
	let css = await readFile(cssPath, "utf8").catch(() => "");
	if (css.length > 0) {
		css = css.replace(/__BREAKPOINT__/g, String(breakpoint));
		const mobileJs = `(function(){
function setM(){var m=innerWidth<${breakpoint};if(m)document.body.classList.add('rm-x-mobile');else document.body.classList.remove('rm-x-mobile')}
setM();
var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(setM,100)});
/* 兜底：客户端模块加载失败时恢复桌面布局。
 * rm-x-ready 由客户端模块建好仪表盘后打上——隧道/弱网下加载超过 5s 是常态，
 * 不能只看时间；ready 已打（或 dashboard 已存在）就绝不能回退，否则手机上
 * 没有 resize 事件，坏了只能刷新。 */
setTimeout(function(){if(document.body.classList.contains('rm-x-mobile')&&!document.body.classList.contains('rm-x-ready')&&!document.getElementById('rm-x-dashboard'))document.body.classList.remove('rm-x-mobile')},5000);
})();`;
		ctx.on("webserver/index-inject", ((table) => {
			let fresh = css;
			try {
				fresh = readFileSync(cssPath, "utf8").replace(/__BREAKPOINT__/g, String(breakpoint));
			} catch {}
			table.push({
				kind: "style",
				text: fresh
			});
			table.push({
				kind: "script",
				placement: "body",
				text: mobileJs
			});
			table.push({
				kind: "global",
				name: "__REMOTE_X_NONCE__",
				value: issueNonce()
			});
		}));
		ctx.logger.info(`dsh-remote-x: mobile layer injected (breakpoint ${breakpoint}px)`);
	} else ctx.logger.warn("dsh-remote-x: inject/mobile.css missing — mobile layer disabled");
	const base = path.dirname(fileURLToPath(import.meta.url));
	/** 版本号单一来源：读 package.json，避免响应里硬编码字符串随版本漂移。 */
	function readPluginVersion() {
		try {
			const pkg = JSON.parse(readFileSync(path.join(base, "..", "package.json"), "utf8"));
			return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
		} catch {
			return "unknown";
		}
	}
	const pluginVersion = readPluginVersion();
	sweepOrphanTunnel(proxyPort).then((swept) => {
		if (swept) ctx.logger.warn("dsh-remote-x: swept orphan cloudflared left by a previous process");
	}).catch(() => {});
	/**
	* 启动局域网反代。
	*
	* 原先一律 `systemctl --user start dsh-remote-proxy.service` —— 但插件从未
	* 随包提供该单元，也没有安装步骤创建它，于是「开启」永远卡在
	* "Unit dsh-remote-proxy.service not found"，局域网与公网两个开关一起失效。
	* 改为在宿主进程内直接托管 lib/proxy.mjs 的反代，任何部署形态都可用。
	*/
	async function startLanProxy() {
		if (lanProxy !== null) return;
		if (await portInUse(proxyPort)) {
			lanProxyExternal = true;
			return;
		}
		const { startRemoteProxy } = await import("./proxy-BsguNCOg.mjs");
		const upstreamPort = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 3080;
		const server = await startRemoteProxy({
			port: proxyPort,
			upstream: {
				host: "127.0.0.1",
				port: upstreamPort
			},
			accessKey: config?.accessKey,
			token: await resolveTokenLazy(ctx, config),
			onError: ({ kind, error }) => {
				ctx.logger.warn(`dsh-remote-x: proxy ${kind} error: ${error.message}`);
			}
		});
		lanProxy = {
			server,
			port: proxyPort
		};
		lanProxyExternal = false;
		const bound = server.address();
		const shown = bound !== null && typeof bound === "object" ? `${bound.address}:${bound.port}` : String(bound);
		ctx.logger.info(`dsh-remote-x: LAN proxy ${shown} → 127.0.0.1:${upstreamPort}`);
	}
	async function stopLanProxy() {
		if (lanProxy !== null) {
			const { server } = lanProxy;
			lanProxy = null;
			server.close();
			const closer = server;
			closer.closeIdleConnections?.();
			setTimeout(() => closer.closeAllConnections?.(), 3e3).unref?.();
			return;
		}
		if (lanProxyExternal) {
			try {
				execFileSync("systemctl", [
					"--user",
					"stop",
					"dsh-remote-proxy.service"
				], { stdio: "ignore" });
			} catch {}
			lanProxyExternal = false;
		}
	}
	const route = {
		kind: "prefix",
		path: "/dsh-remote-x/api",
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const sub = url.pathname.replace(/\/+$/, "").slice(17);
			if (sub === "/qr-info" && req.method === "GET") {
				if (!nonceValid(req.headers["x-remote-nonce"])) {
					sendError(res, 401, "missing or invalid nonce");
					return;
				}
				const ips = lanAddresses();
				const token = await resolveTokenLazy(ctx, config);
				const host = ips[0];
				const accessKey = config?.accessKey;
				const entry = host !== void 0 && proxyPort > 0 ? accessKey ? `http://${host}:${proxyPort}/k/${encodeURIComponent(accessKey)}/` : token !== void 0 ? `http://${host}:${proxyPort}/t/${encodeURIComponent(token)}/` : null : null;
				sendJson(res, 200, {
					title: sectionTitle,
					lanIps: ips,
					proxyPort,
					tokenDetected: token !== void 0,
					accessKeySet: accessKey !== void 0,
					entry,
					lanEnabled: lanProxy !== null || lanProxyExternal || await portInUse(proxyPort),
					publicEnabled: publicTunnel !== null,
					publicUrl: publicTunnel?.url ?? null,
					tunnelRegion: publicTunnel?.runtime?.region ?? null,
					tunnelProtocol: publicTunnel?.runtime?.protocol ?? null,
					tunnelReconnectCount: publicTunnel?.runtime?.reconnectCount ?? 0,
					tunnelLatencyMs: typeof publicTunnel?.runtime?.latencyMs === "function" ? publicTunnel.runtime.latencyMs() ?? null : null,
					tunnelStatus: publicTunnel?.runtime?.status ?? "disabled",
					cloudflaredAvailable: await cloudflaredAvailableCached(),
					firewall: await firewallBlockerCached(),
					version: pluginVersion
				});
				return;
			}
			if (sub === "/tasks" && req.method === "GET") {
				if (!nonceValid(req.headers["x-remote-nonce"])) {
					sendError(res, 401, "missing or invalid nonce");
					return;
				}
				try {
					sendJson(res, 200, await buildTaskList(ctx, config?.debug === true));
				} catch (error) {
					sendError(res, 500, error instanceof Error ? error.message : String(error));
				}
				return;
			}
			if (sub === "/qrcode" && req.method === "GET") {
				const text = url.searchParams.get("text") ?? "";
				if (text.length === 0 || text.length > 512) {
					sendError(res, 400, "text 长度需在 1..512 之间");
					return;
				}
				if (!/^https?:\/\//i.test(text)) {
					sendError(res, 400, "text 必须是 http(s) 链接");
					return;
				}
				try {
					const svg = await renderQrSvg(text);
					res.writeHead(200, {
						"content-type": "image/svg+xml; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(svg);
				} catch (error) {
					sendError(res, 500, error instanceof Error ? error.message : String(error));
				}
				return;
			}
			if (sub === "/lan-toggle" && req.method === "POST") {
				if (!nonceValid(req.headers["x-remote-nonce"])) {
					sendError(res, 401, "missing or invalid nonce");
					return;
				}
				let raw = "";
				try {
					for await (const ch of req) raw += ch;
				} catch {}
				let body = {};
				try {
					body = JSON.parse(raw);
				} catch {}
				const enabled = body.enabled === true;
				try {
					if (enabled) await startLanProxy();
					else await stopLanProxy();
					sendJson(res, 200, {
						ok: true,
						enabled
					});
				} catch (err) {
					sendError(res, 500, err instanceof Error ? err.message : String(err));
				}
				return;
			}
			if (sub === "/public-toggle" && req.method === "POST") {
				if (!nonceValid(req.headers["x-remote-nonce"])) {
					sendError(res, 401, "missing or invalid nonce");
					return;
				}
				let raw = "";
				try {
					for await (const ch of req) raw += ch;
				} catch {}
				let body = {};
				try {
					body = JSON.parse(raw);
				} catch {}
				const enabled = body.enabled === true;
				try {
					if (enabled) {
						if (!publicTunnel) {
							await startLanProxy();
							const accessKey = config?.accessKey;
							const token = await resolveTokenLazy(ctx, config);
							const t = await startTunnel(proxyPort, {
								token: config?.cloudflareToken,
								domain: config?.publicDomain,
								region: config?.tunnelRegion,
								protocol: config?.tunnelProtocol,
								metricsPort: config?.tunnelMetricsPort,
								reconnect: config?.tunnelReconnect,
								healthCheckMs: config?.tunnelHealthCheckMs,
								maxReconnect: config?.tunnelMaxReconnect
							});
							const suffix = accessKey ? `/k/${encodeURIComponent(accessKey)}/` : token !== void 0 ? `/t/${encodeURIComponent(token)}/` : "/";
							publicTunnel = {
								url: t.url + suffix,
								stop: t.stop,
								runtime: t.runtime
							};
						}
						sendJson(res, 200, {
							ok: true,
							enabled: true,
							url: publicTunnel.url
						});
					} else {
						publicTunnel?.stop?.();
						publicTunnel = null;
						sendJson(res, 200, {
							ok: true,
							enabled: false
						});
					}
				} catch (err) {
					sendError(res, 500, err instanceof Error ? err.message : String(err));
				}
				return;
			}
			sendError(res, 404, `no handler for ${req.method} ${url.pathname}`);
		}
	};
	ctx.effect(() => {
		const dispose = ctx.webServer.register(route);
		return () => {
			try {
				publicTunnel?.stop?.();
			} catch {}
			publicTunnel = null;
			stopLanProxy().catch(() => {});
			dispose();
		};
	}, "dsh-remote-x: api route");
	ctx.logger.info("dsh-remote-x: QR panel API mounted at /dsh-remote-x/api (token resolved lazily per request)");
}
//#endregion
export { Config, apply, inject, name };
