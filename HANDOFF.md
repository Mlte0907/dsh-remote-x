# HANDOFF — dsh-remote-x 实机部署与实测（xiaoxin 可续任务）

> 本文档写给在 **xiaoxin（192.168.5.8，aarch64，Linux，Node 26）** 上新开的执行会话。
> 上一个会话（Windows 工作区）已完成插件开发与浏览器模拟验证，交付物已放在
> `~/dsh-remote-x/`。你的任务：**把插件挂载到本机已装的 DeepSeek Harness 上启动，
> 跑完 API 级实机实测，输出报告并把带 token 的地址交给用户。**

## 0. TL;DR（三步）

```bash
bash -n ~/dsh-remote-x/deploy/deploy-remote.sh   # 语法自检（可选）
bash ~/dsh-remote-x/deploy/deploy-remote.sh      # 部署 + 启动（秒级，非首次安装）
bash ~/dsh-remote-x/deploy/verify.sh             # API 级实机实测（自动 PASS/FAIL 报告）
```

脚本会自动打印带 token 的访问地址（形如 `http://192.168.5.8:3099/remote/?token=XXXX`），
把它原样转告用户做手机/浏览器可视化验证。

## 1. 本机环境实况（2026-09-03 已探测确认）

| 项 | 状态 |
|---|---|
| Harness 源码（含 node_modules + tsx） | `~/deepseek-harness`（monorepo，可直接源码运行） |
| 常驻服务 | 用户级 systemd `dsh-web.service`：构建版 `apps/cli/lib/bin.js web`，监听 `127.0.0.1:3080` 与 `0.0.0.0:3081`，`DSH_HOME=~/.dsh` |
| 接管守卫 | 该服务 ExecStartPre 会杀掉匹配 `apps/cli/lib/bin[.]js web` 的进程（独占 3080） |
| node | `~/.hermes/node/bin/node`（v26.8.1），PATH 里也是它 |
| pnpm | 未安装（**预装模式下不需要**——脚本直接用 `node --import tsx/esm` 启动） |
| 外网 | registry.npmjs.org ✓ / nodejs.org ✓ / **github.com 不可达**（预装模式不需要） |

部署脚本对以上全部自动适配：发现 `~/deepseek-harness` 就走"源码 tsx 模式"；
端口 3080 被占自动改 **3099**；启动命令带 `apps/cli/src/bin.ts`，不匹配接管守卫的
pgrep 模式，**不会被系统服务误杀**，也不影响 3080 上的常驻服务。

## 2. 已完成 / 待完成

已完成（勿重做）：
- ✅ 插件全量代码与打包元数据（`src/index.ts` + `client/` + `package.json` + `cordis.patch.yml`）
- ✅ 部署套件：`deploy/deploy-remote.sh`（自动模式识别/端口避让/token/补丁生成/启动）、
  `deploy/echo-adapter.ts`（无 DEEPSEEK_API_KEY 时的回声模型，provider `echo`）、
  `deploy/verify.sh`（自动读 token 与端口）
- ✅ API 签名逐一对照过 Harness 源码；UI 已在 mock 后端上完成浏览器验证

待你完成：
- ⬜ 真实 Harness 上启动插件实例（上面三步）
- ⬜ `verify.sh` 十项实测全部 PASS
- ⬜ 实测报告 + 带 token 的地址交给用户

## 3. 部署细节（脚本自动完成）

1. 定位 Harness：`~/deepseek-harness`（存在 `packages/` 即认可）→ 源码 tsx 模式；
2. 同步插件到 `~/dsh-remote/dsh-remote-x/`；
3. 生成 `~/dsh-remote/remote.patch.yml`：
   - 按 id 覆盖 `webserver` 行 → `host 0.0.0.0` / `port 3099` / gzip；
   - 挂载插件（自动生成随机 token，页面与 API 全部要求口令）；
   - 未设 `DEEPSEEK_API_KEY` 时追加 Echo 适配器；
4. 启动：`cd ~/deepseek-harness && nohup <node> --import tsx/esm apps/cli/src/bin.ts web
   --patch ~/dsh-remote/remote.patch.yml --no-open > ~/dsh-remote/harness.log 2>&1 &`

排障：`tail -50 ~/dsh-remote/harness.log`；重跑前
`kill $(cat ~/dsh-remote/harness.pid) 2>/dev/null`（脚本也会自动清理旧测试实例）。

## 4. API 级实测清单（verify.sh 自动执行）

| # | 检查 | 预期 |
|---|------|------|
| 1 | `GET /remote/`（带 token） | 200，含「DeepSeek 远程控制」 |
| 2 | `GET /remote/api/tasks`（无 token） | 401 |
| 3 | `GET /remote/api/bootstrap` | 200，providers 含 `echo` |
| 4 | `GET /remote/api/tasks` | 200 |
| 5 | `POST /remote/api/tasks`（显式 echo 模型） | 200，返回 `session-…` |
| 6 | `POST .../messages` | 200，`accepted:true` |
| 7 | SSE `GET /remote/api/events` | snapshot + turn/start + user/message + assistant/chunk(text-delta) + assistant/message + turn/end，回显内容可见 |
| 8 | `POST .../rename` | 200 |
| 9 | `POST .../cancel` | 200 |
| 10 | 复查列表 | 标题已更新为「实机测试任务」 |

数据全部来自**真实 Harness 进程**：`ctx.agents.create()` 建会话、`agent.followup()` 进真实
agent-loop、事件来自 `session/event`；Echo 适配器只替代 LLM 层。

## 5. 可视化测试（转告用户）

浏览器打开带 token 的地址：仪表盘 → 新建任务 → 模型下拉**必须选
「Echo（测试适配器）/ Echo 回声模型」**（无 API Key 时选 DeepSeek 会报模型不可用）→
发消息看实时流 → 停止/重命名/命令面板/明暗主题。
Windows 侧的原开发会话与 xiaoxin 同局域网，也可直接访问该地址做截图验证。

## 6. 常见问题

- **换真实模型**：`export DEEPSEEK_API_KEY=sk-...` 后重跑部署脚本（Echo 行不再加入）
- **手机访问不了**：`curl -I http://127.0.0.1:3099/remote/` 在主机上先确认；防火墙放行 3099
- **想停掉测试实例**：`kill $(cat ~/dsh-remote/harness.pid)`（**不要**动 `dsh-web.service`）
- **3080 上的常驻服务与本实例**：互不影响；若重启 dsh-web.service，其守卫不会杀本实例

## 7. 汇报格式

完成后输出：① 十项实测 PASS/FAIL 与关键响应摘录；② 带 token 的完整访问地址；
③ `harness.log` 中 dsh-remote-x 的加载日志行；④ 遗留问题清单。
