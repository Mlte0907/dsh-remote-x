# dsh-remote-x — DeepSeek Harness 的移动端远程控制插件

把 [dsh 远程控制端](https://dsh.z.ai)（DSH 桌面端的移动远程控制页面）**一比一复刻**为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件：在 Harness 自带的
Web 服务器上挂载一个手机 / 平板优先的远程控制页面，随时随地查看和驱动你的 Harness 任务。

## 功能对照（与 DSH 移动端远程控制）

| DSH 功能 | 本插件实现 |
| --- | --- |
| 设备上的工作区 / 任务仪表盘（手机布局） | ✅ 按工作目录分组的任务卡片，运行状态圆点与「运行中」徽标 |
| 任务会话实时视图（思考 / 工具 / 流式回复） | ✅ 订阅 `session/event`：思考行（可展开）、终端 / 读取 / 搜索等工具行（正在执行 → 已完成）、逐字输出 |
| 「工作中 X 分 Y 秒」计时 | ✅ 由 `turn/start` / `turn/end` 驱动 |
| 首页聊天输入卡（项目 / 模式 / 模型 / 优先级 / 发送） | ✅ 项目选择器、模型目录（`ctx.llm`）、推理强度映射 `reasoningEffort` |
| 发送模式 | ✅ 「变更前确认」= 排队（`agent.followup`）；「立即打断」= 插入当前执行（`agent.steer`） |
| 继续输入以排队后续修改 + 停止生成 | ✅ 排队 / 打断发送 + `agent.cancel`（保留队列） |
| 任务「⋯」菜单 | ✅ 重命名（优先走 Harness `sessionTitle` 服务持久化，无服务时本地生效）+ 复制标题 |
| 新建任务（Ctrl+N）、搜索（Ctrl+K 命令面板） | ✅ 命令面板：新建 / 刷新 / 切换主题 / 打开任务 / 停止任务 |
| 插件市场、归档、筛选排序、添加上下文 | 🚧 占位入口（Harness 侧对应能力尚在演进，按钮给出提示） |
| 明暗主题 | ✅ 跟随 DSH 配色的双主题，选择持久化 |
| 任务命名 | ✅ 取第一条用户消息（与 DSH 行为一致），冷会话优先读取标题投影 |

> 介绍 DSH 的桌面大屏布局同样还原：≥768px 显示侧边栏（新建任务 / 搜索 / 插件市场 / 项目分组任务列表 /
> 底部账号区）+ 居中问候语与输入卡 + 快捷指令（周报总结 / 报错修复 / PPT 制作）。

## 目录结构

```
dsh-remote-x/
├── package.json          # dsh bundle 描述（dsh.bundle.patch）
├── cordis.patch.yml      # cordis.yml 覆盖层（insert 本插件）
├── src/index.ts          # 宿主插件：webServer 路由 + 会话驱动 + SSE
├── client/               # 纯静态前端（无构建步骤）
│   ├── index.html
│   ├── styles.css        # 取自 DSH 实测的设计令牌（见文末）
│   └── app.js            # 数据层双驱动：ApiDriver(fetch+SSE) / MockDriver(演示)
├── mock/preview.mjs      # 无 Harness 时的独立预览服务器（可选）
└── README.md
```

## 快速开始

### A. 接入真实 Harness（推荐）

Harness 以源码方式运行插件（`node --import tsx/esm`），因此无需构建：

```sh
# 1. 编辑 cordis.patch.yml，把 name 改为 src/index.ts 的绝对路径
#    例如：name: 'C:/Users/sun_w/.dsh/workspace/default/dsh-remote-x/src/index.ts'

# 2. 启动 Web UI 并挂载插件
pnpm dsh web --patch /绝对路径/dsh-remote-x/cordis.patch.yml

# 3. 手机 / 平板 / 电脑浏览器打开
#    http://127.0.0.1:3080/remote
```

安装为 npm bundle 亦可：`dsh plugin --profile <name> add ./dsh-remote-x`，
然后把覆盖层里的 `name` 改为包名 `dsh-remote-x`。

### B. 仅预览界面（无需 Harness）

```sh
node mock/preview.mjs        # http://127.0.0.1:4173/remote
# 或直接用浏览器打开 client/index.html?mock=1（演示模式自动启用）
```

连接不到宿主 API 时页面会自动降级为演示模式（MockDriver），完整模拟
任务列表、创建任务、SSE 流式回复与停止生成。

## 插件配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `route` | `/remote` | 挂载路径（页面与 API 都在其下） |
| `title` | `DeepSeek 远程控制` | 页面标题 |
| `token` | 无 | 可选访问口令；设置后所有请求需带 `?token=` 或 `x-remote-token` 头 |

```yaml
- insert:
    - id: dsh-remote-x
      name: '/绝对路径/dsh-remote-x/src/index.ts'
      config:
        route: /remote
        token: my-secret
```

## 宿主 API（插件自身提供）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/remote/api/bootstrap` | 标题、默认 cwd、模型目录（providers × models）、默认模型 |
| GET | `/remote/api/tasks` | 任务列表（live + 持久化，按 cwd 分组、含运行状态与最近活跃时间） |
| POST | `/remote/api/tasks` | 新建任务（`cwd` / `provider` / `model` / `reasoningEffort`） |
| GET | `/remote/api/tasks/:id` | 任务详情（事件投影为 user / assistant / tool 记录） |
| POST | `/remote/api/tasks/:id/messages` | 发送消息（`mode: 'queue' \| 'steer'`） |
| POST | `/remote/api/tasks/:id/cancel` | 停止当前回合（保留收件箱） |
| POST | `/remote/api/tasks/:id/rename` | 重命名任务（`{ title }`） |
| GET | `/remote/api/events?sessionId=` | SSE：`snapshot`（历史投影）+ `session-event`（实时事件） |

## 实现要点（对齐 Harness 源码）

- 插件形如 Harness 官方教程：`export const name / inject / apply(ctx, config)`，
  `inject = ['webServer', 'agents', 'llm']`；路由通过
  `ctx.effect(() => ctx.webServer.register(route), 'dsh-remote-x: page route')` 注册，随插件卸载自动清理。
- 会话创建 / 发送 / 停止与 `packages/api/session-controller` 的 commands 同款：
  `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })`、
  `createUserMessage({ content, source })` + `agent.followup / steer`、
  `agent.cancel({ kind: 'user' }, { keepInbox: true })`。
- 实时流来自 `ctx.on('session/event', …)`（逐连接订阅、断开即释放）；SSE 不经过 gzip 管道。
- 模型目录来自 `ctx.llm.listProviders() / listModels()`；默认模型尝试 `ctx.agentDefaultModel`。
- 任务列表合并 `ctx.sessions.list()` 与可选的 `ctx.sessionQuery.listSessions()`（含持久化会话）。

## 安全说明

- Harness 的 Web 服务器默认只绑定 `127.0.0.1`（`--host 0.0.0.0` 被官方刻意拒绝）。
  想在手机上访问，请使用 SSH 隧道 / 反向代理，并**务必**配置 `token`。
- 审批（变更前确认）决策仍由 Harness 自身的 approval 管道处理；远程页面会把
  `approval/asked` 事件显示为时间线提示。

## 设计令牌（实测自 dsh 远程控制端 v4）

背景 `rgb(22,22,22)` · 前景 `oklch(0.87 0 0)`（次级 60% / 30%）· 卡片 `rgb(43,43,43)` /
`rgb(32,32,32)` · 边框 `rgba(255,255,255,.1)` · 强调蓝 `oklch(.865 .127 207)` ·
绿 `rgb(70,191,114)` · 橙 `rgb(255,138,48)` · 危险 `rgb(255,92,92)` ·
圆角 8px / 胶囊 999px · Inter 字体 · 基准字号 14px · 头部高度 48px。

## 已知边界

- 模型 / 推理强度在**创建任务时**生效；Harness 暂未提供进程内的会话级换模型 API。
- 图片 / 文件上下文、归档等待 Harness 能力开放后接入。
- 冷（未附加）会话可查看历史，但发送 / 重命名需要任务处于运行中的 Harness 实例
  （无 `sessionTitle` 服务时重命名仅在本插件内生效）。
