// src/index.ts
import { open, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir as homedir2, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import path2 from "node:path";
import { execFileSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";

// lib/tunnel.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
var TMP_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
var TIMEOUT_MS = 3e4;
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
function startTunnel(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (opts.token && opts.domain) {
      args.push("tunnel", "--token", opts.token);
    } else {
      args.push("tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate");
    }
    const child = spawn(resolveBinary(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const scan = (text) => {
      if (opts.token && opts.domain) {
        finish(resolve, {
          url: `https://${opts.domain}`,
          child,
          stop: () => {
            try {
              child.kill("SIGTERM");
            } catch {
            }
          }
        });
        return;
      }
      const match = TMP_RE.exec(text);
      if (match) {
        finish(resolve, {
          url: match[0],
          child,
          stop: () => {
            try {
              child.kill("SIGTERM");
            } catch {
            }
          }
        });
      }
    };
    child.stdout.on("data", (data) => scan(String(data)));
    child.stderr.on("data", (data) => scan(String(data)));
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        finish(reject, new Error("\u672A\u627E\u5230 cloudflared\uFF08\u516C\u7F51\u6A21\u5F0F\u9700\u8981\u5B83\uFF09\uFF1AmacOS \u7528 `brew install cloudflared`\uFF0C\u5176\u5B83\u5E73\u53F0\u89C1 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"));
      } else {
        finish(reject, new Error(`cloudflared \u542F\u52A8\u5931\u8D25\uFF1A${err.message}`));
      }
    });
    setTimeout(() => {
      finish(reject, new Error("cloudflared \u542F\u52A8\u8D85\u65F6\uFF0830s \u5185\u672A\u62FF\u5230\u96A7\u9053\u5730\u5740\uFF09"));
    }, TIMEOUT_MS);
  });
}

// src/index.ts
var name = "dsh-remote-x";
var inject = ["webServer", "sessions", "agents"];
var Config = z.object({
  breakpoint: z.number().default(768),
  proxyPort: z.number().default(3081),
  title: z.string().default("\u8FDC\u7A0B\u63A7\u5236"),
  token: z.string(),
  accessKey: z.string(),
  cloudflareToken: z.string(),
  publicDomain: z.string()
});
var TOKEN_RE = /token=([A-Za-z0-9_-]+)/g;
function probeRuntimeToken(ctx) {
  try {
    const ws = ctx.webServer;
    for (const [key, value] of Object.entries(ws ?? {})) {
      if (/token/i.test(key) && typeof value === "string" && value.length >= 16) return value;
    }
  } catch {
  }
  return void 0;
}
async function scanTokenFromLog() {
  try {
    const logPath = path2.join(homedir2(), ".dsh", "desktop", "backend.log");
    const handle = await open(logPath, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - 65536);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      const matches = [...buf.toString("utf8").matchAll(TOKEN_RE)];
      return matches.at(-1)?.[1];
    } finally {
      await handle.close();
    }
  } catch {
    return void 0;
  }
}
async function resolveToken(ctx, config) {
  if (config.token !== void 0 && config.token.length > 0) return config.token;
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
  ctx.logger.warn("dsh-remote-x: login token not detected \u2014 set config.token to enable the QR panel");
  return void 0;
}
var tokenCache = null;
function resolveTokenLazy(ctx, config) {
  if (tokenCache !== null) return Promise.resolve(tokenCache);
  return resolveToken(ctx, config).then((token) => {
    tokenCache = token;
    return token;
  });
}
function isTopLevel(header) {
  return header.origin !== "subagent" && (header.delegationDepth ?? 0) === 0;
}
function liveTitle(ctx, session) {
  try {
    const titles = ctx.get("sessionTitle");
    const title = titles?.get?.(session)?.title;
    return typeof title === "string" && title.length > 0 ? title : void 0;
  } catch {
    return void 0;
  }
}
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
    for (const id of ids) {
      try {
        const title = await query.readTitle?.(id)?.then?.((s) => s?.title);
        if (typeof title === "string" && title.length > 0) out.set(id, title);
      } catch {
      }
    }
  }
  return out;
}
async function buildTaskList(ctx) {
  const query = ctx.get("sessionQuery");
  try {
    const live0 = ctx.sessions.list()[0];
    if (live0 !== void 0) {
      ctx.logger.info(`remote-x-diag live header keys=${JSON.stringify(Object.keys(live0.header))} payload=${JSON.stringify(live0.header)}`);
    }
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
    sessions.set(session.id, { header: session.header, live: true, events: session.snapshotEvents() });
  }
  if (query !== void 0) {
    try {
      for (const record of await query.listSessions()) {
        const header = record.header;
        if (!isTopLevel(header) || sessions.has(header.id)) continue;
        sessions.set(header.id, { header, live: record.live === true });
      }
    } catch {
    }
  }
  const coldIds = [...sessions.entries()].filter(([, entry]) => !entry.live).sort((a, b) => b[1].header.createdAt - a[1].header.createdAt).slice(0, 50).map(([id]) => id);
  const folded = query === void 0 ? /* @__PURE__ */ new Map() : await coldTitles(query, coldIds);
  const tasks = [];
  for (const [id, entry] of sessions) {
    const agent = ctx.agents.get(entry.header.id);
    const running = agent?.status === "running";
    let title;
    if (entry.live) title = liveTitle(ctx, ctx.sessions.get(entry.header.id));
    if (title === void 0) title = folded.get(id);
    if (title === void 0) continue;
    const lastActivityAt = entry.events !== void 0 ? entry.events.at(-1)?.time ?? entry.header.createdAt : entry.header.createdAt;
    tasks.push({ id, title, cwd: entry.header.cwd, updatedAt: lastActivityAt, running, live: entry.live });
  }
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  const byCwd = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    const key = task.cwd ?? "(default)";
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(task);
  }
  const groups = [...byCwd.entries()].map(([cwd, list]) => ({
    cwd,
    label: cwd === "(default)" ? cwd : cwd.split("/").pop() || cwd,
    tasks: list
  })).sort((a, b) => {
    const maxA = Math.max(...a.tasks.map((t) => t.updatedAt));
    const maxB = Math.max(...b.tasks.map((t) => t.updatedAt));
    return maxB - maxA;
  });
  return { groups, taskCount: tasks.length };
}
var NONCE_TTL_MS = 10 * 6e4;
var nonces = /* @__PURE__ */ new Map();
function issueNonce() {
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, Date.now());
  for (const [key, issuedAt] of nonces) {
    if (Date.now() - issuedAt > NONCE_TTL_MS) nonces.delete(key);
  }
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
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if ((net.family === "IPv4" || net.family === 4) && net.internal !== true) out.push(net.address);
    }
  }
  return [...new Set(out)];
}
async function renderQrSvg(text) {
  const core = await import("qrcode/lib/core/qrcode.js");
  const create = core?.create ?? core?.default?.create;
  const qr = create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const quiet = 2;
  const total = size + quiet * 2;
  const parts = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (data[row * size + col] === 1) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${parts.join("")}" fill="#000000"/></svg>`;
}
var publicTunnel = null;
async function apply(ctx, config) {
  const breakpoint = typeof config?.breakpoint === "number" && config.breakpoint > 0 ? config.breakpoint : 768;
  const proxyPort = typeof config?.proxyPort === "number" ? config.proxyPort : 3081;
  const sectionTitle = config?.title ?? "\u8FDC\u7A0B\u63A7\u5236";
  const cssPath = path2.join(path2.dirname(fileURLToPath(import.meta.url)), "..", "inject", "mobile.css");
  let css = await readFile(cssPath, "utf8").catch(() => "");
  if (css.length > 0) {
    css = css.replace(/__BREAKPOINT__/g, String(breakpoint));
    const mobileJs = `(function(){
function isMobile(){return innerWidth<${breakpoint}}
function applyMobile(){
  var f=document.querySelector('[class*="_frame"]');
  if(!f)return;
  if(isMobile()){
    f.style.cssText="grid-template-columns:1fr!important;display:flex!important;flex-direction:column!important;height:100dvh!important;overflow:hidden!important;box-sizing:border-box!important;padding-top:42px!important";
    f.setAttribute('data-rm-x-mobile','1');
    var s=f.querySelector('[class*="_sidebarCol"]'),d=f.querySelector('[class*="_detailsCol"]');
    if(s)s.style.cssText="display:none!important";
    if(d)d.style.cssText="display:none!important";
    var c=f.querySelector('[class*="_centerCol"]');
    if(c)c.style.cssText="flex:1!important;min-width:0!important;overflow:hidden!important";
  }else if(f.getAttribute('data-rm-x-mobile')){
    f.style.cssText="";f.removeAttribute('data-rm-x-mobile');
    f.querySelectorAll('[class*="_sidebarCol"],[class*="_detailsCol"],[class*="_centerCol"]').forEach(function(e){e.style.cssText=""});
  }
}
applyMobile();
var t;addEventListener("resize",function(){clearTimeout(t);t=setTimeout(applyMobile,100)});
new MutationObserver(applyMobile).observe(document.body,{childList:true,subtree:true});

/* ---- \u4EFB\u52A1\u4F1A\u8BDD\u62BD\u5C49 + \u9876\u90E8\u8FD4\u56DE\u6761\uFF08v0.2.2\uFF09---- */
var drawer=null,listLoaded=false;
function ensureDrawer(){
  if(drawer)return drawer;
  drawer=document.createElement('div');
  drawer.className='rmx-drawer';
  drawer.innerHTML='<div class="rmx-drawer-head"><span class="rmx-drawer-title">\u4EFB\u52A1\u4F1A\u8BDD</span><button class="rmx-drawer-new">\uFF0B \u65B0\u5EFA\u4EFB\u52A1</button><button class="rmx-drawer-close">\u2715</button></div><div class="rmx-drawer-body"><div class="rmx-drawer-loading">\u52A0\u8F7D\u4E2D\u2026</div></div>';
  document.body.appendChild(drawer);
  drawer.querySelector('.rmx-drawer-close').addEventListener('click',closeDrawer);
  drawer.querySelector('.rmx-drawer-new').addEventListener('click',function(){closeDrawer();location.href=location.pathname});
  return drawer;
}
function openDrawer(){ensureDrawer();document.body.classList.add('rmx-drawer-open');if(!listLoaded)loadList()}
function closeDrawer(){document.body.classList.remove('rmx-drawer-open')}
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML}
function fmtTime(ts){if(!ts)return'';var diff=(Date.now()-ts)/1000;if(diff<3600)return Math.max(1,Math.floor(diff/60))+' \u5206\u949F\u524D';if(diff<86400)return Math.floor(diff/3600)+' \u5C0F\u65F6\u524D';return Math.floor(diff/86400)+' \u5929\u524D'}
/* \u540C\u6B65"\u7F51\u9875\u7AEF\u4FA7\u680F\u5F53\u524D\u53EF\u89C1\u7684\u4F1A\u8BDD"\uFF1Adsh \u7684\u8FC7\u6EE4/\u6392\u5E8F\u4F9D\u636E\u5728\u5185\u90E8\uFF08header \u65E0\u9879\u76EE\u5B57\u6BB5\uFF0C
   \u6301\u4E45\u4F1A\u8BDD 34 \u6761\u800C\u4FA7\u680F\u53EA\u663E\u793A 3 \u6761\uFF09\uFF0C\u670D\u52A1\u7AEF\u65E0\u6CD5\u590D\u73B0\uFF1B\u7528\u5207\u5BBD\u89C6\u53E3\u7684\u65B9\u5F0F\u8BFB\u4E00\u6B21\u4FA7\u680F\u3002 */
function syncVisibleFromSidebar(cb){
  var meta=document.querySelector('meta[name="viewport"]');
  var orig=meta?meta.getAttribute('content'):'';
  var veil=document.createElement('div');
  veil.className='rmx-veil';
  veil.textContent='\u6B63\u5728\u540C\u6B65\u4F1A\u8BDD\u5217\u8868\u2026';
  document.body.appendChild(veil);
  if(meta)meta.setAttribute('content','width=1280, initial-scale=0.29, user-scalable=yes');
  var tries=0;
  var timer=setInterval(function(){
    var rows=document.querySelectorAll('[class*="_sessionRow"]');
    var titles=[];
    for(var i=0;i<rows.length;i++){
      var t=(rows[i].textContent||'').trim();
      if(t&&t!=='\u65B0\u4F1A\u8BDD')titles.push(t);
    }
    if(titles.length||++tries>25){
      clearInterval(timer);
      window.__RMX_VISIBLE__=titles;
      if(meta)meta.setAttribute('content',orig||'width=device-width, initial-scale=1');
      if(veil.parentNode)veil.parentNode.removeChild(veil);
      cb(titles);
    }
  },200);
}
function loadList(){
  syncVisibleFromSidebar(function(visible){
  fetch('/dsh-remote-x/api/tasks',{headers:{'x-remote-nonce':window.__REMOTE_X_NONCE__||''}})
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})
    .then(function(data){
      listLoaded=true;
      var body=drawer.querySelector('.rmx-drawer-body');
      var all=[];
      (data.groups||[]).forEach(function(g){g.tasks.forEach(function(t){all.push(t)})});
      if(!all.length){body.innerHTML='<div class="rmx-drawer-empty">\u6682\u65E0\u4EFB\u52A1</div>';return}
      all.sort(function(a,b){return (b.updatedAt||0)-(a.updatedAt||0)});
      function matchesVisible(t){
        for(var i=0;i<visible.length;i++){
          var v=visible[i];
          if(v&&t.title&&(v.indexOf(t.title.slice(0,10))>=0||t.title.indexOf(v.slice(0,10))>=0))return true;
        }
        return false;
      }
      var shown=[],other=[];
      all.forEach(function(t){(matchesVisible(t)?shown:other).push(t)});
      // \u540C\u540D\u6807\u9898\uFF08\u4FA7\u680F\u53EA\u663E\u793A\u4E00\u6761\uFF09\u53BB\u91CD\uFF0C\u4FDD\u7559\u6700\u65B0
      var seen={};
      var dedup=[];
      shown.forEach(function(t){
        var k=(t.title||'').slice(0,24);
        if(seen[k])return;
        seen[k]=1;dedup.push(t);
      });
      shown=dedup;
      if(!shown.length){shown=all.slice(0,3);other=all.slice(3)}
      function taskRow(t){
        return '<div class="rmx-task'+(t.running?' rmx-running':'')+'" data-title="'+esc(t.title)+'"><span class="rmx-dot"></span><span class="rmx-task-title">'+esc(t.title)+'</span><span class="rmx-task-time">'+fmtTime(t.updatedAt)+'</span><span class="rmx-badge">'+(t.running?'\u8FDB\u884C\u4E2D':'\u5DF2\u5B8C\u6210')+'</span></div>';
      }
      var html='<div class="rmx-drawer-summary">\u7F51\u9875\u7AEF\u5F53\u524D\u4F1A\u8BDD\uFF08'+shown.length+'\uFF09</div>';
      shown.forEach(function(t){html+=taskRow(t)});
      if(other.length){
        html+='<div class="rmx-older-toggle">\u5176\u5B83\u5386\u53F2\u4F1A\u8BDD\uFF08'+other.length+'\uFF09<span class="rmx-older-arrow">\u25B8</span></div>';
        html+='<div class="rmx-older" style="display:none">';
        other.forEach(function(t){html+=taskRow(t)});
        html+='</div>';
      }
      body.innerHTML=html;
      body.querySelectorAll('.rmx-task').forEach(function(el){
        el.addEventListener('click',function(){openSession(el.getAttribute('data-title'))});
      });
      var toggle=body.querySelector('.rmx-older-toggle');
      if(toggle)toggle.addEventListener('click',function(){
        var box=body.querySelector('.rmx-older');
        var open=box.style.display!=='none';
        box.style.display=open?'none':'block';
        toggle.querySelector('.rmx-older-arrow').textContent=open?'\u25B8':'\u25BE';
      });
    })
    .catch(function(e){drawer.querySelector('.rmx-drawer-body').innerHTML='<div class="rmx-drawer-empty">\u52A0\u8F7D\u5931\u8D25('+(e.message||e)+')</div>'});
  });
}
/* \u6253\u5F00\u4F1A\u8BDD\uFF1Adsh \u65E0\u4F1A\u8BDD\u8DEF\u7531\u4E14\u7A84\u5C4F\u5378\u8F7D\u4FA7\u680F \u2192 \u5207\u5BBD\u5E03\u5C40\u89C6\u53E3\u9A97\u8FC7 React \u6E32\u67D3\u4FA7\u680F\uFF0C
   \u6309\u6807\u9898\u70B9\u4E2D sessionRow \u540E\u7ACB\u5373\u6062\u590D\u624B\u673A\u89C6\u53E3\uFF08\u4F1A\u8BDD\u5185\u90E8\u72B6\u6001\u4FDD\u7559\uFF09 */
function openSession(title){
  var meta=document.querySelector('meta[name="viewport"]');
  var orig=meta?meta.getAttribute('content'):'';
  if(meta)meta.setAttribute('content','width=1280, initial-scale=0.29, user-scalable=yes');
  var tries=0;
  var timer=setInterval(function(){
    var rows=document.querySelectorAll('[class*="_sessionRow"]');
    var hit=null,key=title?title.slice(0,10):'';
    for(var i=0;i<rows.length;i++){
      var txt=(rows[i].textContent||'').trim();
      if(key&&txt.indexOf(key)>=0){hit=rows[i];break}
    }
    if(hit||++tries>24){
      clearInterval(timer);
      if(hit)hit.click();
      setTimeout(function(){
        closeDrawer();
        if(meta)meta.setAttribute('content',orig||'width=device-width, initial-scale=1');
      },400);
    }
  },250);
}
function ensureBackbar(){
  if(document.querySelector('.rmx-backbar'))return;
  var bar=document.createElement('div');
  bar.className='rmx-backbar';
  bar.innerHTML='<button class="rmx-backbtn"><span class="rmx-backarrow">\u2190</span><span>\u4EFB\u52A1\u4F1A\u8BDD</span></button>';
  document.body.appendChild(bar);
  bar.querySelector('.rmx-backbtn').addEventListener('click',function(){
    if(document.body.classList.contains('rmx-drawer-open'))closeDrawer();else openDrawer();
  });
}
ensureBackbar();

/* \u65B0\u6D88\u606F\u5230\u8FBE\u65F6\u4FDD\u6301\u6EDA\u52A8\u5230\u5E95\uFF08\u4EC5\u5F53\u7528\u6237\u5DF2\u63A5\u8FD1\u5E95\u90E8\uFF0C\u4E0D\u6253\u65AD\u4E0A\u7FFB\u67E5\u770B\u5386\u53F2\uFF09 */
try{
  var sm=new MutationObserver(function(){
    var s=document.querySelector('[class*="_scrollBody"]');
    if(!s)return;
    var gap=s.scrollHeight-s.scrollTop-s.clientHeight;
    if(s.scrollHeight>s.clientHeight&&gap>0&&gap<400)s.scrollTop=s.scrollHeight;
  });
  sm.observe(document.body,{childList:true,subtree:true,characterData:true});
}catch(e){}
})();`;
    ctx.on("webserver/index-inject", ((table) => {
      table.push({ kind: "style", text: css });
      table.push({ kind: "script", placement: "body", text: mobileJs });
      table.push({ kind: "global", name: "__REMOTE_X_NONCE__", value: issueNonce() });
    }));
    ctx.logger.info(`dsh-remote-x: mobile layer injected (breakpoint ${breakpoint}px)`);
  } else {
    ctx.logger.warn("dsh-remote-x: inject/mobile.css missing \u2014 mobile layer disabled");
  }
  const base = path2.dirname(fileURLToPath(import.meta.url));
  const route = {
    kind: "prefix",
    path: "/dsh-remote-x/api",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const sub = url.pathname.replace(/\/+$/, "").slice("/dsh-remote-x/api".length);
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
          lanEnabled: (() => {
            try {
              return execFileSync("systemctl", ["--user", "is-active", "dsh-remote-proxy.service"], { encoding: "utf8" }).trim() === "active";
            } catch {
              return false;
            }
          })(),
          publicEnabled: publicTunnel !== null,
          publicUrl: publicTunnel?.url ?? null,
          cloudflaredAvailable: (() => {
            try {
              execFileSync("cloudflared", ["--version"], { stdio: "ignore" });
              return true;
            } catch {
              return false;
            }
          })(),
          version: "0.2.2"
        });
        return;
      }
      if (sub === "/tasks" && req.method === "GET") {
        try {
          const diag = {};
          try {
            const live0 = ctx.sessions.list()[0];
            diag.liveKeys = live0?.header !== void 0 ? Object.keys(live0.header) : null;
            diag.liveHeader = live0?.header ? JSON.parse(JSON.stringify(live0.header)) : null;
            const q = ctx.get("sessionQuery");
            if (q !== void 0) {
              const recs = await q.listSessions();
              diag.persistCount = recs.length;
              diag.persistFirstKeys = Object.keys(recs[0] ?? {});
              diag.persistFirst = JSON.parse(JSON.stringify(recs[0] ?? {})).toString().slice(0, 400);
            }
          } catch (error) {
            diag.error = error instanceof Error ? error.message : String(error);
          }
          sendJson(res, 200, { ...await buildTaskList(ctx), _diag: diag });
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (sub === "/qrcode" && req.method === "GET") {
        const text = url.searchParams.get("text") ?? "";
        if (text.length === 0 || text.length > 512) {
          sendError(res, 400, "text \u957F\u5EA6\u9700\u5728 1..512 \u4E4B\u95F4");
          return;
        }
        if (!/^https?:\/\//i.test(text)) {
          sendError(res, 400, "text \u5FC5\u987B\u662F http(s) \u94FE\u63A5");
          return;
        }
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        res.end(await renderQrSvg(text));
        return;
      }
      if (sub === "/lan-toggle" && req.method === "POST") {
        let raw = "";
        try {
          for await (const ch of req) raw += ch;
        } catch {
        }
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
        }
        const enabled = body.enabled === true;
        try {
          execFileSync("systemctl", ["--user", enabled ? "start" : "stop", "dsh-remote-proxy.service"], { stdio: "ignore" });
          sendJson(res, 200, { ok: true, enabled });
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
        } catch {
        }
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
        }
        const enabled = body.enabled === true;
        try {
          if (enabled) {
            if (!publicTunnel) {
              let proxyActive = false;
              try {
                proxyActive = execFileSync("systemctl", ["--user", "is-active", "dsh-remote-proxy.service"], { encoding: "utf8" }).trim() === "active";
              } catch {
              }
              if (!proxyActive) execFileSync("systemctl", ["--user", "start", "dsh-remote-proxy.service"], { stdio: "ignore" });
              const accessKey = config?.accessKey;
              const token = await resolveTokenLazy(ctx, config);
              const t = await startTunnel(proxyPort, { token: config?.cloudflareToken, domain: config?.publicDomain });
              const suffix = accessKey ? `/k/${encodeURIComponent(accessKey)}/` : token !== void 0 ? `/t/${encodeURIComponent(token)}/` : "/";
              publicTunnel = { url: t.url + suffix, stop: t.stop };
            }
            sendJson(res, 200, { ok: true, enabled: true, url: publicTunnel.url });
          } else {
            publicTunnel?.stop?.();
            publicTunnel = null;
            sendJson(res, 200, { ok: true, enabled: false });
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
      } catch {
      }
      publicTunnel = null;
      dispose();
    };
  }, "dsh-remote-x: api route");
  ctx.logger.info("dsh-remote-x: QR panel API mounted at /dsh-remote-x/api (token resolved lazily per request)");
}
export {
  Config,
  apply,
  inject,
  name
};
