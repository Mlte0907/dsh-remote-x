# dsh-remote-x 插件全面评测报告与优化迭代方案

> 评测日期：2026-09-03
> 插件版本：v0.2.0 → v0.2.2
> 评测方法：源码全量审计 + 已有评测文档交叉验证

---

## 一、总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构设计 | ★★★★☆ (4/5) | 清晰分层，CSS 注入 + 独立远程页双模式设计优雅 |
| 安全性 | ★★☆☆☆ (2/5) | Token 暴露链多处，认证边界有设计缺陷 |
| 前端性能 | ★★☆☆☆ (2/5) | 全量 DOM 重建、无虚拟列表、定时器泄漏 |
| 浏览器兼容 | ★★☆☆☆ (2/5) | 无 CSS/JS 回退，依赖 ES2022+ 特性 |
| 可访问性 | ★☆☆☆☆ (1/5) | 几乎为零，无 ARIA、无 focus 管理 |
| 部署运维 | ★★★★☆ (4/5) | CLI + systemd + cloudflared 自动化完善 |
| 测试覆盖 | ★★★☆☆ (3/5) | API 层 verify.sh 10 项覆盖好，前端无测试 |
| 代码质量 | ★★★☆☆ (3/5) | 主体良好，有 `as any`、magic numbers、调试日志残留 |

**综合评分：2.6/5** — 架构有前瞻性，但安全和前端质量是短板。

---

## 二、安全评测（H/M/L 分级）

### 高风险（H）

#### H1：Token 注入 `window.__DSH_REMOTE_X_TOKEN__`
- **位置**：`src/index.ts` 行 876-884
- **攻击路径**：任何能执行 JS 的上下文（XSS、浏览器扩展、DevTools）→ 读取 window 全局 → 获取完整 token
- **当前缓解**：注释标注"供设置页取用"，但不改变暴露事实
- **修复建议**：改用 `sessionStorage` + 同源 fetch 头传递，不在 window 上挂全局变量
- **工作量**：S（小）

#### H2：`/api/settings` 返回原始 token
- **位置**：`src/index.ts` 行 790-804
- **攻击路径**：已认证客户端 → GET `/api/settings` → 获取 token 原文 → HTTP 明文嗅探
- **修复建议**：该接口只返回 `tokenDetected: boolean`，不返回 token 原文；QR 码改用 accessKey 或一次性 nonce URL
- **工作量**：S

#### H3：反向代理无自身认证
- **位置**：`lib/proxy.mjs` 行 83-159
- **攻击路径**：proxy 绑定 `0.0.0.0` → token 未配置时 `tokenOk` 返回 true → 整个控制面暴露
- **修复建议**：proxy 无 accessKey 时强制要求 `?token=` 或 `?key=`，拒绝无认证请求；或至少 log 警告
- **工作量**：S

### 中风险（M）

#### M1：Token 通过 URL query string 传递
- **位置**：`client/app.js` 行 188
- **风险**：浏览器历史记录、Referer 头、服务端日志泄露
- **修复建议**：优先用 path 形式 `/t/<token>/`（已有）；query string 仅作 fallback

#### M2：Cookie 缺少 Secure 标志
- **位置**：`src/index.ts` 行 759
- **修复建议**：检测 HTTPS 环境时追加 `Secure` 标志

#### M3：`lan-toggle` 端点缺少 nonce 校验
- **位置**：`src/index.ts` 行 511-524
- **问题**：`/lan-toggle` POST 没有 nonce 校验（`/public-toggle` 有），同源内任何 JS 可调用
- **修复建议**：加上 `nonceValid` 检查

#### M4：诊断数据泄露
- **位置**：`src/index.ts` 行 471-494（`/tasks` 返回 `_diag`）
- **问题**：生产环境返回内部结构诊断数据（header keys、persistFirst 等）
- **修复建议**：仅在 debug 模式或开发环境下返回

### 低风险（L）

| 编号 | 位置 | 问题 | 修复建议 |
|------|------|------|----------|
| L1 | `src/index.ts` 行 270-284 | 静态文件服务缺少路径规范化 | 硬编码路径安全，但扩展时需加固 |
| L2 | `lib/proxy.mjs` 行 54 | 正则只转义第一个 `.` | 改用 `replaceAll` 或 `RegExp.escape` |
| L3 | `lib/ascii.mjs` | 零错误处理 | 加 try-catch |
| L4 | `bin/dsh-remote-x.mjs` | Token 通过 CLI 参数传递，`ps aux` 可见 | 改用环境变量或 stdin 读取 |

---

## 三、前端性能评测

### 严重（P）

#### P1：SSE 事件全量 DOM 重建
- **位置**：`dist/client.js` 行 244-397（`render()` 函数）
- **机制**：每次 render 调用 `body.innerHTML = html`，从 snapshot 全量重建
- **触发频率**：SSE 事件到达时（流式传输每秒数十次）
- **影响**：100+ 消息对话严重卡顿，低端手机掉帧
- **修复建议**：
  1. 增量更新：diff 比较新旧 snapshot，只更新变化的节点
  2. 虚拟列表：只渲染可视区域 ± 5 条消息
  3. `requestAnimationFrame` 节流
- **工作量**：L（大，需重构渲染层）

#### P2：定时器永不清理
- **位置**：
  - `dist/client.js` 行 443-444：`sessions.list.subscribe` / `workspaces.list.subscribe`
  - `dist/client.js` 行 472-478：`window.addEventListener('resize', ...)`
- **问题**：组件销毁时无 `unsubscribe` / `removeEventListener`，内存泄漏
- **修复建议**：在 `exitToDashboard` 或 `unmount` 时清理所有订阅和事件监听

#### P3：滚动处理无节流
- **位置**：`dist/client.js` 未直接出现（但 CSS 注入层的 `-webkit-overflow-scrolling: touch` 暗示高频滚动）
- **修复建议**：`scroll` 事件加 `passive: true` + `requestAnimationFrame`

### 中等（M）

| 编号 | 问题 | 修复建议 |
|------|------|----------|
| P4 | `mobile.css` 429 行全量注入到每个页面请求 | 窄屏时才注入（用 `@media` 包裹外部无法判断，但可按屏幕宽度延迟注入 JS） |
| P5 | QR 码每次渲染重新生成 SVG | 缓存 SVG 结果，URL 不变时不重新请求 |
| P6 | `MutationObserver` 监听主题变化无 `disconnect` | 组件销毁时断开 observer |
| P7 | `innerHTML` 赋值触发全量 HTML 解析 | 改用 `DocumentFragment` 或 `createElement` |

---

## 四、浏览器兼容性评测

### 严重（C）

#### C1：CSS `oklch()` 无回退值
- **位置**：`inject/mobile.css` 使用 `oklch()` 色彩空间
- **影响**：Safari < 16.4、Firefox < 113、Chrome < 111 颜色完全丢失
- **修复建议**：提供 `rgb()` / `hex` 回退值

#### C2：`100dvh` 无 `100vh` 回退
- **位置**：`inject/mobile.css` 多处
- **修复建议**：`height: 100vh; height: 100dvh;` 双写

#### C3：JS 依赖 ES2022+ 特性
| 特性 | 最低版本 | 影响 |
|------|----------|------|
| `Array.at()` | Chrome 92 / Safari 15.4 | 老设备不可用 |
| `AbortSignal.timeout()` | Chrome 103 / Safari 16.4 | 超时控制失效 |
| `structuredClone` | Chrome 98 / Safari 15.4 | 深拷贝失败 |
| 空 `catch` 无绑定 | ES2019 | 语法错误 |

- **修复建议**：polyfill 或改用兼容写法；proxy 已注入 `crypto.randomUUID` polyfill，可扩展

---

## 五、可访问性评测

**当前评分：1/10**

### 缺失清单

| 严重度 | 缺失项 | 修复建议 |
|--------|--------|----------|
| 高 | 按钮/图标缺少 `aria-label` | 所有交互元素加 `aria-label` |
| 高 | 键盘导航无 focus 管理 | 添加 `tabindex`、`:focus-visible` 样式 |
| 高 | 无 `role` 属性 | Toggle 加 `role="switch"`（已加）、按钮加 `role="button"` |
| 中 | 触摸目标 < 44×44px | 最小尺寸提升到 44px |
| 中 | 无 `aria-live` 区域 | 状态变更区域加 `aria-live="polite"` |
| 低 | 无 `prefers-reduced-motion` 适配 | 添加减少动画媒体查询 |

---

## 六、工程质量评测

### 优点
| 维度 | 说明 |
|------|------|
| 架构分层 | CSS 注入层 + 独立远程页 + 反向代理，三层解耦清晰 |
| 安全意识 | nonce 门控、constant-time token 比较、4MB body 限制 |
| 部署自动化 | CLI + systemd + cloudflared + 随机 token 生成 |
| 文档 | README + HANDOFF + EVALUATION 三份互补 |
| 测试 | verify.sh 10 项 API 验证含安全测试 |

### 问题

| 编号 | 位置 | 问题 | 修复建议 |
|------|------|------|----------|
| E1 | `src/index.ts` 行 484 | 诊断数据 `_diag` 泄露到生产 | 条件编译或 debug 开关 |
| E2 | `src/index.ts` 行 247-251 | `ctx.agents.get()` 返回值无空检查 | 加 `?.` 可选链 |
| E3 | `package.json` | `files` 未包含 `bin/`、`lib/`、`inject/` | 补全 |
| E4 | `package.json` | peer deps 全部 `*` | 限定版本范围 |
| E5 | `package.json` | 无 `devDependencies`、无 lint/test 脚本 | 添加 ESLint + Vitest |
| E6 | `deploy/deploy-remote.sh` | Node 版本硬编码 | 动态检测 |
| E7 | `deploy/verify.sh` | 测试任务无清理 | 末尾加 `curl -X DELETE` |
| E8 | `dist/client.js` 行 32 | `rgbadebugLog` 拼写错误 | 应为 `rgba` |
| E9 | `dist/client.js` 行 399 | `debugLog` 函数体为空 | 移除或接 console |
| E10 | 多处 | `as any` 类型断言 | 逐步收紧类型 |

---

## 七、优化与迭代方案

### 阶段一：安全修复（1-2 周，优先级 P0）

| 序号 | 任务 | 涉及文件 | 工作量 | 验收标准 |
|------|------|----------|--------|----------|
| 1.1 | Token 不再注入 window 全局 | `src/index.ts` | S | window 上无 `__DSH_REMOTE_X_TOKEN__` |
| 1.2 | `/api/settings` 不返回 token 原文 | `src/index.ts` | S | 响应仅含 `tokenDetected: boolean` |
| 1.3 | proxy 无 accessKey 时拒绝无认证请求 | `lib/proxy.mjs` | S | 无 key/token 的请求返回 401 |
| 1.4 | `/lan-toggle` 加 nonce 校验 | `src/index.ts` | XS | 无 nonce 返回 401 |
| 1.5 | 移除 `_diag` 诊断数据 | `src/index.ts` | XS | 生产环境无 `_diag` 字段 |
| 1.6 | Cookie 加 Secure 标志（HTTPS 环境） | `src/index.ts` | XS | HTTPS 下 cookie 含 Secure |

### 阶段二：性能优化（2-4 周，优先级 P1）

| 序号 | 任务 | 涉及文件 | 工作量 | 验收标准 |
|------|------|----------|--------|----------|
| 2.1 | render() 增量更新替代 innerHTML 全量重建 | `dist/client.js` | L | 100 条消息对话无卡顿 |
| 2.2 | 添加虚拟列表（可视区域 ± 10 条） | `dist/client.js` | L | 1000 条消息内存 < 50MB |
| 2.3 | 定时器/事件监听器生命周期管理 | `dist/client.js` | M | 组件销毁后无泄漏 |
| 2.4 | scroll 事件节流 | `dist/client.js` | S | 滚动流畅无掉帧 |
| 2.5 | QR 码 SVG 缓存 | `src/index.ts` | S | 相同 URL 不重复生成 |
| 2.6 | MutationObserver 生命周期管理 | `dist/client.js` | S | 组件销毁时 disconnect |

### 阶段三：兼容性与可访问性（2-4 周，优先级 P2）

| 序号 | 任务 | 涉及文件 | 工作量 | 验收标准 |
|------|------|----------|--------|----------|
| 3.1 | CSS 色彩函数提供回退值 | `inject/mobile.css` | M | Safari 15 可用 |
| 3.2 | `100dvh` 双写 `100vh` | `inject/mobile.css` | XS | 老设备不破版 |
| 3.3 | JS ES2022+ 特性 polyfill | `dist/client.js` | M | Chrome 90+ 可用 |
| 3.4 | ARIA 属性补齐 | `dist/client.js` | M | axe-core 零高危 |
| 3.5 | `:focus-visible` 样式 | `inject/mobile.css` | S | 键盘导航可见 |
| 3.6 | 触摸目标 ≥ 44px | `inject/mobile.css` | S | 所有按钮 ≥ 44×44 |

### 阶段四：工程化提升（持续，优先级 P3）

| 序号 | 任务 | 涉及文件 | 工作量 | 验收标准 |
|------|------|----------|--------|----------|
| 4.1 | 补全 `package.json` files 字段 | `package.json` | XS | npm pack 包含所有必要文件 |
| 4.2 | peer deps 版本范围 | `package.json` | XS | `^5.0.0` 而非 `*` |
| 4.3 | 添加 ESLint + 类型检查 | 新增配置 | M | 零 lint 错误 |
| 4.4 | 前端单元测试 | `__tests__/` | L | 核心渲染逻辑 80% 覆盖 |
| 4.5 | 移除 `as any` 类型断言 | `src/index.ts` | M | TypeScript strict 通过 |
| 4.6 | 修复 `rgbadebugLog` 拼写错误 | `dist/client.js` | XS | 正确渲染 rgba 颜色 |
| 4.7 | deploy-remote.sh Node 版本动态检测 | `deploy/deploy-remote.sh` | S | 自动检测当前版本 |
| 4.8 | verify.sh 测试清理 | `deploy/verify.sh` | S | 测试后无残留会话 |

### 阶段五：功能迭代（1-2 月，优先级 P3）

| 序号 | 功能 | 说明 | 工作量 |
|------|------|------|--------|
| 5.1 | 文件/图片上下文 | 手机端支持上传图片作为对话上下文 | L |
| 5.2 | 审批交互 | 远程端支持变更前确认的 approve/reject | M |
| 5.3 | 任务归档 | 从远程端归档已完成任务 | S |
| 5.4 | 多语言 | 国际化支持（中/英） | M |
| 5.5 | PWA 支持 | 添加 manifest + service worker，支持"添加到主屏幕" | M |
| 5.6 | 推送通知 | 任务完成时通过 Web Push 通知手机 | L |

---

## 八、优先级矩阵

```
影响 ↑
  高 │ H1-H3 安全修复    P1 性能优化     5.1 文件上下文
     │ 1.1-1.6           2.1-2.6        5.2 审批交互
  中 │ M3-M4 补充安全    C1-C3 兼容性    5.5 PWA
     │ 1.4-1.5           3.1-3.6        5.4 多语言
  低 │ L1-L4 低风险      4.1-4.8 工程化  5.3 归档
     │                   A1-A6 可访问性   5.6 推送通知
     └──────────────────────────────────────────→ 工作量
        S (1-2天)          M (1-2周)        L (3-4周)
```

---

## 九、文件变更清单

| 文件 | 变更类型 | 涉及阶段 |
|------|----------|----------|
| `src/index.ts` | 修改 | 1.1-1.5, 2.5 |
| `lib/proxy.mjs` | 修改 | 1.3 |
| `dist/client.js` | 重构 | 2.1-2.4, 2.6, 3.3, 3.4, 4.6 |
| `inject/mobile.css` | 修改 | 3.1, 3.2, 3.5, 3.6 |
| `package.json` | 修改 | 4.1, 4.2 |
| `deploy/deploy-remote.sh` | 修改 | 4.7 |
| `deploy/verify.sh` | 修改 | 4.8 |
| 新增 `__tests__/` | 新建 | 4.4 |
| 新增 `.eslintrc` | 新建 | 4.3 |

---

## 十、风险与回退

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 增量渲染引入渲染 bug | 中 | 高 | 保留 innerHTML 作为 fallback，渐进切换 |
| CSS 回退值导致视觉差异 | 低 | 中 | 用 BrowserStack 测试 |
| 安全修复破坏现有认证流程 | 低 | 高 | verify.sh 10 项全绿才合并 |
| peer deps 版本变更导致安装失败 | 低 | 中 | semver 范围测试 |

---

## 十一、与现有评测文档的差异

本报告基于 v0.2.2 代码审计，与 `EVALUATION-AND-PLAN.md`（v0.1.0）对比：

| 差异项 | 本报告发现 | 说明 |
|--------|-----------|------|
| H1-H3 安全问题 | 仍然存在 | v0.2.0 未修复 |
| M3 lan-toggle 缺 nonce | 新发现 | 原文档未覆盖 |
| M4 诊断数据泄露 | 新发现 | `_diag` 字段在 v0.2.2 新增 |
| P1 全量 DOM 重建 | 仍然存在 | 架构未变 |
| E8 rgbadebugLog | 新发现 | 拼写错误影响颜色渲染 |
| 阶段五功能迭代 | 新增 | 原文档止步于架构重构 |

---

> **下一步**：按阶段一（安全修复）→ 阶段二（性能优化）的顺序执行，每个阶段完成后运行 `deploy/verify.sh` 验证。
