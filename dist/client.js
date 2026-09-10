(() => {
/**
 * dsh-remote-x 客户端模块
 *
 * 1. 设置页「远程控制」标签 — QR 码 + 连接信息
 * 2. 移动端仪表盘 — 工作区卡片 + 任务列表（图4 样式）
 */
function factoryBody(require2) {
  // 模块加载成功标记（无视觉输出）

  var React = require2('react');
  var useState = React.useState;
  var useEffect = React.useEffect;
  var h = React.createElement;

  /* 设置页配色走 DSH 主题令牌（深浅主题自动跟随），fallback 保留浅色值 */
  var C = {
    text: 'var(--dsw-alias-label-primary, #1f2328)', sub: 'var(--dsw-alias-label-secondary, #656d76)',
    card: 'rgba(127,127,127,.07)', cardStrong: 'rgba(127,127,127,.13)',
    border: 'var(--dsw-alias-border-l2, #d0d7de)', borderStrong: 'var(--dsw-alias-border-l1, #afb8c1)',
    accent: 'var(--dsw-alias-state-business-primary, #1a7f37)', accentText: 'var(--dsw-alias-state-business-primary, #1a7f37)', accentDim: 'rgba(103,158,254,.14)',
    danger: 'var(--dsw-alias-state-error-primary, #cf222e)', dangerText: 'var(--dsw-alias-state-error-primary, #cf222e)', dangerDim: 'rgba(242,90,90,.12)',
    warn: 'var(--dsw-alias-state-warning-primary, #9a6700)', warnDim: 'rgba(245,166,35,.12)', radius: 14,
  };

  function Toggle(props) {
    return h('button', {
      type: 'button', role: 'switch', 'aria-checked': props.on, title: props.title,
      disabled: props.busy === true, onClick: props.onChange,
      style: { width: 42, height: 24, borderRadius: 999, border: 'none', padding: 0,
        cursor: props.busy ? 'wait' : 'pointer', background: props.on ? C.accent : 'rgba(127,127,127,.35)',
        position: 'relative', transition: 'background .2s', flexShrink: 0, opacity: props.busy ? 0.7 : 1 },
    }, h('span', { style: { position: 'absolute', top: 3, left: props.on ? 21 : 3, width: 18, height: 18,
      borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgbadebugLog(0,0,0.25)', transition: 'left .2s' } }));
  }

  /* ==================================================================
   * 生命周期 / 增量渲染 / 虚拟列表 工具类
   * ================================================================== */
  function DisposableRegistry() {
    var items = [];
    this.register = function(r) { items.push(r); return r; };
    this.registerTimer = function(id) { items.push({ dispose: function() { clearTimeout(id); clearInterval(id); } }); return id; };
    this.registerListener = function(target, type, listener, opts) {
      target.addEventListener(type, listener, opts);
      items.push({ dispose: function() { target.removeEventListener(type, listener, opts); } });
      return listener;
    };
    this.disposeAll = function() {
      for (var i = items.length - 1; i >= 0; i--) {
        try {
          var r = items[i];
          if (r && typeof r.dispose === 'function') r.dispose();
          else if (r && typeof r.unsubscribe === 'function') r.unsubscribe();
          else if (r && typeof r.disconnect === 'function') r.disconnect();
          else if (r && typeof r.close === 'function') r.close();
        } catch(e) {}
      }
      items = [];
    };
    this.size = function() { return items.length; };
  }

  function IncrementalRenderer(container) {
    var prevSig = null;
    var prevStatus = null;
    var rafId = null;

    this.update = function(sig, statusMap, fullRender) {
      if (sig !== prevSig) {
        fullRender();
        prevSig = sig;
        prevStatus = statusMap;
        return;
      }
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(function() {
        rafId = null;
        for (var sid in statusMap) {
          if (statusMap[sid].state === (prevStatus[sid] && prevStatus[sid].state)) continue;
          var row = container.querySelector('[data-open="' + sid + '"]');
          if (!row) continue;
          var info = statusMap[sid];
          row.classList.toggle('rmx-running', info.running);
          var dot = row.querySelector('.rmx-dot');
          if (dot) dot.style.cssText = info.running ? 'background:#2fbf71;box-shadow:0 0 6px rgba(47,191,113,.7)' : '';
          var badge = row.querySelector('.rmx-task-badge');
          if (badge) {
            badge.className = 'rmx-task-badge ' + (info.running ? 'rmx-badge-run' : (info.blank ? 'rmx-badge-blank' : 'rmx-badge-done'));
            badge.textContent = info.running ? '进行中' : (info.blank ? '新会话' : '已完成');
          }
        }
        prevStatus = statusMap;
      });
    };
    this.reset = function() { prevSig = null; prevStatus = null; };
    this.dispose = function() { if (rafId) cancelAnimationFrame(rafId); rafId = null; };
  }

  function VirtualList(container, opts) {
    var itemHeight = opts.itemHeight || 60;
    var bufferSize = opts.bufferSize || 10;
    var items = [];
    var scrollRaf = null;
    var lastStart = -1, lastEnd = -1;

    var topSpacer = document.createElement('div');
    var content = document.createElement('div');
    var bottomSpacer = document.createElement('div');
    topSpacer.style.height = '0px';
    bottomSpacer.style.height = '0px';
    container.appendChild(topSpacer);
    container.appendChild(content);
    container.appendChild(bottomSpacer);

    function renderVisible() {
      var scrollTop = container.scrollTop;
      var visibleStart = Math.floor(scrollTop / itemHeight);
      var visibleCount = Math.ceil(container.clientHeight / itemHeight);
      var startIdx = Math.max(0, visibleStart - bufferSize);
      var endIdx = Math.min(items.length, visibleStart + visibleCount + bufferSize);
      if (startIdx === lastStart && endIdx === lastEnd) return;
      lastStart = startIdx; lastEnd = endIdx;

      topSpacer.style.height = (startIdx * itemHeight) + 'px';
      bottomSpacer.style.height = Math.max(0, (items.length - endIdx) * itemHeight) + 'px';

      var html = '';
      for (var i = startIdx; i < endIdx; i++) html += opts.renderItem(items[i], i);
      content.innerHTML = html;
    }

    var scrollListener = function() {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(function() { scrollRaf = null; renderVisible(); });
    };
    container.addEventListener('scroll', scrollListener, { passive: true });

    this.setItems = function(newItems) {
      items = newItems;
      lastStart = -1; lastEnd = -1;
      renderVisible();
    };
    this.scrollTo = function(index) {
      container.scrollTop = index * itemHeight;
    };
    this.dispose = function() {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      container.removeEventListener('scroll', scrollListener);
    };
  }

  /* ==================================================================
   * 1) 设置页远程控制
   * ================================================================== */
  function RemoteControlSection() {
    var infoState = useState(null); var info = infoState[0]; var setInfo = infoState[1];
    var errState = useState(null); var error = errState[0]; var setError = errState[1];
    var copiedState = useState(false); var copied = copiedState[0]; var setCopied = copiedState[1];
    var ipIdxState = useState(0); var ipIndex = ipIdxState[0]; var setIpIndex = ipIdxState[1];
    var lanOnState = useState(false); var lanOn = lanOnState[0]; var setLanOn = lanOnState[1];
    var busyState = useState(false); var busy = busyState[0]; var setBusy = busyState[1];
    var pubOnState = useState(false); var publicOn = pubOnState[0]; var setPublicOn = pubOnState[1];
    var pubUrlState = useState(null); var publicUrl = pubUrlState[0]; var setPublicUrl = pubUrlState[1];
    var pubBusyState = useState(false); var publicBusy = pubBusyState[0]; var setPublicBusy = pubBusyState[1];
    var cfState = useState(true); var cfAvailable = cfState[0]; var setCfAvailable = cfState[1];

    var entry = info && info.entry ? info.entry : null;
    var shareUrl = entry && info && info.lanIps && info.lanIps[ipIndex]
      ? entry.replace('http://' + info.lanIps[0] + ':', 'http://' + info.lanIps[ipIndex] + ':') : entry;
    var nonce = function() { return (window.__REMOTE_X_NONCE__ || ''); };

    useEffect(function() {
      var alive = true;
      fetch('/dsh-remote-x/api/qr-info', { headers: { 'x-remote-nonce': String(nonce()) } })
        .then(function(res) { return res.ok ? res.json() : Promise.reject(new Error('加载失败 (' + res.status + ')')); })
        .then(function(data) { if (!alive) return; setInfo(data); setLanOn(!!data.lanEnabled); setPublicOn(!!data.publicEnabled); setPublicUrl(data.publicUrl || null); setCfAvailable(data.cloudflaredAvailable !== false); })
        .catch(function(err) { if (alive) setError(String(err.message || err)); });
      return function() { alive = false; };
    }, []);

    var copy = function() { if (!shareUrl) return; try { navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(function() { setCopied(false); }, 1500); } catch(e) {} };
    var copyPublic = function() { if (!publicUrl) return; try { navigator.clipboard.writeText(publicUrl); setCopied(true); setTimeout(function() { setCopied(false); }, 1500); } catch(e) {} };

    var toggleLan = function() { if (busy) return; var next = !lanOn; setBusy(true); setLanOn(next);
      fetch('/dsh-remote-x/api/lan-toggle', { method: 'POST', headers: { 'content-type': 'application/json', 'x-remote-nonce': String(nonce()) }, body: JSON.stringify({ enabled: next }) })
        .then(function(r) { if (!r.ok) throw new Error('fail'); }).catch(function() { setLanOn(!next); }).finally(function() { setBusy(false); }); };
    var togglePublic = function() { if (publicBusy) return; var next = !publicOn; setPublicBusy(true); setPublicOn(next);
      fetch('/dsh-remote-x/api/public-toggle', { method: 'POST', headers: { 'content-type': 'application/json', 'x-remote-nonce': String(nonce()) }, body: JSON.stringify({ enabled: next }) })
        .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('fail')); })
        .then(function(d) { if (d.enabled) setPublicUrl(d.url || null); else setPublicUrl(null); })
        .catch(function() { setPublicOn(!next); }).finally(function() { setPublicBusy(false); }); };

    var ready = info !== null && lanOn && info.tokenDetected && info.proxyPort > 0;
    var qrSrc = shareUrl ? '/dsh-remote-x/api/qrcode?text=' + encodeURIComponent(shareUrl) : '';
    var multiIp = info && info.lanIps && info.lanIps.length > 1;

    var badge = function(on) { return on
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 999, background: C.accentDim, border: '1px solid rgba(26,127,55,0.30)', fontSize: 12.5, color: C.accentText, whiteSpace: 'nowrap' } }, h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: C.accent, boxShadow: '0 0 8px ' + C.accent } }), '已启用')
      : h('div', { style: { padding: '5px 12px', borderRadius: 999, background: C.card, border: '1px solid ' + C.border, fontSize: 12.5, color: C.sub, whiteSpace: 'nowrap' } }, '已停用'); };

    var notice = error ? h('div', { style: { padding: 16, borderRadius: C.radius, background: C.dangerDim, border: '1px solid rgba(207,34,46,0.30)', color: C.dangerText, fontSize: 13, lineHeight: 1.6 } }, error)
      : !info ? h('div', { style: { padding: 24, textAlign: 'center', color: C.sub, fontSize: 13 } }, '加载中…')
      : !lanOn ? h('div', { style: { padding: 16, borderRadius: C.radius, background: C.card, border: '1px solid ' + C.border, fontSize: 13, color: C.sub, lineHeight: 1.7, textAlign: 'center' } }, '局域网访问已关闭。')
      : !info.tokenDetected ? h('div', { style: { padding: 16, borderRadius: C.radius, background: C.card, border: '1px solid ' + C.border, fontSize: 13, color: C.sub } }, '未检测到登录口令。') : null;

    var tips = [{ icon: '📶', text: '手机与电脑需在同一局域网内' }, { icon: '📱', text: '扫码即用手机打开网页端' }, { icon: '🔒', text: '地址含登录口令，可安全分享' }];

    return h('section', { style: { maxWidth: 640, margin: '0 auto', color: C.text } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 } },
        h('div', { style: { flex: 1 } }, h('div', { style: { fontSize: 18, fontWeight: 600 } }, '远程控制'), h('div', { style: { fontSize: 12.5, color: C.sub, marginTop: 2 } }, '用手机扫码接管网页端')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, badge(lanOn), h(Toggle, { on: lanOn, onChange: toggleLan, busy: busy }))),
      notice,
      ready && h('div', { style: { padding: 28, borderRadius: 16, background: C.cardStrong, border: '1px solid ' + C.border, textAlign: 'center', marginTop: 4 } },
        h('div', { style: { display: 'inline-block', padding: 14, borderRadius: 14, background: '#fff', border: '1px solid ' + C.border } },
          h('img', { src: qrSrc, width: 196, height: 196, alt: 'QR', style: { display: 'block', borderRadius: 4 } })),
        h('div', { style: { marginTop: 14, fontSize: 12.5, color: C.sub } }, '手机相机扫码即可打开网页端')),
      ready && h('div', { style: { marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: C.card, border: '1px solid ' + C.border } },
        h('span', { style: { opacity: 0.7 } }, '🔗'),
        h('code', { style: { flex: 1, fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all', color: C.text } }, shareUrl),
        h('button', { onClick: copy, style: { fontSize: 12.5, padding: '6px 14px', borderRadius: 8, border: '1px solid ' + C.borderStrong, background: copied ? C.accentDim : 'transparent', color: copied ? C.accentText : C.text } }, copied ? '已复制 ✓' : '复制')),
      ready && h('div', { style: { marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 } },
        tips.map(function(t, i) { return h('div', { key: String(i), style: { display: 'flex', alignItems: 'flex-start', gap: 12, fontSize: 13, color: C.sub, lineHeight: 1.5 } },
          h('span', { style: { fontSize: 15, flexShrink: 0 } }, t.icon), h('span', null, t.text)); })),
      h('div', { style: { marginTop: 24, padding: 20, borderRadius: 16, background: C.cardStrong, border: '1px solid ' + C.border } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 } },
          h('div', { style: { flex: 1 } }, h('div', { style: { fontSize: 16, fontWeight: 600 } }, '公网访问'), h('div', { style: { fontSize: 12.5, color: C.sub, marginTop: 2 } }, '人在外面也能连（cloudflared 隧道）')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, badge(publicOn), h(Toggle, { on: publicOn, onChange: togglePublic, busy: publicBusy, title: '公网访问' }))),
        !cfAvailable ? h('div', { style: { padding: 16, borderRadius: C.radius, background: C.warnDim, border: '1px solid rgba(154,103,0,0.30)', color: C.warn, fontSize: 13, lineHeight: 1.7 } }, '未检测到 cloudflared：公网模式需要它。') : null,
        publicOn && publicUrl && h('div', { style: { marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: C.card, border: '1px solid ' + C.border } },
          h('span', { style: { opacity: 0.7 } }, '🌐'),
          h('code', { style: { flex: 1, fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all', color: C.text } }, publicUrl),
          h('button', { onClick: copyPublic, style: { fontSize: 12.5, padding: '6px 14px', borderRadius: 8, border: '1px solid ' + C.borderStrong, background: C.card, color: C.text } }, '复制')),
        publicOn && publicUrl && h('div', { style: { marginTop: 14, display: 'flex', gap: 14, alignItems: 'center', padding: '12px 14px', borderRadius: 12, background: C.card, border: '1px solid ' + C.border } },
          h('div', { style: { padding: 8, background: '#fff', borderRadius: 8, flexShrink: 0 } },
            h('img', { src: '/dsh-remote-x/api/qrcode?text=' + encodeURIComponent(publicUrl), width: 132, height: 132, alt: '公网访问二维码', style: { display: 'block' } })),
          h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } }, '手机扫码经公网隧道打开控制台（无需同一局域网）'))));
  }

  /* ==================================================================
   * 2) 移动端仪表盘
   * ================================================================== */
  var SESSION_KEY = 'rmx-view';

  function mobileLayer(ctx, sessions, workspaces) {
    if (!sessions || !workspaces) return;

    var dashEl = null, backEl = null, menuEl = null, menuBackdrop = null;
    var collapsed = {};
    var flatMode = false;
    var isMobile = function() { return window.innerWidth < 768; };
    var disposables = new DisposableRegistry();
    var resizeHandler = null;
    var incremental = null;
    var virtualList = null;
    var unsubSessions = null, unsubWorkspaces = null;
    var cleanup = function() {
      disposables.disposeAll();
      if (incremental) { incremental.dispose(); incremental = null; }
      if (virtualList) { virtualList.dispose(); virtualList = null; }
      unsubSessions = null; unsubWorkspaces = null;
      // 注意：不能在这里注销 resize 监听。它是「桌面↔移动」切换的唯一入口，
      // 一旦注销，之后再切到移动端就再也不会重建仪表盘/返回条（表现为空白，只能刷新恢复）。
    };
    function trackSub(unsub) { disposables.register({ dispose: unsub }); return unsub; }

    /* ---- SVG 图标 ---- */
    var ICON = {
      folder: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
      plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      chevDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
      refresh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      viewList: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
      collapse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
      arrowLeft: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
      book: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
      trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      check: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><polyline points="20 6 9 17 4 12"/></svg>',
      play: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><polyline points="4 12 9 12"/><circle cx="12" cy="12" r="9" opacity=".35"/></svg>',
    };

    /* ---- 主题同步 ---- */
    /* 变量设到 body 上：仪表盘、返回条(#rm-x-backbar)、长按菜单全部继承。
     * 主题属性以 body 为准（theme-presenter 设在 body），html 检查保留兼容。 */
    function syncTheme() {
      var dark = document.body.hasAttribute('data-ds-dark-theme')
        || document.documentElement.hasAttribute('data-ds-dark-theme')
        || (!(document.body.hasAttribute('data-ds-light-theme') || document.documentElement.hasAttribute('data-ds-light-theme'))
          && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      var target = document.body.style;
      if (dark) {
        target.setProperty('--rmx-bg', '#161618');
        target.setProperty('--rmx-fg', '#e6e6e6');
        target.setProperty('--rmx-card', 'rgba(255,255,255,.05)');
        target.setProperty('--rmx-card-border', 'rgba(255,255,255,.12)');
        target.setProperty('--rmx-muted', 'rgba(255,255,255,.45)');
      } else {
        target.setProperty('--rmx-bg', '#fff');
        target.setProperty('--rmx-fg', '#1f2328');
        target.setProperty('--rmx-card', 'rgba(0,0,0,.03)');
        target.setProperty('--rmx-card-border', 'rgba(0,0,0,.12)');
        target.setProperty('--rmx-muted', 'rgba(0,0,0,.45)');
      }
    }
    // 监听 DSH 主题属性变化
    var themeObserver = disposables.register(new MutationObserver(function() { syncTheme(); }));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-ds-light-theme'] });

    /* ---- 长按菜单 ---- */
    function showMenu(x, y, sid, title) {
      hideMenu();
      menuBackdrop = document.createElement('div');
      menuBackdrop.className = 'rmx-menu-backdrop';
      menuBackdrop.addEventListener('click', hideMenu);
      document.body.appendChild(menuBackdrop);

      menuEl = document.createElement('div');
      menuEl.className = 'rmx-menu';
      menuEl.style.left = Math.min(x, window.innerWidth - 160) + 'px';
      menuEl.style.top = Math.min(y, window.innerHeight - 100) + 'px';
      menuEl.innerHTML = '<button class="rmx-menu-item" data-action="open" aria-label="打开会话">' + ICON.book + ' 打开会话</button>'
        + '<button class="rmx-menu-item danger" data-action="delete" aria-label="归档会话">' + ICON.trash + ' 归档会话</button>';
      document.body.appendChild(menuEl);

      menuEl.querySelector('[data-action="open"]').addEventListener('click', function() { hideMenu(); enterSession(); sessions.open(sid); });
      menuEl.querySelector('[data-action="delete"]').addEventListener('click', function() {
        hideMenu();
        if (confirm('确定删除「' + (title || '新会话') + '」？')) {
          try { workspaces.archiveSession(sid); } catch(e) {}
          render();
        }
      });
    }
    function hideMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      if (menuBackdrop) { menuBackdrop.remove(); menuBackdrop = null; }
    }

    function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
    function relTime(ts) {
      if (!ts || typeof ts !== 'number' || isNaN(ts)) return '';
      var sec = (Date.now() - ts) / 1000;
      if (sec < 60) return '刚刚';
      if (sec < 3600) return Math.floor(sec / 60) + '分';
      if (sec < 86400) return Math.floor(sec / 3600) + '小时';
      return Math.floor(sec / 86400) + '天';
    }
    function basename(p) { return (p || '').split('/').filter(Boolean).pop() || p; }

    /* ==================================================================
     * 兼容层：应对 dsh 升级（Session format v2 字段改名 / 组件类名重构）
     * 目标：任一外部结构变化都不应导致移动端白屏。
     * ================================================================== */
    function pick(obj, keys, fallback) {
      if (!obj) return fallback;
      for (var i = 0; i < keys.length; i++) {
        var v = obj[keys[i]];
        if (v !== undefined && v !== null) return v;
      }
      return fallback;
    }
    function sessionTitle(s) {
      return pick(s, ['displayTitle', 'title', 'name', 'summary'], '') || '新会话';
    }
    function sessionTime(s) {
      return pick(s, ['updatedAt', 'updatedAtMs', 'lastActiveAt', 'modifiedAt', 'mtime', 'createdAt'], 0) || 0;
    }
    function isRunning(s) {
      var r = pick(s, ['running', 'isRunning', 'active', 'busy'], undefined);
      if (typeof r === 'boolean') return r;
      var st = pick(s, ['status', 'state', 'phase'], '');
      return st === 'running' || st === 'active' || st === 'busy' || st === 'in_progress';
    }
    function isBlank(s) {
      var b = pick(s, ['blank', 'isEmpty', 'empty'], undefined);
      if (typeof b === 'boolean') return b;
      var n = pick(s, ['messageCount', 'messagesCount', 'turnCount'], undefined);
      if (typeof n === 'number') return n === 0;
      return false;
    }
    function sessionsById(snap) {
      if (snap && snap.byId) return snap.byId;
      var arr = pick(snap, ['items', 'sessions', 'list'], null);
      var map = {};
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) { var s = arr[i]; if (s && s.id) map[s.id] = s; }
      }
      return map;
    }
    function workspacesArr(snap) {
      var a = pick(snap, ['items', 'workspaces', 'list'], null);
      if (Array.isArray(a)) return a;
      if (snap && snap.byId) return Object.values(snap.byId);
      return [];
    }
    function wsSessions(ws) {
      var sids = pick(ws, ['sessionIds', 'sessions', 'sessionIdsList'], []);
      if (!Array.isArray(sids)) return [];
      return sids.map(function(x) { return (x && typeof x === 'object') ? x.id : x; });
    }
    function wsKey(ws) { return pick(ws, ['workspaceId', 'id', 'key'], ''); }
    function wsPath(ws) { return pick(ws, ['path', 'dir', 'cwd', 'rootPath'], ''); }
    function wsTitle(ws) { return pick(ws, ['title', 'name'], '') || basename(wsPath(ws)); }
    /* 结构兜底：dsh 组件类名若重构，按候选顺序回退探测（保持「在 root 内查找」的原语义） */
    function findIn(root, sels) {
      if (!root) return null;
      for (var i = 0; i < sels.length; i++) {
        try { var e = root.querySelector(sels[i]); if (e) return e; } catch (e2) {}
      }
      return null;
    }
    function pickEl(sels) { return findIn(document, sels); }
    /* 空态：区分「还在加载」与「确实没任务」，避免加载慢被误看成白屏 */
    function emptyHtml(loading) {
      return loading
        ? '<div class="rmx-empty-all">正在加载任务…</div>'
        : '<div class="rmx-empty-all">暂无任务<br><span style="font-size:12px;opacity:.6">打开电脑端 DSH 创建第一个任务</span></div>';
    }
    /* 任务行：三处列表（工作区/未分类/单列）共用，字段读取统一走兼容层 */
    function taskRow(s) {
      var run = isRunning(s);
      var dotS = run ? ' background:#2fbf71;box-shadow:0 0 6px rgba(47,191,113,.7)' : '';
      var badge = run
        ? '<span class="rmx-task-badge rmx-badge-run">' + ICON.play + '进行中</span>'
        : isBlank(s)
          ? '<span class="rmx-task-badge rmx-badge-blank">新会话</span>'
          : '<span class="rmx-task-badge rmx-badge-done">' + ICON.check + '已完成</span>';
      return '<button class="rmx-task' + (run ? ' rmx-running' : '') + '" data-open="' + esc(s.id) + '">'
        + '<span class="rmx-dot" style="' + dotS + '"></span>'
        + '<div class="rmx-task-main"><div class="rmx-task-title">' + esc(sessionTitle(s)) + '</div>'
        + '<div class="rmx-task-time">' + esc(relTime(sessionTime(s))) + '</div></div>' + badge + '</button>';
    }
    var SEL_FRAME = ['[class*="_frame"]', '[class*="frame"]', '[class*="Frame"]', '#root > div'];
    var SEL_SIDEBAR = ['[class*="_sidebarCol"]', '[class*="sidebar"]', '[class*="Sidebar"]'];
    // dsh 0.1.5 右侧栏改名 rightbarCol（旧 detailsCol 保留兼容）
    var SEL_DETAILS = ['[class*="_rightbarCol"]', '[class*="_detailsCol"]', '[class*="rightbar"]', '[class*="details"]', '[class*="Details"]'];
    var SEL_CENTER = ['[class*="_centerCol"]', '[class*="center"]', '[class*="Center"]'];
    // dsh 0.1.5 拖拽把手改名 widthHandle（旧 handle 保留兼容）
    var SEL_HANDLE = ['[class*="_widthHandle"]', '[class*="_handle"]', '[class*="widthHandle"]', '[class*="handle"]'];
    var SEL_OVERLAY = ['[class*="_overlayLayer"]', '[class*="overlay"]'];

    function buildSkeleton() {
      dashEl = document.createElement('div');
      dashEl.id = 'rm-x-dashboard';
      dashEl.innerHTML = '<div class="rmx-header"><h1 class="rmx-title">远程控制</h1><p class="rmx-subtitle">手机与电脑需在同一局域网内</p></div><div class="rmx-info-card">本次连接可查看当前设备上已打开的项目、任务和会话。</div><div class="rmx-section-head"><h2 class="rmx-section-title">当前设备上的工作区和任务</h2><span class="rmx-section-tools"><button class="rmx-tool-btn rmx-view-toggle" title="切换视图">' + ICON.viewList + '</button><button class="rmx-tool-btn rmx-collapse-all" title="展开/折叠全部">' + ICON.collapse + '</button><button class="rmx-tool-btn rmx-refresh" title="刷新">' + ICON.refresh + '</button></span></div><div class="rmx-counts"></div><div class="rmx-body" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(env(safe-area-inset-bottom,0px)+24px)"></div>';
      document.body.appendChild(dashEl);

      backEl = document.createElement('div');
      backEl.id = 'rm-x-backbar';
      backEl.innerHTML = '<button class="rmx-backbtn"><span class="rmx-backarrow">' + ICON.arrowLeft + '</span><span class="rmx-backbar-title">任务会话</span></button>';
      var root = document.getElementById('root');
      if (root) root.parentNode.insertBefore(backEl, root);
      else document.body.appendChild(backEl);

      // Event delegation: attach listeners once to body, delegate by data attributes
      dashEl.addEventListener('click', function(e) {
        var target = e.target.closest('[data-collapse]');
        if (target) { var w = target.dataset.collapse; collapsed[w] = !collapsed[w]; render(); return; }
        target = e.target.closest('[data-add]');
        if (target) {
          var wid = target.dataset.add;
          enterSession();
          try {
            if (typeof sessions.create === 'function') {
              sessions.create(wid ? { workspaceId: wid } : {}).then(function(id) { sessions.open(id); }).catch(function() {});
            }
          } catch(ex) {}
          return;
        }
        target = e.target.closest('[data-open]');
        if (target) {
          var sid = target.dataset.open;
          if (sid && typeof sessions.open === 'function') { enterSession(); sessions.open(sid); }
          return;
        }
        if (e.target.closest('.rmx-refresh')) { refreshAndRender(); return; }
        if (e.target.closest('.rmx-view-toggle')) { flatMode = !flatMode; e.target.closest('.rmx-view-toggle').innerHTML = flatMode ? ICON.collapse : ICON.viewList; render(); return; }
        if (e.target.closest('.rmx-collapse-all')) {
          var allCollapsed = Object.keys(collapsed).length > 0 && Object.values(collapsed).every(function(v) { return v; });
          collapsed = {};
          if (!allCollapsed) { var ws2 = workspaces.list.getSnapshot().items || []; for (var i = 0; i < ws2.length; i++) collapsed[ws2[i].workspaceId] = true; collapsed['__ungrouped__'] = true; }
          render();
          return;
        }
      });
      // Touch long-press delegation for context menu
      dashEl.addEventListener('touchstart', function(e) {
        var target = e.target.closest('[data-open]');
        if (!target) return;
        var touch = e.touches[0];
        var sid = target.dataset.open;
        var longTimer = setTimeout(function() {
          var title = target.querySelector('.rmx-task-title');
          showMenu(touch.clientX, touch.clientY, sid, title ? title.textContent : '');
        }, 500);
        var cancel = function() { clearTimeout(longTimer); dashEl.removeEventListener('touchmove', cancel); dashEl.removeEventListener('touchend', cancel); dashEl.removeEventListener('touchcancel', cancel); };
        dashEl.addEventListener('touchmove', cancel, { passive: true });
        dashEl.addEventListener('touchend', cancel, { passive: true });
        dashEl.addEventListener('touchcancel', cancel, { passive: true });
      }, { passive: true });
      backEl.querySelector('.rmx-backbtn').addEventListener('click', function() { exitToDashboard(); });
      // 原生「右侧栏」开关（会话头部 _headerCorner 里的按钮）在手机上点了无效——
      // remote-x 把 _rightbarCol 隐藏了，DSH 只切内部状态、界面无变化。
      // 捕获阶段把它的点击转发给返回栏里那个能打开右侧插件面板的开关，使之可用。
      document.addEventListener('click', function(e) {
        if (!isMobile() || !document.body.classList.contains('rm-x-in-session')) return;
        var el = e.target;
        if (!el || typeof el.closest !== 'function') return;
        var btn = el.closest('button');
        if (!btn || !btn.closest('[class*="_headerCorner"]')) return;
        e.preventDefault();
        e.stopPropagation();
        var bar = document.querySelector('[class*="_toggleCluster"] button');
        if (bar) bar.click();
      }, true);
    }

    function getDataReady() {
      var ss = sessions.list.getSnapshot();
      var byId = sessionsById(ss);
      // workspaces 仅用于分组，不作为就绪条件：
      // 避免其字段改名或加载慢（新版已知性能回退）导致仪表盘永远停在空白。
      return Object.keys(byId).length > 0 || ss.phase === 'ready';
    }

    var renderPending = false;
    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(function() { renderPending = false; render(); });
    }
    function refreshAndRender() {
      if (typeof sessions.refresh === 'function') sessions.refresh();
      if (typeof workspaces.refresh === 'function') workspaces.refresh();
      render();
    }

    function render() {
      if (!dashEl) return;
      var wsSnap = workspaces.list.getSnapshot();
      var sessSnap = sessions.list.getSnapshot();
      var byId = sessionsById(sessSnap);
      var currentId = pick(sessSnap, ['current', 'currentId', 'activeId'], undefined);
      var body = dashEl.querySelector('.rmx-body');
      var counts = dashEl.querySelector('.rmx-counts');

      // 侧栏过滤逻辑：归档、subagent、blank（仅 current 可见）
      var archived = {};
      (pick(wsSnap, ['archivedSessionIds', 'archivedIds', 'archived'], []) || []).forEach(function(id) { archived[id] = true; });
      function isVisible(s) {
        return pick(s, ['origin', 'source', 'kind'], '') !== 'subagent' && !archived[s.id] && (!isBlank(s) || s.id === currentId);
      }

      var wsItems = workspacesArr(wsSnap);
      // 收集工作区成员
      var wsSessionIds = {};
      for (var wi2 = 0; wi2 < wsItems.length; wi2++) {
        var sids2 = wsSessions(wsItems[wi2]);
        for (var si2 = 0; si2 < sids2.length; si2++) wsSessionIds[sids2[si2]] = true;
      }

      var totalVisible = 0;
      var html = '';

      // 工作区组
      for (var wi = 0; wi < wsItems.length; wi++) {
        var ws = wsItems[wi];
        var sids = wsSessions(ws);
        var tasks = [];
        for (var si = 0; si < sids.length; si++) { var s = byId[sids[si]]; if (s && isVisible(s)) tasks.push(s); }
        if (tasks.length === 0) continue;
        totalVisible += tasks.length;
        var wsK = wsKey(ws);
        var isCol = collapsed[wsK];
        html += '<div class="rmx-card"><div class="rmx-card-head">';
        html += '<div class="rmx-ws-icon">' + ICON.folder + '</div>';
        html += '<div class="rmx-ws-main"><div class="rmx-ws-name-row"><span class="rmx-ws-name">' + esc(wsTitle(ws)) + '</span><span class="rmx-ws-badge">本地</span></div>';
        html += '<div class="rmx-ws-path">' + esc(wsPath(ws)) + '</div>';
        var wsLatestTime = 0; for (var wi2 = 0; wi2 < tasks.length; wi2++) { var wt = sessionTime(tasks[wi2]); if (wt > wsLatestTime) wsLatestTime = wt; }
        html += '<div class="rmx-ws-meta">更新于 ' + esc(relTime(wsLatestTime)) + '</div></div>';
        html += '<span class="rmx-ws-count">' + tasks.length + ' 个任务</span>';
        html += '<button class="rmx-ws-chevron" data-collapse="' + esc(wsK) + '" style="' + (isCol ? 'transform:rotate(-90deg)' : '') + '">' + ICON.chevDown + '</button>';
        html += '<button class="rmx-ws-add" data-add="' + esc(wsK) + '" title="新建任务">' + ICON.plus + '</button></div>';
        if (!isCol) {
          html += '<div class="rmx-tasks">';
          for (var ti = 0; ti < tasks.length; ti++) html += taskRow(tasks[ti]);
          html += '</div>';
        }
        html += '</div>';
      }

      // 未分类会话
      var orphans = Object.values(byId).filter(function(s) { return !wsSessionIds[s.id] && isVisible(s); });
      if (orphans.length > 0) {
        totalVisible += orphans.length;
        var isOrCol = collapsed['__ungrouped__'];
        html += '<div class="rmx-card"><div class="rmx-card-head">';
        html += '<div class="rmx-ws-main"><div class="rmx-ws-name-row"><span class="rmx-ws-name">未分类</span></div></div>';
        html += '<span class="rmx-ws-count">' + orphans.length + ' 个任务</span>';
        html += '<button class="rmx-ws-chevron" data-collapse="__ungrouped__" style="' + (isOrCol ? 'transform:rotate(-90deg)' : '') + '">' + ICON.chevDown + '</button></div>';
        if (!isOrCol) {
          html += '<div class="rmx-tasks">';
          for (var oi = 0; oi < orphans.length; oi++) html += taskRow(orphans[oi]);
          html += '</div>';
        }
        html += '</div>';
      }

      var loading = !getDataReady();
      counts.textContent = wsItems.length + ' 个工作区 · ' + totalVisible + ' 个任务';

      // 单列表模式：所有会话按更新时间排序
      if (flatMode) {
        var flatSessions = Object.values(byId).filter(function(s) { return isVisible(s); });
        flatSessions.sort(function(a, b) { return (sessionTime(b) || 0) - (sessionTime(a) || 0); });
        if (flatSessions.length === 0) {
          if (virtualList) { virtualList.dispose(); virtualList = null; }
          if (incremental) incremental.reset();
          body.innerHTML = emptyHtml(loading);
        } else if (flatSessions.length > 100) {
          if (incremental) { incremental.reset(); }
          if (!virtualList) {
            body.innerHTML = '';
            virtualList = new VirtualList(body, { itemHeight: 60, bufferSize: 10, renderItem: function(s) { return taskRow(s); } });
          }
          virtualList.setItems(flatSessions);
        } else {
          if (virtualList) { virtualList.dispose(); virtualList = null; }
          var flatHtml = '<div class="rmx-tasks" style="border-top:none">';
          for (var fi = 0; fi < flatSessions.length; fi++) flatHtml += taskRow(flatSessions[fi]);
          flatHtml += '</div>';
          var flatSig = 'flat:' + flatSessions.map(function(s) { return s.id; }).join(',');
          var flatStatus = {};
          for (var fs = 0; fs < flatSessions.length; fs++) {
            var s2 = flatSessions[fs];
            flatStatus[s2.id] = { running: isRunning(s2), blank: isBlank(s2), state: isRunning(s2) ? 'run' : (isBlank(s2) ? 'blank' : 'done') };
          }
          if (!incremental) incremental = new IncrementalRenderer(body);
          incremental.update(flatSig, flatStatus, function() { body.innerHTML = flatHtml; });
        }
      } else {
        if (virtualList) { virtualList.dispose(); virtualList = null; }
        if (totalVisible === 0) { html = emptyHtml(loading); }
        var sigParts = ['group'];
        var statusMap = {};
        for (var wsI = 0; wsI < wsItems.length; wsI++) {
          var wsKs = wsKey(wsItems[wsI]);
          sigParts.push(wsKs + ':' + (collapsed[wsKs] ? '1' : '0'));
        }
        sigParts.push('ungrouped:' + (collapsed['__ungrouped__'] ? '1' : '0'));
        var allSess = Object.values(byId);
        for (var as = 0; as < allSess.length; as++) {
          var ss2 = allSess[as];
          if (!isVisible(ss2)) continue;
          sigParts.push(ss2.id);
          statusMap[ss2.id] = { running: isRunning(ss2), blank: isBlank(ss2), state: isRunning(ss2) ? 'run' : (isBlank(ss2) ? 'blank' : 'done') };
        }
        if (!incremental) incremental = new IncrementalRenderer(body);
        incremental.update(sigParts.join('|'), statusMap, function() { body.innerHTML = html; });
      }
    }

    function debugLog() {}

    function showFrame() {
      var f = pickEl(SEL_FRAME);
      if (!f) { debugLog('showFrame: frame not found'); return; }
      f.style.cssText = 'display:flex!important;flex-direction:column!important;height:100dvh!important;overflow:hidden!important';
      var selectors = [SEL_SIDEBAR, SEL_DETAILS, SEL_HANDLE, SEL_OVERLAY];
      selectors.forEach(function(sels) { var e = findIn(f, sels); if (e) e.style.display = 'none'; });
      var c = findIn(f, SEL_CENTER);
      if (c) c.style.cssText = 'flex:1!important;min-width:0!important;overflow:hidden!important;padding-top:calc(44px+env(safe-area-inset-top,0px))!important';
    }
    function hideFrame() { var f = pickEl(SEL_FRAME); if (f) f.style.display = 'none'; }
    function restoreFrame() {
      var f = pickEl(SEL_FRAME);
      if (!f) return;
      f.style.removeProperty('display');
      f.style.removeProperty('flex-direction');
      f.style.removeProperty('height');
      f.style.removeProperty('overflow');
      var selectors = [SEL_SIDEBAR, SEL_DETAILS, SEL_HANDLE, SEL_OVERLAY, SEL_CENTER];
      selectors.forEach(function(sels) {
        var e = findIn(f, sels); if (!e) return;
        e.style.removeProperty('display'); e.style.removeProperty('flex');
        e.style.removeProperty('min-width'); e.style.removeProperty('overflow'); e.style.removeProperty('padding-top');
      });
    }
    function enterSession() {
      sessionStorage.setItem(SESSION_KEY, 'session');
      document.body.classList.add('rm-x-in-session');
      if (dashEl) dashEl.style.display = 'none';
      showFrame();
    }
    function exitToDashboard() {
      cleanup();
      sessionStorage.setItem(SESSION_KEY, 'dashboard');
      document.body.classList.remove('rm-x-in-session');
      hideFrame();
      if (dashEl) dashEl.style.display = '';
      // 如果当前会话是空白的，清除它（匹配侧栏行为：离开空白会话时丢弃）
      try {
        var snap = sessions.list.getSnapshot();
        if (snap.current) {
          var cur = snap.byId && snap.byId[snap.current];
          if (cur && cur.blank) {
            sessions.clear();
          }
        }
      } catch(e) {}
      // Re-subscribe after cleanup for dashboard view
      unsubSessions = trackSub(sessions.list.subscribe(function() { if (isMobile() && !document.body.classList.contains('rm-x-in-session')) scheduleRender(); }));
      unsubWorkspaces = trackSub(workspaces.list.subscribe(function() { if (isMobile() && !document.body.classList.contains('rm-x-in-session')) scheduleRender(); }));
      render();
    }

    function boot() {
      // Poll until data ready, then render
      var pollCount = 0;
      function tryRender() {
        render();
        // 放宽上限：新版 dsh 加载历史 session 更慢，原 15s 上限会把「加载慢」误判成空白。
        // 数据未就绪时 render() 会渲染「加载中」而不是空列表，用户不会看到假空白。
        if (!getDataReady() && pollCount < 120) {
          pollCount++;
          setTimeout(tryRender, pollCount < 20 ? 300 : 500);
        }
      }

      // Always set up resize handler so desktop→mobile transition works
      resizeHandler = function() {
        clearTimeout(window.__rmxRT);
        window.__rmxRT = setTimeout(function() {
          if (isMobile() && !dashEl) {
            buildSkeleton();
            // Re-subscribe after desktop cleanup
            if (!unsubSessions) unsubSessions = trackSub(sessions.list.subscribe(function() { if (isMobile() && !document.body.classList.contains('rm-x-in-session')) scheduleRender(); }));
            if (!unsubWorkspaces) unsubWorkspaces = trackSub(workspaces.list.subscribe(function() { if (isMobile() && !document.body.classList.contains('rm-x-in-session')) scheduleRender(); }));
            tryRender();
          }
          else if (!isMobile() && dashEl) {
            cleanup(); restoreFrame(); dashEl.remove(); if (backEl) backEl.remove(); dashEl = null; backEl = null;
            // 回桌面必须清干净移动端状态：否则 rm-x-in-session 残留，
            // 下次切回移动端会直接落到「会话视图」而非仪表盘（会话为空则整页空白）。
            document.body.classList.remove('rm-x-in-session');
            document.body.classList.remove('rm-x-mobile');
            try { sessionStorage.setItem(SESSION_KEY, 'dashboard'); } catch(e) {}
          }
        }, 150);
      };
      window.addEventListener('resize', resizeHandler);

      // Only build dashboard if already mobile
      if (!isMobile()) return;
      buildSkeleton();

      // Subscribe FIRST so we catch data arriving — use scheduleRender for batching
      unsubSessions = trackSub(sessions.list.subscribe(function() { if (isMobile() && !document.body.classList.contains('rm-x-in-session')) scheduleRender(); }));
      unsubWorkspaces = trackSub(workspaces.list.subscribe(function() { if (isMobile() && !document.body.classList.contains('rm-x-in-session')) scheduleRender(); }));

      tryRender();

      // Restore view state
      var saved = sessionStorage.getItem(SESSION_KEY);
      if (saved === 'session') {
        var snap = sessions.list.getSnapshot();
        if (snap.current) {
          enterSession();
        } else {
          var off = sessions.list.subscribe(function() {
            var s = sessions.list.getSnapshot();
            if (s.current) { off(); enterSession(); }
            else if (s.phase === 'ready' && !s.current) { off(); sessionStorage.setItem(SESSION_KEY, 'dashboard'); }
          });
        }
      }
    }
    boot();
  }

  return {
    apply: function(ctx) {
      ctx.slots.inject('settings.section', function() { return ctx.slots.register({ name: 'settings.section', id: 'dsh-remote-x', order: 120, label: function() { return '远程控制'; } }, RemoteControlSection); });
      try { mobileLayer(ctx, ctx.sessions, ctx.workspaces); } catch(e) {}
    },
    inject: ['slots', 'modules', 'sessions', 'workspaces'],
  };
}

window.__ModuleLoader__ && window.__ModuleLoader__.load({ id: 'dsh-remote-x', factory: factoryBody });
})()
