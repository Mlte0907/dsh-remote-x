import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/index.ts
/**
* dsh-remote-x — DSH 风格的移动端 / 平板远程控制插件。
*
* 在 Harness 自带的 Web 服务器（ctx.webServer）上挂载一个手机优先的远程控制
* 页面，复刻 dsh 远程控制端 的交互：工作区 / 任务仪表盘、任务会话
* 时间线（思考、工具调用、流式回复）、排队 / 打断发送、停止生成、模型选择、
* 明暗主题与命令面板。
*
* 数据全部来自本进程的会话运行时（ctx.sessions / ctx.agents / ctx.llm /
* ctx.sessionQuery），前端通过 SSE 订阅 `session/event` 事件流实时渲染。
* 页面本身不引入任何构建步骤：client/ 目录是纯静态资源，由本插件直接伺服。
*/
/** Stable Cordis plugin name. */
const name = "dsh-remote-x";
/** Services required before apply runs. */
const inject = [
	"webServer",
	"agents",
	"llm",
	"sessions"
];
const Config = z.object({
	route: z.string().pattern(/^\//).default("/remote"),
	title: z.string().default("DeepSeek 远程控制"),
	token: z.string()
});
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
function sendError(res, status, message) {
	sendJson(res, status, { error: message });
}
async function readJson(req, maxBytes = 4e6) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (raw.length === 0) return {};
	return JSON.parse(raw);
}
/** Constant-time token check; `undefined` expected on both sides disables auth. */
function tokenOk(expected, provided) {
	if (expected === void 0) return true;
	if (provided === void 0) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(provided);
	return a.length === b.length && timingSafeEqual(a, b);
}
function textOf(blocks) {
	if (!Array.isArray(blocks)) return "";
	return blocks.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
}
function reasoningOf(blocks) {
	if (!Array.isArray(blocks)) return "";
	return blocks.filter((block) => block?.type === "reasoning").map((block) => block.text ?? "").join("");
}
function projectEvents(events) {
	const records = [];
	const tools = /* @__PURE__ */ new Map();
	let lastSeq = -1;
	for (const event of events) {
		lastSeq = Math.max(lastSeq, event.seq);
		const data = event.data ?? {};
		switch (event.type) {
			case "user/message": {
				const text = textOf(data.content);
				if (data.source?.kind === "user" && text.length > 0) records.push({
					kind: "user",
					time: event.time,
					text
				});
				break;
			}
			case "assistant/message": {
				const text = textOf(data.message?.content);
				const reasoning = reasoningOf(data.message?.content);
				records.push({
					kind: "assistant",
					time: event.time,
					text,
					reasoning
				});
				break;
			}
			case "tool/call": {
				const record = {
					kind: "tool",
					callId: String(data.callId),
					name: String(data.name),
					argsText: typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {}),
					time: event.time,
					state: "running"
				};
				tools.set(record.callId, record);
				records.push(record);
				break;
			}
			case "tool/result": {
				const record = tools.get(String(data.message?.toolCallId ?? data.callId));
				if (record !== void 0) {
					record.state = data.error ? "error" : "done";
					record.resultText = textOf(data.message?.content);
				}
				break;
			}
			case "approval/asked":
				records.push({
					kind: "user",
					time: event.time,
					text: `需要审批：${summary(data)}（请在桌面端 Harness 界面处理）`
				});
				break;
			default: break;
		}
	}
	return {
		records,
		lastSeq
	};
}
function summary(value) {
	try {
		const text = JSON.stringify(value);
		return text.length > 160 ? `${text.slice(0, 159)}…` : text;
	} catch {
		return String(value);
	}
}
async function apply(ctx, config) {
	const cfg = {
		route: (config?.route ?? "/remote").replace(/\/+$/, "") || "/remote",
		title: config?.title ?? "DeepSeek 远程控制",
		token: config?.token
	};
	if (!cfg.route.startsWith("/")) throw new Error("dsh-remote-x: route 必须以 / 开头");
	const base = cfg.route;
	const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
	/** In-memory metadata for sessions this plugin created (and live updates). */
	const taskMeta = /* @__PURE__ */ new Map();
	const connections = /* @__PURE__ */ new Set();
	/** Latest activity time per session id, kept fresh by the event firehose. */
	ctx.on("session/event", (session, event) => {
		const meta = taskMeta.get(session.id);
		if (meta !== void 0) meta.lastActivityAt = event.time;
	});
	const staticFiles = {
		"/app.js": {
			file: "app.js",
			type: "text/javascript; charset=utf-8"
		},
		"/styles.css": {
			file: "styles.css",
			type: "text/css; charset=utf-8"
		},
		"/favicon.svg": {
			file: "favicon.svg",
			type: "image/svg+xml"
		}
	};
	async function serveStatic(res, entry) {
		try {
			const body = await readFile(path.join(clientDir, entry.file));
			res.writeHead(200, {
				"content-type": entry.type,
				"cache-control": "no-cache"
			});
			res.end(body);
		} catch {
			sendError(res, 404, "static asset missing");
		}
	}
	function authorize(req, url) {
		const provided = url.searchParams.get("token") ?? req.headers["x-remote-token"] ?? cookieToken(req);
		return tokenOk(cfg.token, provided);
	}
	function cookieToken(req) {
		const header = req.headers.cookie;
		if (header === void 0) return void 0;
		const match = /(?:^|;\s*)dsh-remote-token=([^;]*)/.exec(header);
		return match?.[1] !== void 0 ? decodeURIComponent(match[1]) : void 0;
	}
	async function modelCatalog() {
		const providers = [];
		let defaultSelection;
		let defaults;
		try {
			defaults = ctx.get("agentDefaultModel");
		} catch {
			defaults = void 0;
		}
		if (defaults?.currentSelection !== void 0) try {
			const current = defaults.currentSelection();
			if (current?.provider !== void 0 && current?.model !== void 0) defaultSelection = {
				provider: current.provider,
				model: current.model
			};
		} catch {}
		for (const provider of ctx.llm.listProviders()) {
			let models = [];
			try {
				models = (await ctx.llm.listModels(provider.id)).map((model) => ({
					id: model.id,
					name: model.name
				}));
			} catch {
				models = [];
			}
			providers.push({
				id: provider.id,
				name: provider.name,
				models
			});
		}
		if (defaultSelection === void 0) {
			const first = providers[0];
			const firstModel = first?.models[0];
			if (first !== void 0 && firstModel !== void 0) defaultSelection = {
				provider: first.id,
				model: firstModel.id
			};
		}
		return {
			providers,
			defaultSelection
		};
	}
	function firstUserText(events) {
		for (const event of events) {
			if (event.type !== "user/message") continue;
			const data = event.data ?? {};
			if (data.source?.kind !== "user") continue;
			const text = textOf(data.content).trim();
			if (text.length > 0) return text.length > 40 ? `${text.slice(0, 39)}…` : text;
		}
	}
	function isTopLevel(header) {
		return header.origin !== "subagent" && (header.delegationDepth ?? 0) === 0;
	}
	async function coldTitle(query, sessionId) {
		try {
			const observation = await query.readTitleSnapshot?.(sessionId);
			const title = observation?.title ?? observation?.snapshot?.title;
			return typeof title === "string" && title.length > 0 ? title : void 0;
		} catch {
			return;
		}
	}
	/** 冷会话标题缓存：readTitleSnapshot 需要读完整日志，逐会话缓存避免每次刷新重算 */
	const titleCache = /* @__PURE__ */ new Map();
	async function buildTaskList() {
		const query = ctx.get("sessionQuery");
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
		const coldIds = [...sessions.entries()].filter(([, entry]) => !entry.live).sort((a, b) => b[1].header.createdAt - a[1].header.createdAt).slice(0, 20).map(([id]) => id);
		const tasks = [];
		for (const [id, entry] of sessions) {
			const running = ctx.agents.get(entry.header.id)?.status === "running";
			let title = entry.live && entry.events !== void 0 ? firstUserText(entry.events) : void 0;
			if (title === void 0 && query !== void 0 && !entry.live) {
				title = titleCache.get(id);
				if (title === void 0 && coldIds.includes(id)) {
					title = await coldTitle(query, id);
					if (title !== void 0) titleCache.set(id, title);
				}
			}
			const meta = taskMeta.get(id);
			const display = meta?.renamed === true && meta.title ? meta.title : title ?? meta?.title ?? "新任务";
			const lastActivityAt = meta?.lastActivityAt ?? (entry.events !== void 0 ? entry.events.at(-1)?.time ?? entry.header.createdAt : entry.header.createdAt);
			let model;
			if (entry.events !== void 0) for (let index = entry.events.length - 1; index >= 0; index -= 1) {
				const event = entry.events[index];
				if (event.type === "request/header") {
					const headerConfig = event.data?.header?.config;
					if (headerConfig?.provider !== void 0 && headerConfig?.model !== void 0) model = {
						provider: headerConfig.provider,
						model: headerConfig.model
					};
					break;
				}
			}
			tasks.push({
				id,
				title: display,
				cwd: entry.header.cwd,
				createdAt: entry.header.createdAt,
				updatedAt: lastActivityAt,
				running,
				live: entry.live,
				model
			});
		}
		tasks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		const workspaces = new Set(tasks.map((task) => task.cwd ?? "(default)"));
		return {
			tasks,
			workspaceCount: Math.max(workspaces.size, 1)
		};
	}
	async function createTask(body) {
		const sessionId = brandString(`session-${randomUUID()}`);
		const cwd = typeof body?.cwd === "string" && body.cwd.length > 0 ? body.cwd : process.cwd();
		const agentOptions = {};
		if (typeof body?.provider === "string" && typeof body?.model === "string") {
			agentOptions.provider = body.provider;
			agentOptions.model = body.model;
		}
		if (typeof body?.reasoningEffort === "string" && body.reasoningEffort.length > 0) agentOptions.reasoningEffort = body.reasoningEffort;
		await ctx.agents.create({
			sessionId,
			meta: { cwd },
			...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
		});
		taskMeta.set(sessionId, {
			title: "新任务",
			lastActivityAt: Date.now()
		});
		return { sessionId };
	}
	async function sendPrompt(sessionId, body) {
		const agent = ctx.agents.get(brandString(sessionId));
		if (agent === void 0) throw new Error("任务未在运行中（会话未附加），无法发送消息");
		const text = typeof body?.content === "string" ? body.content : "";
		if (text.trim().length === 0) throw new Error("消息内容不能为空");
		const source = {
			kind: "user",
			rpcId: `remote-${randomUUID()}`
		};
		if (typeof body?.clientTimeZone === "string" && body.clientTimeZone.length > 0) source.clientTimeZone = body.clientTimeZone;
		const message = createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source
		});
		const meta = taskMeta.get(sessionId);
		if (meta !== void 0 && meta.renamed !== true && (meta.title === void 0 || meta.title === "新任务")) meta.title = text.trim().length > 40 ? `${text.trim().slice(0, 39)}…` : text.trim();
		if (body?.mode === "steer") agent.steer(message);
		else agent.followup(message);
	}
	function cancelTask(sessionId) {
		const agent = ctx.agents.get(brandString(sessionId));
		if (agent === void 0) throw new Error("任务未在运行中（会话未附加）");
		agent.cancel({ kind: "user" }, { keepInbox: true });
	}
	/**
	* Rename one task. Prefers the Harness session-title service (durable);
	* without it the rename stays local to this plugin's metadata.
	*/
	async function renameTask(sessionId, title) {
		const trimmed = title.trim();
		if (trimmed.length === 0) throw new Error("标题不能为空");
		const agent = ctx.agents.get(brandString(sessionId));
		const titles = ctx.get("sessionTitle");
		let accepted = trimmed;
		if (agent !== void 0 && titles !== void 0) try {
			accepted = titles.rename(agent.session, trimmed).title;
		} catch (error) {
			throw new Error(`重命名失败：${error instanceof Error ? error.message : String(error)}`);
		}
		const meta = taskMeta.get(sessionId) ?? { lastActivityAt: Date.now() };
		meta.title = accepted;
		meta.renamed = true;
		taskMeta.set(sessionId, meta);
		return { title: accepted };
	}
	async function taskDetail(sessionId) {
		const meta = taskMeta.get(sessionId);
		const live = ctx.sessions.get(brandString(sessionId));
		if (live !== void 0) {
			const projected = projectEvents(live.snapshotEvents());
			const agent = ctx.agents.get(live.id);
			const derived = firstUserText(live.snapshotEvents());
			return {
				id: live.id,
				title: meta?.renamed === true && meta.title ? meta.title : derived ?? meta?.title ?? "新任务",
				cwd: live.header.cwd,
				createdAt: live.header.createdAt,
				running: agent?.status === "running",
				records: projected.records,
				lastSeq: projected.lastSeq
			};
		}
		const query = ctx.get("sessionQuery");
		if (query !== void 0) {
			const snapshot = await query.readSession(brandString(sessionId));
			const header = snapshot.session;
			const projected = projectEvents(snapshot.events);
			const derived = firstUserText(snapshot.events);
			return {
				id: header.id,
				title: meta?.renamed === true && meta.title ? meta.title : await coldTitle(query, sessionId) ?? derived ?? "历史任务",
				cwd: header.cwd,
				createdAt: header.createdAt,
				running: false,
				records: projected.records,
				lastSeq: projected.lastSeq
			};
		}
		throw new Error("任务不存在或已卸载");
	}
	function openEventStream(res, sessionId) {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		res.write(": connected\n\n");
		let disposeListener;
		const heartbeat = setInterval(() => {
			res.write(": ping\n\n");
		}, 15e3);
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			disposeListener?.();
			connections.delete(connection);
		};
		const connection = {
			write(event, payload) {
				if (closed) return;
				res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
			},
			dispose: close
		};
		if (sessionId !== void 0) {
			const branded = brandString(sessionId);
			const live = ctx.sessions.get(branded);
			if (live !== void 0) {
				const projected = projectEvents(live.snapshotEvents());
				const agent = ctx.agents.get(live.id);
				connection.write("snapshot", {
					sessionId: live.id,
					running: agent?.status === "running",
					records: projected.records,
					lastSeq: projected.lastSeq
				});
			} else connection.write("snapshot", {
				sessionId,
				running: false,
				records: [],
				lastSeq: -1
			});
			disposeListener = ctx.on("session/event", (session, event) => {
				if (session.id !== branded) return;
				const meta = taskMeta.get(session.id);
				if (meta !== void 0) meta.lastActivityAt = event.time;
				connection.write("session-event", {
					type: event.type,
					seq: event.seq,
					time: event.time,
					data: event.data
				});
			});
		} else connection.write("snapshot", {
			sessionId: void 0,
			running: false,
			records: [],
			lastSeq: -1
		});
		connections.add(connection);
		res.on("close", close);
	}
	const route = {
		kind: "prefix",
		path: base,
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const asset0 = staticFiles[url.pathname === base ? "/" : url.pathname.slice(base.length)];
			if (asset0 !== void 0 && req.method === "GET") {
				await serveStatic(res, asset0);
				return;
			}
			if (!authorize(req, url)) {
				sendError(res, 401, "missing or invalid token");
				return;
			}
			if (url.pathname === base) {
				res.writeHead(301, { location: `${base}/` });
				res.end();
				return;
			}
			const sub = url.pathname.slice(base.length);
			if (sub === "/" || sub === "/index.html") {
				if (cfg.token) res.setHeader("set-cookie", `dsh-remote-token=${encodeURIComponent(cfg.token)}; Path=/; HttpOnly; SameSite=Strict`);
				await serveStatic(res, {
					file: "index.html",
					type: "text/html; charset=utf-8"
				});
				return;
			}
			try {
				if (sub === "/api/bootstrap" && req.method === "GET") {
					const catalog = await modelCatalog();
					sendJson(res, 200, {
						title: cfg.title,
						route: base,
						cwd: process.cwd(),
						providers: catalog.providers,
						defaultSelection: catalog.defaultSelection
					});
					return;
				}
				if (sub === "/api/tasks" && req.method === "GET") {
					sendJson(res, 200, await buildTaskList());
					return;
				}
				if (sub === "/api/tasks" && req.method === "POST") {
					sendJson(res, 200, await createTask(await readJson(req)));
					return;
				}
				const detailMatch = /^\/api\/tasks\/([^/]+)$/.exec(sub);
				if (detailMatch !== null && req.method === "GET") {
					sendJson(res, 200, await taskDetail(decodeURIComponent(detailMatch[1])));
					return;
				}
				const promptMatch = /^\/api\/tasks\/([^/]+)\/messages$/.exec(sub);
				if (promptMatch !== null && req.method === "POST") {
					await sendPrompt(decodeURIComponent(promptMatch[1]), await readJson(req));
					sendJson(res, 200, { accepted: true });
					return;
				}
				const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(sub);
				if (cancelMatch !== null && req.method === "POST") {
					cancelTask(decodeURIComponent(cancelMatch[1]));
					sendJson(res, 200, { accepted: true });
					return;
				}
				const renameMatch = /^\/api\/tasks\/([^/]+)\/rename$/.exec(sub);
				if (renameMatch !== null && req.method === "POST") {
					const body = await readJson(req);
					sendJson(res, 200, await renameTask(decodeURIComponent(renameMatch[1]), typeof body?.title === "string" ? body.title : ""));
					return;
				}
				if (sub === "/api/events" && req.method === "GET") {
					try {
						openEventStream(res, url.searchParams.get("sessionId") ?? void 0);
					} catch (error) {
						ctx.logger.error("dsh-remote-x: SSE open failed:", error);
						throw error;
					}
					return;
				}
				sendError(res, 404, `no handler for ${req.method} ${url.pathname}`);
			} catch (error) {
				sendError(res, 400, error instanceof Error ? error.message : String(error));
			}
		}
	};
	ctx.effect(() => ctx.webServer.register(route), "dsh-remote-x: page route");
	ctx.logger.info(`dsh-remote-x: remote control page mounted at ${base} (open http://127.0.0.1:${ctx.webServer.port}${base})`);
}
//#endregion
export { Config, apply, inject, name };
