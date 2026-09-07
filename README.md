# dsh-remote-x — DeepSeek Harness 远程控制与移动端覆盖层

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件，两部分能力：

1. **远程控制中心**（设置页标签）—— 局域网 / 公网两条通路随时接管你的 Harness：扫码即连、
   cloudflared 隧道一键开关、访问二维码直接可扫。
2. **移动端全覆盖界面**（<768px 自动生效）—— 把 DSH 网页端在手机上变成原生 App 观感的
   任务仪表盘 + 会话视图：按工作区分组的任务卡、运行状态实时刷新、顶部返回栏、
   深浅主题与 DSH 全程同步。

> 桌面端（≥768px）零影响：全部覆盖规则在窄屏媒体查询内，宽屏看不到任何移动端部件。

## 功能

### 远程控制（设置页「远程控制」标签）

| 能力 | 说明 |
| --- | --- |
| 扫码接入 | 局域网地址实时渲染为二维码，手机相机直扫 |
| 局域网访问 | 一键开关反向代理（默认端口 `3081`），自动探测本机所有局域网 IP，多 IP 可切换 |
| 公网访问 | cloudflared 隧道一键开关，公网 URL 即时显示，**并渲染公网二维码**——人在外面扫码即用，无需同一局域网 |
| 复制链接 | 局域网 / 公网地址一键复制 |
| 主题 | 全部配色走 DSH 设计令牌（`--dsw-alias-*`），深浅主题自动跟随 |

### 移动端覆盖层

| 能力 | 说明 |
| --- | --- |
| 任务仪表盘 | 按工作区分组的任务卡片（工作区名 / 路径 / 任务数 / 最近活跃），运行中绿点脉冲、「进行中 / 新会话 / 已完成」徽标 |
| 任务操作 | 点击进入会话；长按任务行弹出菜单（打开 / 删除）；分组折叠展开；单列 / 分组视图切换；全部折叠 / 展开；手动刷新 |
| 会话视图 | 顶部**返回栏**（一键返回任务列表，配色随主题）；DSH 会话主体全屏呈现，底部安全区适配 |
| 误触防护 | 屏蔽浏览器边缘滑动历史导航（左右滑不会莫名退回上一页） |
| 实时同步 | 订阅 `sessions` / `workspaces` 服务，任务状态变化自动刷新；浏览器刷新后保持当前视图（sessionStorage） |
| 主题同步 | MutationObserver 监听 DSH 主题属性，深浅切换即时跟随（返回栏 / 仪表盘 / 长按菜单全量） |
| 升级容错 | 会话字段 / DSH 组件类名漂移时按候选顺序回退探测；数据未就绪显示加载态而非假空白——**永不白屏** |

### 已知边界

- 公网访问需要本机安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)。
- iOS Safari **屏幕边缘**的系统返回手势属浏览器行为，页面无法禁用；页面中部滑动无影响。

## 架构

```
dsh-remote-x/
├── src/index.ts        # 宿主插件：mobile CSS 注入(webserver/index-inject) +
│                       #   qr-info / qrcode / lan-toggle / public-toggle API +
│                       #   局域网反向代理(3081) + cloudflared 隧道管理
├── inject/mobile.css   # 移动端纯 CSS 覆盖层（body class 模型，宽屏零影响）
├── dist/client.js      # 客户端模块：设置页 section + 移动层
│                       #   （sessions/workspaces 订阅驱动，手写无构建依赖）
└── dist/index.mjs      # 宿主构建产物（tsdown）
```

- 客户端经 DSH 模块加载器按需加载，服务依赖：`sessions` / `workspaces` / `slots` / `modules`。
- 移动层对 DSH 的所有 DOM 触点都走**后缀锚点**（`[class*="_frame"]` 等，语义后缀全页唯一）
  与**兼容层**（`pick()` 多字段回退），宿主升级时优先降级而非白屏。

## 安装

```sh
dsh plugin --profile web add ./dsh-remote-x
```

安装后重启宿主即可；手机与电脑同一局域网时，用设置页二维码扫码访问。

## 插件配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `breakpoint` | `768` | 移动端布局判定宽度（px） |
| `proxyPort` | `3081` | 局域网反向代理端口 |
| `title` | `远程控制` | 设置页标签标题 |
| `accessKey` | 无 | 公网/局域网链接使用 `/k/<key>/` 形式，免去 token 轮换 |

## 插件 API（全部经 nonce 防护）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-remote-x/api/qr-info` | 入口地址、局域网 IP 列表、LAN/公网开关状态、token 检测 |
| GET | `/dsh-remote-x/api/qrcode?text=` | 自渲染 QR SVG（纯矩阵核心，无图片依赖） |
| POST | `/dsh-remote-x/api/lan-toggle` | 局域网代理开关 |
| POST | `/dsh-remote-x/api/public-toggle` | cloudflared 公网隧道开关（返回公网 URL） |

## 安全说明

- Harness 后端保持默认 `127.0.0.1` 绑定不变；对手机暴露的只有 3081 代理与隧道出口。
- 所有插件 API 要求 `x-remote-nonce`（页面注入的一次性值）；代理入口可选 `accessKey`。
- 公网隧道链接含访问凭据，请勿公开分享；泄露时在设置页关闭公网开关重建。

## License

MIT
