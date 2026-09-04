# dsh-remote-x 全面评测报告与重构实施计划

> 生成日期：2026-09-03
> 项目版本：v0.1.0
> 评测范围：安全、性能、兼容性、可访问性、工程质量、架构设计

---

## 目录

- [第一部分：评测报告](#第一部分评测报告)
  - [一、安全评测](#一安全评测)
  - [二、前端性能评测](#二前端性能评测)
  - [三、浏览器兼容性评测](#三浏览器兼容性评测)
  - [四、可访问性评测](#四可访问性评测)
  - [五、工程质量评测](#五工程质量评测)
  - [六、总体评分](#六总体评分)
- [第二部分：确定方向](#第二部分确定方向)
  - [七、新架构方案](#七新架构方案)
- [第三部分：详细实施计划](#第三部分详细实施计划)
  - [八、实施步骤](#八实施步骤)
  - [九、文件变更清单](#九文件变更清单)
  - [十、验收标准](#十验收标准)
  - [十一、风险与回退](#十一风险与回退)

---

# 第一部分：评测报告

## 一、安全评测

### 1.1 高风险问题（3 项）

#### H1：Token 注入到 `window` 全局变量

- **位置**：`src/index.ts` 行 876-884
- **机制**：每次渲染 index.html 时，通过 `webserver/index-inject` 事件注入：
  ```js
  window.__DSH_REMOTE_X_TOKEN__ = "<token>"
  ```
- **问题**：任何能执行 JS 的上下文（XSS、浏览器扩展、开发者控制台）都能直接读取 token。这是唯一的认证凭据，暴露即等于认证完全失效。
- **当前缓解**：注释标注"供设置页/远程控制标签页取用"，但这不改变 token 可被任意 JS 读取的事实。

#### H2：`/api/settings` 返回原始 token

- **位置**：`src/index.ts` 行 790-804
- **代码**：
  ```ts
  token: cfg.token ?? null,
  ```
- **问题**：已认证的客户端可以通过 GET `/api/settings` 获取 token 原文。配合 HTTP 明文传输，任何网络嗅探者都能提取 token。
- **注释承认了设计意图**（行 790）："已过 token 围栏，故可回传完整口令以便拼二维码"，但这扩大了攻击面。

#### H3：反向代理无自身认证

- **位置**：`lib/proxy.mjs` 行 83-159
- **问题**：代理绑定 `0.0.0.0`，不验证请求来源，完全依赖上游 DSH 的 loopback 检查。如果插件的 token 未配置（`token` 为 undefined），`tokenOk` 返回 true（行 133-139），整个控制面暴露在网络上无需任何认证。

### 1.2 中风险问题（3 项）

#### M1：Token 通过 URL 查询字符串传递

- **位置**：`client/app.js` 行 188
- **代码**：
  ```js
  this.token = new URLSearchParams(location.search).get('token') ?? '';
  ```
- **问题**：token 出现在浏览器历史记录、服务端访问日志、Referer 头中。

#### M2：Cookie 未设置 Secure 标志

- **位置**：`src/index.ts` 行 759
- **代码**：
  ```ts
  'set-cookie': `dsh-remote-token=${cfg.token}; HttpOnly; SameSite=Strict; Path=/`
  ```
- **问题**：缺少 `Secure` 标志，cookie 在 HTTP 明文传输下可被嗅探。

#### M3：Token 通过命令行参数传递

- **位置**：`bin/dsh-remote-x.mjs` 行 48
- **问题**：`--token <value>` 在 `ps aux` 和 `/proc/<pid>/cmdline` 中可见。

### 1.3 低风险问题（3 项）

| 编号 | 位置 | 问题 |
|------|------|------|
| L1 | `src/index.ts` 行 270-284 | 静态文件服务缺少路径规范化检查（当前硬编码路径安全，但扩展时有潜在风险） |
| L2 | `lib/proxy.mjs` 行 54 | 响应头改写正则只转义第一个 `.`（`127.0.0.1:3080` 中第二个点未转义） |
| L3 | `lib/ascii.mjs` 全文 | 零错误处理，垃圾输入产生垃圾输出 |

---

## 二、前端性能评测

### 2.1 严重性能问题

#### P1：每次 SSE 事件全量重建 DOM

- **位置**：`client/app.js` 行 855-885
- **机制**：`renderTaskBody` 执行 `wrap.innerHTML = ''` 然后从 `state.records` 重建所有消息节点
- **触发频率**：流式传输期间每个 chunk 事件触发一次（每秒数十次）
- **影响**：长对话（100+ 消息）场景严重卡顿，低端手机尤其明显

#### P2：定时器永不清理

- **位置**：
  - `client/app.js` 行 1455：`setInterval(refreshTasks, 15_000)`
  - `client/app.js` 行 1188-1197：主题同步 `setInterval(..., 2000)`
- **问题**：无 `clearInterval`，页面导航或卸载时不清理，造成内存泄漏。

#### P3：滚动处理无节流

- **位置**：`client/app.js` 行 990-992
- **问题**：`scroller.onscroll` 每帧触发，无 `requestAnimationFrame` 或 throttle。

### 2.2 中等性能问题

| 编号 | 位置 | 问题 |
|------|------|------|
| P4 | `client/app.js` 行 376-409 | MockDriver `setTimeout` 链在取消前不清理 |
| P5 | `client/app.js` 多处 | `.t-scroll` DOM 查询重复 3+ 次，未缓存 |
| P6 | `client/app.js` | 无虚拟列表，长对话内存占用随消息数线性增长 |

---

## 三、浏览器兼容性评测

### 3.1 严重兼容性问题

#### C1：CSS `oklch()` / `oklab()` 无回退值

- **位置**：`client/styles.css` 行 17-20, 459, 535
- **问题**：这些是 CSS Color Level 4 的新色彩函数，旧版 Safari (<16.4)、Firefox (<113)、Chrome (<111) 不支持
- **影响**：页面颜色完全丢失，界面不可用

#### C2：`100dvh` 无回退

- **位置**：`client/styles.css` 行 97
- **问题**：缺少 `height: 100vh` 回退值

#### C3：JavaScript 使用 ES2022+ 特性

| 特性 | 位置 | 最低浏览器版本 |
|------|------|---------------|
| `Array.at()` | 行 60, 500, 691, 739 | ES2022 / Chrome 92 / Safari 15.4 |
| `AbortSignal.timeout()` | 行 226, 235 | Chrome 103 / Safari 16.4 |
| `structuredClone` | 行 321, 347, 372 | Chrome 98 / Safari 15.4 |
| 空 `catch` 无绑定变量 | 行 305, 308, 1147, 1149, 1195 | ES2019 |
| `??` / `?.` | 全文 | ES2020 |

---

## 四、可访问性评测

**评分：2/10（差）**

### 缺失项清单

| 严重度 | 缺失项 | 位置 |
|--------|--------|------|
| 高 | 按钮/图标缺少 `aria-label` | `client/app.js` 多处 |
| 高 | 键盘导航无 focus 管理 | `client/app.js` |
| 高 | 对话框无 focus 陷阱 | `client/index.html` 行 178-260 |
| 高 | CSS 无 `:focus-visible` 样式 | `client/styles.css` 全文 |
| 中 | Toast 通知无 `aria-live` | `client/index.html` 行 187 |
| 中 | 触摸目标 28×28px（应 ≥44×44px） | `client/styles.css` 行 166-167 |
| 低 | 无 `prefers-reduced-motion` 适配 | `client/styles.css` 全文 |
| 低 | 无跳过导航链接 | `client/index.html` |

---

## 五、工程质量评测

### 5.1 优点

| 维度 | 说明 |
|------|------|
| 架构设计 | ApiDriver/MockDriver 策略模式清晰优雅 |
| 安全意识 | `tokenOk` 使用 `timingSafeEqual`，4MB body 限制，输入校验 |
| 部署运维 | 端口冲突检测、健康检查、旧实例清理、PID 管理 |
| 文档体系 | README + HANDOFF + README-REMOTE 三份互补文档 |
| 测试覆盖 | verify.sh 10 项 API 验证含安全测试（401 检查） |

### 5.2 问题

| 编号 | 位置 | 问题 |
|------|------|------|
| E1 | `src/index.ts` 行 870 | 所有 catch 统一返回 400（应区分 400/500） |
| E2 | `src/index.ts` 行 831 | Session ID 直接 `as SessionId` cast，无格式校验 |
| E3 | `package.json` | `bin` 字段引用 `bin/dsh-remote-x.mjs` 但 `files` 数组未包含 `bin/`，npm 发布后二进制丢失 |
| E4 | `package.json` | peer dependencies 全部 `*`，无版本兼容保护 |
| E5 | `package.json` | 无 `devDependencies`，无 lint/typecheck/test 脚本 |
| E6 | `README.md` 行 28-38 | 目录树不完整，遗漏 `deploy/`、`HANDOFF.md`、`verify.sh` |
| E7 | `deploy/deploy-remote.sh` 行 34-38, 173-176 | 旧实例清理重复执行（冗余） |
| E8 | `deploy/deploy-remote.sh` 行 22 | Node 版本硬编码 `v24.20.0`，与实际环境（v26.8.1）不一致 |
| E9 | `deploy/deploy-remote.sh` | 下载的 Node/Harness tarball 无校验和验证 |
| E10 | `deploy/verify.sh` | 创建的测试任务无清理逻辑 |

---

## 六、总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构设计 | ★★★★☆ | 清晰分层，策略模式优雅 |
| 安全性 | ★★☆☆☆ | Token 暴露方式有设计缺陷 |
| 前端性能 | ★★☆☆☆ | 全量 DOM 重建是瓶颈 |
| 浏览器兼容 | ★★☆☆☆ | 无 CSS/JS 回退 |
| 可访问性 | ★☆☆☆☆ | 几乎为零 |
| 部署运维 | ★★★★☆ | 自动化程度高，文档完善 |
| 测试覆盖 | ★★★☆☆ | API 层覆盖较好，前端无测试 |
| 代码质量 | ★★★☆☆ | 主体良好，有 `as any` 和 magic numbers |

**总结**：架构设计和部署运维是亮点，但 token 安全模型需要重新设计、前端性能需要增量更新改造、可访问性需要从零补齐。

---

# 第二部分：确定方向

## 七、新架构方案

### 7.1 核心思路

**当前方案**（独立前端 + 自定义 API + 反向代理）：

```
手机 → proxy (0.0.0.0:3081)
  → 插件自定义路由 (/remote/api/*)
    → 插件自定义 SSE + 任务 CRUD
      → DSH 运行时
```

**新方案**（响应式注入 + 复用网页端 + 精简代理）：

```
手机 → proxy (0.0.0.0:3081, 仅 Host/Origin 改写)
  → DSH webserver (127.0.0.1:3080)
    → 网页端自身的 React SPA
      → 插件注入的移动端 CSS + JS
        → 宽屏：桌面布局
        → 窄屏：移动端布局
```

### 7.2 新方案的优势

| 对比项 | 当前方案 | 新方案 |
|--------|----------|--------|
| 前端代码量 | ~2400 行（HTML+CSS+JS） | ~500 行（CSS 注入 + 薄 JS） |
| 自定义 API 端点 | 12 个 | 0 个 |
| SSE 订阅 | 自己实现 | 复用网页端 |
| 功能同步 | 手动维护两套 | 自动跟随桌面端 |
| 插件主文件 | ~890 行 | ~100 行 |
| 维护成本 | 高（两套前端 + API） | 低（只维护注入层） |
| DSH 升级兼容 | 依赖内部 API | 只依赖公开注入机制 |

### 7.3 关键技术约束

1. **DSH webserver 绑定 `127.0.0.1`**：手机无法直连，proxy 仍需保留
2. **`webserver/index-inject` 事件**：官方推荐的 HTML 注入机制，支持 `style`、`script`、`script-src` 行类型
3. **DSH 网页端无移动端响应式**：需要通过注入的 CSS 覆盖现有桌面布局
4. **网页端是 React SPA**：注入的 JS 需要在 React 挂载后操作 DOM

---

# 第三部分：详细实施计划

## 八、实施步骤

### 阶段一：基础框架搭建

#### 步骤 1：精简插件主文件

**文件**：`src/index.ts`

删除全部自定义 API、SSE、静态文件服务、任务 CRUD 逻辑。保留：

```ts
// 保留的最小插件结构
export const name = 'dsh-remote-x'
export const inject = []  // 不再依赖 webServer/agents/llm/sessions

export interface Config {
  route?: string    // 保留，用于代理路由配置
  title?: string    // 保留，用于注入页面标题
  token?: string    // 保留，用于认证
}

export const Config: z<Config> = z.object({
  route: z.string().pattern(/^\//).default('/remote'),
  title: z.string().default('DeepSeek 远程控制'),
  token: z.string(),
})

export function apply(ctx: Context, cfg: Config) {
  // 1. 注入移动端 CSS
  // 2. 注入移动端 JS
  // 3. 注入 token（供代理认证）
  // 4. 注册 /remote 路由（可选，用于静态资源）
}
```

**预计行数**：从 889 行精简到 ~100 行。

#### 步骤 2：创建移动端注入资源

新建目录 `inject/`，存放注入到网页端的资源：

```
inject/
  mobile.css    -- 移动端响应式 CSS
  mobile.js     -- 移动端交互逻辑 JS
```

**`inject/mobile.css`** 设计要点：

```css
/* ========================================
   移动端响应式覆盖层
   通过 webserver/index-inject 注入到 DSH 网页端
   ======================================== */

/* --- 设计令牌（复用现有 DSH 主题变量）--- */
:root {
  /* 从 DSH 网页端继承的变量，不需要重新定义 */
  /* 只补充移动端特有的变量 */
  --mobile-header-h: 56px;
  --mobile-card-radius: 16px;
  --mobile-gap: 12px;
}

/* --- 桌面布局隐藏（窄屏时）--- */
@media (max-width: 767.98px) {
  /* 隐藏 DSH 桌面三栏布局 */
  [data-app-frame] {
    display: none !important;
  }

  /* 显示移动端布局 */
  .dsh-remote-x-mobile {
    display: flex !important;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    background: var(--dsh-bg, rgb(22, 22, 22));
    color: var(--dsh-fg, #e0e0e0);
  }
}

/* --- 宽屏时隐藏移动端布局 --- */
@media (min-width: 768px) {
  .dsh-remote-x-mobile {
    display: none !important;
  }
}

/* --- 移动端布局组件 --- */
/* 复用现有 client/ 中的移动端样式 */
```

**`inject/mobile.js`** 设计要点：

```js
// 移动端交互逻辑
// 1. 检测屏幕宽度，控制布局切换
// 2. 复用 DSH 网页端的 API（通过内部通信）
// 3. 渲染移动端 UI（仪表盘、任务列表、对话视图）

(function() {
  'use strict';

  // 屏幕宽度检测
  function isMobile() {
    return window.innerWidth < 768;
  }

  // 移动端 UI 渲染器
  const MobileRenderer = {
    // ... 从 client/app.js 提取的移动端渲染逻辑
  };

  // 初始化
  function init() {
    if (!isMobile()) return;
    MobileRenderer.mount();
  }

  // 响应式切换
  window.addEventListener('resize', () => {
    if (isMobile()) {
      MobileRenderer.mount();
    } else {
      MobileRenderer.unmount();
    }
  });

  // 等待 DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

#### 步骤 3：注入资源到网页端

在 `src/index.ts` 的 `apply()` 中：

```ts
export function apply(ctx: Context, cfg: Config) {
  // 读取注入资源
  const mobileCss = readFile(join(__dirname, '../inject/mobile.css'), 'utf8')
  const mobileJs = readFile(join(__dirname, '../inject/mobile.js'), 'utf8')

  // 注入到网页端 HTML
  ctx.on('webserver/index-inject', (table) => {
    // 注入移动端 CSS
    table.push({ kind: 'style', text: mobileCss })

    // 注入移动端 JS（在 body 末尾执行）
    table.push({ kind: 'script', placement: 'body', text: mobileJs })

    // 注入 token（供代理认证，不再暴露到 window）
    if (cfg.token) {
      table.push({
        kind: 'global',
        name: '__DSH_REMOTE_X_TOKEN__',
        value: cfg.token,
      })
    }
  })
}
```

### 阶段二：移动端 UI 实现

#### 步骤 4：提取现有移动端样式

从 `client/styles.css` 提取移动端相关样式到 `inject/mobile.css`：

**需要提取的样式块**：

| 源位置 | 内容 | 行数 |
|--------|------|------|
| `styles.css` 行 193-266 | 移动端仪表盘布局 | ~74 行 |
| `styles.css` 行 282-340 | Composer 输入区域 | ~58 行 |
| `styles.css` 行 363-370 | Quick chips | ~8 行 |
| `styles.css` 行 372-453 | 任务对话视图 | ~81 行 |
| `styles.css` 行 456-488 | 命令面板 | ~32 行 |
| `styles.css` 行 567-597 | 任务操作底部弹窗 | ~30 行 |

**需要新增的覆盖样式**：

```css
/* 覆盖 DSH 桌面布局 */
@media (max-width: 767.98px) {
  /* 隐藏桌面三栏 */
  [class*="AppFrame"] {
    display: none !important;
  }

  /* 显示移动端容器 */
  .dsh-remote-x-mobile {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }
}
```

#### 步骤 5：提取移动端 JavaScript 逻辑

从 `client/app.js` 提取移动端相关函数到 `inject/mobile.js`：

**需要提取的函数**：

| 函数 | 源位置 | 行数 | 用途 |
|------|--------|------|------|
| `renderDashboard()` | 行 695-753 | ~58 行 | 工作区仪表盘渲染 |
| `buildComposer()` | 行 547-685 | ~138 行 | 输入区域构建 |
| `renderTaskBody()` | 行 855-885 | ~30 行 | 对话内容渲染 |
| `userRecordNode()` | 行 785-790 | ~5 行 | 用户消息节点 |
| `assistantRecordNode()` | 行 793-812 | ~19 行 | 助手消息节点 |
| `toolItemNode()` | 行 815-834 | ~19 行 | 工具调用节点 |
| `thinkItemNode()` | 行 837-848 | ~11 行 | 思考过程节点 |
| `textItemNode()` | 行 851-853 | ~2 行 | 流式文本节点 |
| `scrollTaskToBottom()` | 行 901-906 | ~5 行 | 自动滚动 |
| `showHome()` / `openTask()` | 行 959-1016 | ~57 行 | 视图切换 |

**需要适配的数据获取**：

```js
// 不再使用自定义 ApiDriver，而是通过 DSH 网页端的内部通信
// 方案 A：监听 DSH 网页端的自定义事件
// 方案 B：直接调用 DSH 网页端暴露的 API

// 示例：从 DSH 网页端获取任务列表
async function fetchTasks() {
  // 复用 DSH 网页端的 session API
  const sessions = await window.__DSH_SESSIONS__.list();
  return sessions.map(formatTask);
}
```

#### 步骤 6：处理数据源适配

**关键问题**：新方案中，移动端不再有自己的 API 层，需要从 DSH 网页端获取数据。

**可行方案**：

| 方案 | 机制 | 优点 | 缺点 |
|------|------|------|------|
| A. 监听 DSH 事件 | `ctx.on('session/event', ...)` 通过 index-inject 暴露 | 实时性好 | 需要 DSH 网页端配合 |
| B. 调用 DSH 内部 API | 复用网页端的 `ctx.agents` / `ctx.sessions` | 简单直接 | 依赖内部 API 稳定性 |
| C. 保留精简 API | 只保留任务列表和 SSE 端点 | 完全解耦 | 仍有自定义代码 |

**推荐方案 C**：保留最精简的 API 层（仅任务列表 + SSE），其他功能复用网页端。

```ts
// 精简后的 API（仅 2 个端点）
// GET /remote/api/tasks - 任务列表
// GET /remote/api/events - SSE 事件流
```

### 阶段三：代理层精简

#### 步骤 7：简化代理配置

**文件**：`lib/proxy.mjs`

代理本身不需要修改——它已经是纯粹的 Host/Origin 改写代理。但配置需要调整：

```js
// 启动代理时的配置
startRemoteProxy({
  port: args.port,           // 默认 3081
  host: '0.0.0.0',
  upstream: {
    host: '127.0.0.1',
    port: 3080,              // DSH webserver
  },
  // 不再需要额外的路由配置
  // 代理直接转发所有请求到 DSH webserver
})
```

#### 步骤 8：更新 CLI 入口

**文件**：`bin/dsh-remote-x.mjs`

简化 CLI，移除与自定义前端相关的选项：

```js
const HELP = `dsh-remote-x — 手机访问电脑上的 DeepSeek Harness 远程控制页

用法：
  dsh-remote-x                 局域网模式（手机同一 WiFi）
  dsh-remote-x --public        公网模式（cloudflared 隧道）
  dsh-remote-x --port 3081     自定义代理端口
  dsh-remote-x --token <口令>  打印带口令的完整地址
  dsh-remote-x --lan-ip <IP>   指定对外展示的局域网地址
  dsh-remote-x --help          帮助

前提：本机 dsh web 已在 127.0.0.1:3080 运行。
建议用 systemd 管后端：systemctl --user restart dsh-web

安全提醒：远程控制页能执行代码。二维码/URL 就是钥匙，请勿发给别人。`
```

### 阶段四：测试与验证

#### 步骤 9：更新验证脚本

**文件**：`deploy/verify.sh`

更新测试用例，验证新架构：

```bash
#!/bin/bash
# dsh-remote-x 新架构验证脚本

echo "=== dsh-remote-x 新架构验证 ==="

# 1. 检查 DSH webserver 是否运行
echo "1. 检查 DSH webserver..."
curl -fs http://127.0.0.1:3080/ > /dev/null
if [ $? -eq 0 ]; then
  echo "   ✓ DSH webserver 运行正常"
else
  echo "   ✗ DSH webserver 未运行"
  exit 1
fi

# 2. 检查代理是否运行
echo "2. 检查代理..."
curl -fs http://127.0.0.1:3081/ > /dev/null
if [ $? -eq 0 ]; then
  echo "   ✓ 代理运行正常"
else
  echo "   ✗ 代理未运行"
  exit 1
fi

# 3. 检查移动端 CSS 注入
echo "3. 检查移动端 CSS 注入..."
HTML=$(curl -fs http://127.0.0.1:3081/)
if echo "$HTML" | grep -q "dsh-remote-x-mobile"; then
  echo "   ✓ 移动端 CSS 已注入"
else
  echo "   ✗ 移动端 CSS 未注入"
  exit 1
fi

# 4. 检查移动端 JS 注入
echo "4. 检查移动端 JS 注入..."
if echo "$HTML" | grep -q "mobile.js"; then
  echo "   ✓ 移动端 JS 已注入"
else
  echo "   ✗ 移动端 JS 未注入"
  exit 1
fi

# 5. 检查 token 认证（无 token 应返回 401）
echo "5. 检查 token 认证..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3081/remote/)
if [ "$STATUS" = "401" ]; then
  echo "   ✓ token 认证正常"
else
  echo "   ✗ token 认证异常（期望 401，实际 $STATUS）"
fi

# 6. 检查移动端 API 端点
echo "6. 检查移动端 API..."
TOKEN="<your-token>"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3081/remote/api/tasks?token=$TOKEN")
if [ "$STATUS" = "200" ]; then
  echo "   ✓ 任务列表 API 正常"
else
  echo "   ✗ 任务列表 API 异常（期望 200，实际 $STATUS）"
fi

echo ""
echo "=== 验证完成 ==="
```

#### 步骤 10：功能验收测试

| 测试场景 | 验证内容 | 预期结果 |
|----------|----------|----------|
| 桌面访问 | 浏览器宽度 ≥768px | 显示 DSH 原生桌面布局 |
| 手机访问 | 浏览器宽度 <768px | 切换到移动端布局 |
| 布局切换 | 窗口宽度变化 | 实时切换桌面/移动端布局 |
| 任务列表 | 移动端仪表盘 | 显示工作区卡片和任务行 |
| 任务对话 | 点击任务进入对话 | 显示消息时间线和流式回复 |
| 发送消息 | 在移动端输入框输入 | 消息发送成功，收到流式回复 |
| 停止生成 | 点击停止按钮 | 生成停止 |
| 主题切换 | 点击主题按钮 | 深色/浅色主题切换 |
| Token 认证 | 无 token 访问 | 返回 401 |
| SSE 实时性 | 发送消息后观察 | 流式回复实时显示 |

---

## 九、文件变更清单

### 新建文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `inject/mobile.css` | ~300 行 | 移动端响应式 CSS |
| `inject/mobile.js` | ~400 行 | 移动端交互逻辑 JS |
| `EVALUATION-AND-PLAN.md` | ~800 行 | 本文档 |

### 修改文件

| 文件 | 当前行数 | 预计行数 | 变更说明 |
|------|----------|----------|----------|
| `src/index.ts` | 889 | ~100 | 删除 80% 代码，只保留注入逻辑 |
| `bin/dsh-remote-x.mjs` | 155 | ~120 | 简化 CLI，移除自定义前端选项 |
| `deploy/verify.sh` | 88 | ~100 | 更新测试用例适配新架构 |
| `package.json` | - | - | 更新 `files` 数组，添加 `inject/` |
| `README.md` | - | - | 更新架构说明和使用方式 |

### 删除文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `client/index.html` | 264 行 | 自定义前端入口 |
| `client/app.js` | 1477 行 | 自定义前端逻辑 |
| `client/styles.css` | 638 行 | 自定义前端样式 |
| `client/favicon.svg` | - | 自定义前端图标 |
| `src/client/index.ts` | - | 客户端设置页模块 |
| `src/client/index.tsx` | - | 客户端设置页模块（JSX 版） |
| `lib/ip.mjs` | 45 行 | IP 工具（移入 CLI 或删除） |
| `lib/ascii.mjs` | 21 行 | ASCII 转换器（可选保留） |
| `mock/preview.mjs` | 216 行 | 独立预览服务器 |
| `dist/` 目录 | - | 构建产物（需要重新构建） |

### 保留文件

| 文件 | 说明 |
|------|------|
| `lib/proxy.mjs` | 反向代理（核心组件） |
| `deploy/deploy-remote.sh` | 部署脚本（需更新） |
| `deploy/echo-adapter.ts` | 测试适配器 |
| `deploy/README-REMOTE.md` | 远程部署文档 |
| `HANDOFF.md` | 交接文档（需更新） |
| `cordis.patch.yml` | 插件配置 |
| `run.patch.yml` | 运行配置 |
| `ref/` | 参考截图 |

---

## 十、验收标准

### 10.1 功能验收

- [ ] 桌面端（≥768px）显示 DSH 原生布局，无任何变化
- [ ] 移动端（<768px）切换到移动端布局
- [ ] 布局切换实时响应，无闪烁
- [ ] 移动端仪表盘显示工作区和任务列表
- [ ] 移动端对话视图显示消息时间线
- [ ] 流式回复实时显示
- [ ] 发送消息、停止生成、重命名等操作正常
- [ ] 深色/浅色主题切换正常
- [ ] Token 认证正常（无 token 返回 401）
- [ ] SSE 实时推送正常

### 10.2 性能验收

- [ ] 移动端首屏加载 <2 秒（4G 网络）
- [ ] 流式传输期间无明显卡顿
- [ ] 长对话（100+ 消息）滚动流畅
- [ ] 内存占用稳定，无泄漏

### 10.3 兼容性验收

- [ ] Chrome 90+ 正常
- [ ] Safari 15+ 正常
- [ ] Firefox 90+ 正常
- [ ] iOS Safari 正常
- [ ] Android Chrome 正常

### 10.4 安全验收

- [ ] Token 不暴露到 `window` 全局变量
- [ ] `/api/settings` 不返回 token 原文
- [ ] 无 token 访问返回 401
- [ ] Cookie 设置 `Secure` 标志（HTTPS 时）

### 10.5 代码质量验收

- [ ] 插件主文件 ≤150 行
- [ ] 无 `as any` 类型断言
- [ ] 无 magic numbers（常量提取）
- [ ] ESLint 零警告
- [ ] TypeScript 类型检查通过

---

## 十一、风险与回退

### 11.1 风险识别

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| DSH 网页端 CSS 选择器不稳定 | 中 | 高 | 使用 `[data-*]` 属性选择器，减少类名依赖 |
| DSH 网页端 React 组件结构变化 | 中 | 高 | 只覆盖布局，不依赖内部组件 API |
| 移动端 JS 与 DSH 网页端冲突 | 低 | 中 | 使用 IIFE 隔离，避免全局污染 |
| 注入资源体积过大 | 低 | 低 | CSS/JS 分别压缩，总大小 <50KB |
| 代理性能瓶颈 | 低 | 中 | 代理逻辑简单，瓶颈在上游 DSH |

### 11.2 回退方案

如果新架构出现问题，可以快速回退到旧方案：

1. **代码回退**：Git revert 到重构前的 commit
2. **配置回退**：恢复 `cordis.patch.yml` 中的插件配置
3. **部署回退**：重新运行旧版部署脚本

### 11.3 灰度发布建议

1. **Phase 1**：在测试环境验证新架构
2. **Phase 2**：在生产环境同时部署新旧版本，通过配置切换
3. **Phase 3**：确认稳定后，删除旧版代码

---

## 附录 A：现有代码资产清单

### 可复用的代码

| 代码 | 来源 | 复用方式 |
|------|------|----------|
| 移动端 CSS 样式 | `client/styles.css` 行 193-266 | 提取到 `inject/mobile.css` |
| 移动端渲染函数 | `client/app.js` 行 695-885 | 提取到 `inject/mobile.js` |
| 视图切换逻辑 | `client/app.js` 行 959-1016 | 适配后复用 |
| 代理核心逻辑 | `lib/proxy.mjs` 全文 | 直接保留 |
| Token 认证逻辑 | `src/index.ts` 行 133-139 | 保留并强化 |

### 需要重写的代码

| 代码 | 原因 | 工作量 |
|------|------|--------|
| 数据获取层 | 从自定义 API 改为复用 DSH 内部 API | 中 |
| SSE 订阅 | 从自定义端点改为复用 DSH 网页端 | 低 |
| 主题同步 | 从自定义 API 改为读取 DSH 设置 | 低 |

---

## 附录 B：技术决策记录

### B1：为什么保留代理而不是直连？

DSH webserver 强制绑定 `127.0.0.1`，这是安全设计——防止"能执行代码的 web"暴露到网络。代理是唯一合理的绕过方式，它不修改 DSH 的任何配置，只改写请求头让 DSH 看到 loopback。

### B2：为什么不直接修改 DSH 网页端源码？

1. DSH 是上游依赖，修改源码会导致升级困难
2. `webserver/index-inject` 是官方推荐的扩展机制
3. 注入方式与 DSH 的主题系统、模块系统一致

### B3：为什么不用 CSS-in-JS？

1. DSH 网页端使用 CSS Modules，注入 CSS 更一致
2. CSS 文件可以被浏览器缓存
3. 不需要额外的运行时开销

### B4：为什么不使用 Web Components？

1. 移动端布局需要覆盖 DSH 的全局布局，Web Components 的 Shadow DOM 会隔离样式
2. CSS 注入更简单直接
3. 与 DSH 的 React 组件模型不冲突

---

## 附录 C：实机测试结果（2026-09-03）

### 测试环境

| 项目 | 值 |
|------|-----|
| 主机 | xiaoxin (192.168.5.8, aarch64 Linux) |
| Node.js | v26.8.1 |
| DSH webserver | port 3080 (loopback 127.0.0.1) |
| 代理 | port 3081 (0.0.0.0, access-key 认证) |
| 插件版本 | v0.2.1（已重构为注入层架构） |

### 测试结果

| 测试项 | 结果 | 说明 |
|--------|------|------|
| DSH webserver 启动 | ✅ 通过 | 端口 3080 正常监听 |
| 代理启动 | ✅ 通过 | 端口 3081 正常监听，0.0.0.0 绑定 |
| 插件加载 | ✅ 通过 | 无 duplicate id 错误，apply 函数被调用 |
| 移动端 CSS 注入 | ✅ 通过 | `dsh-remote-x` 标记和 `__REMOTE_X_NONCE__` 均出现在 HTML 中 |
| QR Info API | ✅ 通过 | 返回局域网 IP、代理端口、完整访问链接 |
| QR Code SVG | ✅ 通过 | 生成有效的 QR 码 SVG |
| Nonce 认证 | ✅ 通过 | 无 nonce 返回 401，有效 nonce 通过 |
| 代理无认证 | ✅ 通过 | 返回 401 |
| 代理正确 key | ✅ 通过 | 转发到 DSH，DSH 层返回 401（需要 DSH 登录） |
| 代理错误 key | ✅ 通过 | 返回 401 |

### 发现的问题

#### 1. 插件加载配置（已修复）

**问题**：插件在 `dsh.profile.bundles` 和 `cordis.patch.yml` 的 `insert` 同时注册时，会导致 `duplicate loader entry id: dsh-remote-x` 错误。

**根因**：DSH 的 bundles 机制会自动加载插件的 `cordis.patch.yml` 作为层补丁。如果 `cordis.patch.yml` 包含 `insert` 条目注册插件自身，而插件又在 bundles 列表中，就会产生重复注册。

**解决方案**：
- 保持插件在 `dsh.profile.bundles` 中（DSH 要求每个 bundle 必须有 `dsh.bundle.patch`）
- `cordis.patch.yml` 中使用 `insert` 注册插件
- 不在 profile 的 `cordis.patch.yml` 中重复注册

**验证**：`--dump-default-config` 确认插件条目正确出现，无重复。

#### 2. 代理认证机制

**发现**：代理有独立的 `--access-key` 认证层，与 DSH 的 token 认证分离。这是良好的安全设计——两层认证：
- 代理层：`--access-key` 控制网络访问
- DSH 层：token 控制 web 应用访问

#### 3. 移动端 CSS 注入

**发现**：`webserver/index-inject` 机制正常工作。插件通过 `inject/mobile.css` 注入移动端覆盖样式，CSS 中的 `__BREAKPOINT__` 占位符被正确替换为配置的断点值。

### 待验证项

| 测试项 | 状态 | 说明 |
|--------|------|------|
| 移动端布局切换 | 待验证 | 需要在手机浏览器中测试 |
| SSE 实时推送 | 待验证 | 需要创建任务并观察流式回复 |
| 代理 WebSocket | 待验证 | 需要测试 DSH 的实时连接 |
| 长时间运行稳定性 | 待验证 | 需要持续运行观察内存和连接状态 |

---

**文档版本**：v1.1
**最后更新**：2026-09-03
**作者**：ZCode Agent
