# dsh-remote-x 公网固定域名访问方案

> 基于当前代码状态（v0.2.2）编写，2026-09-15
> 所有建议均基于已阅读的源码，非假设

---

## 一、当前状态总览

### 1.1 已运行的服务

| 服务 | systemd 单元 | 监听 | 说明 |
|------|-------------|------|------|
| DSH Web 后端 | `dsh-desktop-x.service` | `127.0.0.1:3080` | 主 Harness 进程，只绑定 loopback |
| LAN 代理 | `dsh-remote-proxy.service` | `0.0.0.0:3081` | Host/Origin 改写反代，access-key 已配置 |

### 1.2 已具备的能力（代码层面）

| 能力 | 源码位置 | 状态 |
|------|---------|------|
| 反向代理（Host/Origin 改写 + access-key 认证） | `lib/proxy.mjs` | ✅ 已部署运行 |
| Cloudflared 临时隧道（`*.trycloudflare.com`） | `lib/tunnel.mjs:56` | ✅ 代码就绪，未启动 |
| Cloudflared 命名隧道（固定域名） | `lib/tunnel.mjs:53-56` | ✅ 代码就绪，未配置 |
| 隧道 Supervisor（自动重连 + 指数退避） | `lib/tunnel-supervisor.mjs` | ✅ 代码就绪 |
| 健康检查（周期探测 + 失败重连） | `lib/tunnel-supervisor.mjs:105-143` | ✅ 代码就绪 |
| 隧道指标采集（Prometheus） | `lib/tunnel-supervisor.mjs:148-180` | ✅ 代码就绪 |
| 公网开关 API（设置页一键开关） | `src/index.ts:558-601` | ✅ 代码就绪 |
| QR 面板（显示公网状态 + 隧道信息） | `src/index.ts:472-511` | ✅ 代码就绪 |
| Polyfill 注入（crypto.randomUUID 等） | `lib/proxy.mjs:39-45` | ✅ 已生效 |
| cloudflared 二进制 | 系统 PATH | ✅ v2026.8.2 已安装 |

### 1.3 配置字段（`src/index.ts:67-84`）

```typescript
export const Config = z.object({
  // ... 已有字段
  cloudflareToken: z.string(),    // Cloudflare 隧道 token（命名隧道必须）
  publicDomain: z.string(),       // 固定域名
  tunnelRegion: z.string().default('auto'),
  tunnelProtocol: z.string().default('quic'),
  tunnelReconnect: z.boolean().default(true),
  tunnelMetricsPort: z.number().default(0),
  tunnelHealthCheckMs: z.number().default(30_000),
  tunnelMaxReconnect: z.number().default(10),
  // ...
})
```

### 1.4 网络环境实测（2026-09-10 验证）

本机（xiaoxin，192.168.5.8，aarch64 Linux）网络实测结果：

| 目标 | 结果 | 说明 |
|------|------|------|
| `registry.npmjs.org` | ✅ HTTP/2 200 | npm 包管理 |
| `nodejs.org` | ✅ HTTP/2 307 | Node.js 下载 |
| `github.com` | ✅ 20.205.243.166 | GitHub API |
| `ngrok.com` | ✅ HTTP/2 200 | ngrok 服务 |
| `tailscale.com` | ✅ HTTP/2 200 | Tailscale 服务 |
| `www.cloudflare.com` | ✅ HTTP/2 103 | Cloudflare 主站 |
| `1.1.1.1`（Cloudflare DNS） | ❌ curl 超时 | 但 cloudflared 通过 IPv6 QUIC 可连 |
| `region1.v2.argotunnel.com` | ✅ cloudflared 可连 | DNS 解析到 IPv6（2606:4700:a0::4），QUIC 连接成功 |
| `region2.v2.argotunnel.com` | ✅ cloudflared 可连 | DNS 解析到 IPv6（2606:4700:a8::2），QUIC 连接成功 |
| `api.cloudflare.com` | ✅ cloudflared 可连 | Cloudflare API 可达 |

**关键发现**：`curl` 用 HTTPS 协议直连隧道端点会超时（因为隧道端点只接受 QUIC/HTTP2），但 `cloudflared` 自身通过 IPv6 QUIC 协议连接完全正常。cloudflared 内置的连通性预检全部 PASS：

```
DNS Resolution    region1.v2.argotunnel.com  PASS
DNS Resolution    region2.v2.argotunnel.com  PASS
UDP Connectivity  region1.v2.argotunnel.com  PASS  (QUIC connection successful)
UDP Connectivity  region2.v2.argotunnel.com  PASS  (QUIC connection successful)
TCP Connectivity  region1.v2.argotunnel.com  PASS  (HTTP/2 connection successful)
TCP Connectivity  region2.v2.argotunnel.com  PASS  (HTTP/2 connection successful)
Cloudflare API    api.cloudflare.com:443     PASS
```

**临时隧道实测**：`cloudflared tunnel --url http://127.0.0.1:3081` 成功创建 `*.trycloudflare.com` 隧道，代理链路 `公网 → cloudflared → 0.0.0.0:3081 → 127.0.0.1:3080` 通路验证：无认证返回 401（代理层拦截正确）。

**结论：Cloudflare Named Tunnel（固定域名）可以直接使用，无需额外网络配置。**

---

## 二、固定域名方案对比

### 方案 A：Cloudflare Named Tunnel（推荐，需网络前置）

**原理**：cloudflared 以 `--token` 模式运行，连接 Cloudflare 边缘节点，Cloudflare 将固定域名的 HTTPS 流量路由到本地代理。

**前置条件**：
1. 本机能访问 Cloudflare 隧道端点（需要网络环境支持）
2. Cloudflare 账号 + Zero Trust 配置
3. 自有域名（或使用 Cloudflare 分配的子域名）

**优势**：
- 固定域名，HTTPS 自动证书
- 插件代码已完全就绪（`lib/tunnel.mjs:53-56`）
- 设置页一键开关（`src/index.ts:558-601`）
- 自动重连 + 健康检查 + 指标监控

**劣势**：
- 需要网络能连通 Cloudflare
- 需要 Cloudflare 账号配置

### 方案 B：内网穿透工具（frp / ngrok / Tailscale）

**原理**：通过第三方隧道服务建立反向代理，配合 Nginx 反代到本机 3081 端口。

**前置条件**：
1. 一台有公网 IP 的服务器（或第三方服务）
2. 域名 DNS 指向该服务器
3. Nginx/Caddy 配置反代

**优势**：
- 不依赖 Cloudflare 网络
- 灵活选择穿透方案

**劣势**：
- 需要额外基础设施
- 需要自己管理证书
- 不与插件现有 API 集成

### 方案 C：SSH 隧道 + 域名映射（最简方案）

**原理**：通过 SSH 端口转发到公网服务器，Nginx 反代 + 域名。

**优势**：
- 最简单，不需要额外软件
- 适合临时使用

**劣势**：
- 需要公网服务器
- 不稳定，SSH 断线需重连
- 不与插件 API 集成

---

## 三、推荐方案：Cloudflare Named Tunnel（条件满足时）

### 3.1 前置条件检查

```bash
# 检查 1：cloudflared 是否已安装
cloudflared --version

# 检查 2：能否连通 Cloudflare 隧道端点
curl -sI --connect-timeout 5 https://region1.v2.argotunnel.com

# 检查 3：DNS 解析
nslookup region1.v2.argotunnel.com
```

**如果检查 2/3 失败**，需要先解决网络问题：
- 配置 HTTP 代理（`HTTP_PROXY` / `HTTPS_PROXY` 环境变量）
- 或使用 VPN / 代理服务器
- 或选择方案 B/C

### 3.2 Cloudflare 账号配置（一次性操作）

**步骤 1：创建隧道**

1. 登录 [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. 进入 **Networks → Tunnels**
3. 点击 **Create a tunnel**
4. 选择 **Cloudflared** 类型
5. 命名隧道（如 `dsh-remote-x`）
6. 复制隧道 token（形如 `eyJhIjoixxxxxxxxx...`）

**步骤 2：配置公网域名**

1. 在隧道配置中，添加 **Public Hostname**
2. 填写域名（如 `dsh.yourdomain.com`）
3. 选择 **HTTP** 协议
4. 目标地址填 `localhost:3081`（本机代理端口）
5. 保存

**步骤 3：获取隧道 token**

隧道 token 是一串 Base64 编码的配置信息，包含了：
- 隧道 ID
- 账号 ID
- Tunnel Secret

格式：`eyJ...` 开头的长字符串。

### 3.3 部署到 DSH 插件

**方式 A：通过 Cordis 插件配置**

在 `cordis.patch.yml` 或 DSH 配置中添加：

```yaml
plugins:
  dsh-remote-x:
    config:
      cloudflareToken: "eyJhIjoixxxxxxxxx..."  # 从 Zero Trust 复制
      publicDomain: "dsh.yourdomain.com"        # 你的固定域名
      tunnelRegion: "ap"                        # 亚太区域
      tunnelProtocol: "quic"                    # QUIC 协议（更快）
      tunnelReconnect: true                     # 自动重连
      tunnelHealthCheckMs: 30000                # 健康检查间隔
      tunnelMaxReconnect: 10                    # 最大重连次数
```

**方式 B：通过环境变量 + 启动脚本**

```bash
# 环境变量
export CLOUDFLARE_TOKEN="eyJhIjoixxxxxxxxx..."
export PUBLIC_DOMAIN="dsh.yourdomain.com"

# 启动时传入配置
node --import tsx/esm apps/cli/src/bin.ts web --patch patch.yml
```

### 3.4 设置页操作流程

部署后，用户在 DSH 设置页的「远程控制」标签中：

1. **查看状态**：QR 面板显示 `publicEnabled: true`，`publicUrl: "https://dsh.yourdomain.com/k/xxxx/"`
2. **一键开关**：点击「公网访问」开关，调用 `POST /dsh-remote-x/api/public-toggle`
3. **查看二维码**：QR 面板自动显示公网地址的二维码
4. **手机扫码**：手机浏览器扫码即可访问

### 3.5 访问链路

```
手机浏览器
  → https://dsh.yourdomain.com/k/<access-key>/
    → Cloudflare 边缘（HTTPS 终止 + 证书）
      → cloudflared 隧道（QUIC/HTTP2）
        → 本机 0.0.0.0:3081（反向代理）
          → rewrite Host/Origin 为 127.0.0.1:3080
            → DSH Web 后端（127.0.0.1:3080）
              → React SPA + 插件注入的移动端 CSS/JS
```

**安全层级**：
1. **Cloudflare 层**：HTTPS 加密 + DDoS 防护
2. **代理层 access-key**：`lib/proxy.mjs:152-154`，校验 URL 中的 `?key=` 或 `/k/<key>/`
3. **代理层 remember cookie**：`lib/proxy.mjs:253-256`，已登录设备记住 1 年
4. **DSH 层 token**：`lib/proxy.mjs:186-196`，动态读取最新登录口令

### 3.6 隧道生命周期管理

**启动**（`src/index.ts:569-591`）：
1. 检查本机代理是否运行，未运行则自动启动
2. 调用 `startTunnel(proxyPort, { token, domain, ... })`
3. 返回公网 URL + 入口后缀

**重连**（`lib/tunnel-supervisor.mjs:57-74`）：
- 隧道进程退出时自动触发
- 指数退避：1s → 2s → 4s → 8s → 16s → 60s
- 最大重连次数：10 次（可配置）
- 超过最大次数后状态变为 `disconnected`

**健康检查**（`lib/tunnel-supervisor.mjs:125-140`）：
- 周期探测公网 URL（默认 30s）
- 连续 3 次失败触发重连
- 记录延迟指标（供监控）

**停止**（`src/index.ts:593-596`）：
- 调用 `tunnel.stop()` → 停止健康检查 + 指标采集 + kill 子进程
- 清空 `publicTunnel` 状态

---

## 四、替代方案：frp 内网穿透（网络不通 Cloudflare 时）

如果本机无法连通 Cloudflare，使用 frp 作为替代隧道。

### 4.1 架构

```
手机浏览器
  → https://dsh.yourdomain.com
    → Nginx/Caddy（公网服务器，SSL 终止）
      → frps（frp 服务端）
        → frpc 隧道
          → 本机 0.0.0.0:3081（反向代理）
            → DSH Web 后端（127.0.0.1:3080）
```

### 4.2 公网服务器配置（frps）

```ini
# /etc/frp/frps.toml
bindPort = 7000
auth.token = "your-frp-token"
```

### 4.3 本机配置（frpc）

```ini
# ~/.config/frpc.toml
serverAddr = "your-vps-ip"
serverPort = 7000
auth.token = "your-frp-token"

[tunnel]
type = "tcp"
localIP = "127.0.0.1"
localPort = 3081
remotePort = 3081
```

### 4.4 Nginx 配置

```nginx
server {
    listen 443 ssl;
    server_name dsh.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/dsh.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
    }
}
```

### 4.5 systemd 管理 frpc

```ini
# ~/.config/systemd/user/frpc.service
[Unit]
Description=frp client
After=network.target

[Service]
ExecStart=/usr/local/bin/frpc -c ~/.config/frpc.toml
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

---

## 五、不改代码的最小公网方案（SSH 隧道）

如果只是临时需要公网访问，不需要改任何代码：

### 5.1 前提

- 一台有公网 IP 的服务器（VPS）
- 该服务器已配置域名 SSL 证书

### 5.2 操作

```bash
# 1. 在本机建立 SSH 反向隧道
ssh -R 3081:127.0.0.1:3081 user@your-vps-ip -N

# 2. 在 VPS 的 Nginx 中配置反代到 127.0.0.1:3081

# 3. 访问 https://dsh.yourdomain.com/k/<access-key>/
```

### 5.3 优势

- 零代码改动
- 零额外软件安装
- 适合临时使用

### 5.4 劣势

- SSH 断线需重连（可用 `autossh` 自动化）
- 不与插件设置页的公网开关集成
- 无健康检查 / 指标监控

---

## 六、安全加固建议

无论选择哪种方案，公网暴露后必须关注：

### 6.1 必须做

| 措施 | 说明 | 涉及代码 |
|------|------|---------|
| access-key 认证 | 设置页配置固定访问口令 | `lib/proxy.mjs:152-154` |
| HTTPS 强制 | Cloudflare 默认 HTTPS；frp/Nginx 需配置 SSL | Nginx 配置 |
| Cookie Secure 标志 | HTTPS 下 cookie 加 Secure 标记 | `lib/proxy.mjs:256` |
| 速率限制 | 代理层限流防暴力破解 | 待实现 |
| 日志审计 | 记录公网访问日志 | 待实现 |

### 6.2 建议做

| 措施 | 说明 |
|------|------|
| IP 白名单 | Cloudflare Access Policy 限制来源 IP |
| 2FA | Cloudflare Zero Trust 支持 MFA |
| 会话超时 | 设置 cookie 过期时间 |
| 访问日志 | 记录每次公网访问的 IP、时间、UA |

---

## 七、实施路线图

### 阶段 0：网络验证 ✅ 已完成

```
cloudflared tunnel --url http://127.0.0.1:3081 --no-autoupdate
→ 临时隧道创建成功：https://xxx.trycloudflare.com
→ 连通性预检全部 PASS（DNS/QUIC/HTTP2/API）
→ 代理链路验证：无认证返回 401 ✓
```

**结论：网络环境完全支持 Cloudflare Named Tunnel，无需替代方案。**

### 阶段 1：Cloudflare Named Tunnel（推荐，网络已验证可用）

| 步骤 | 操作 | 耗时 |
|------|------|------|
| 1.1 | 注册 Cloudflare 账号 + 添加自有域名 | 30 min |
| 1.2 | 创建 Zero Trust Tunnel（Zero Trust Dashboard → Networks → Tunnels） | 10 min |
| 1.3 | 配置 Public Hostname → `localhost:3081`（本机代理端口） | 5 min |
| 1.4 | 复制隧道 token 到 DSH 插件配置（`cloudflareToken` + `publicDomain`） | 2 min |
| 1.5 | 重启 DSH 后端使配置生效 | 1 min |
| 1.6 | 设置页开启公网访问，验证手机扫码 | 5 min |

**总计约 53 分钟。**

### 阶段 2：frp 内网穿透（网络不通 Cloudflare 时）

| 步骤 | 操作 | 耗时 |
|------|------|------|
| 2.1 | VPS 安装 frps + 配置域名 SSL | 30 min |
| 2.2 | 本机安装 frpc + 配置隧道 | 10 min |
| 2.3 | Nginx 反代配置 | 10 min |
| 2.4 | systemd 管理 frpc | 5 min |
| 2.5 | 验证手机访问 | 5 min |

### 阶段 3：与插件 API 集成（可选增强）

如果使用 frp 方案，可以扩展插件的公网开关 API：

```typescript
// src/index.ts:558-601 扩展
// 当前：只支持 cloudflared 隧道
// 增加：支持 frpc 进程管理
if (body.enabled) {
  // 启动 frpc 替代 cloudflared
  execFileSync('systemctl', ['--user', 'start', 'frpc.service'])
}
```

---

## 八、当前阻塞项

| 阻塞项 | 说明 | 解决方式 | 耗时 |
|--------|------|---------|------|
| ~~网络不通 Cloudflare~~ | ~~`region1.v2.argotunnel.com` 无法连接~~ | ✅ 已验证可用（IPv6 QUIC） | — |
| 无 Cloudflare 账号 | 需要注册 + 域名 | 手动操作 | 30 min |
| 无隧道 token | `cloudflareToken` 未配置 | Cloudflare Zero Trust 控制台获取 | 5 min |
| `publicDomain` 未配置 | 插件配置缺少固定域名 | 在 cordis.patch.yml 中设置 | 2 min |

---

## 九、文件变更清单（如需代码改动）

### 无需改动的文件（代码已就绪）

- `lib/proxy.mjs` — 反向代理核心，已支持公网入口
- `lib/tunnel.mjs` — 隧道封装，已支持命名隧道
- `lib/tunnel-supervisor.mjs` — 隧道生命周期管理
- `lib/agent.mjs` — 上游连接池
- `lib/compress.mjs` — 压缩 + Polyfill 注入
- `lib/constants.mjs` — 常量定义
- `bin/dsh-remote-x.mjs` — CLI 入口（`--public` 模式）
- `client/` — 客户端页面（通过代理转发 DSH 原生 SPA）

### 可能需要改动的文件

| 文件 | 改动 | 原因 |
|------|------|------|
| `src/index.ts` | 扩展 `public-toggle` 支持 frpc | 替代方案需要 |
| `deploy/deploy-remote.sh` | 添加 frpc 安装步骤 | 替代方案部署 |
| systemd 服务文件 | 添加 frpc 服务 | 替代方案管理 |

---

## 十、总结

**网络环境已验证可用。** `cloudflared` 通过 IPv6 QUIC 协议连接 Cloudflare 隧道端点完全正常，临时隧道 `*.trycloudflare.com` 创建成功，代理链路验证通过。

**代码层面，公网固定域名访问的所有能力已经实现。** `lib/tunnel.mjs` 完整支持 Cloudflare Named Tunnel（固定域名），`src/index.ts` 提供设置页一键开关，`lib/tunnel-supervisor.mjs` 提供自动重连和健康检查。

**下一步：** 在 [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) 创建 Named Tunnel，获取隧道 token，配置到 DSH 插件即可。无需 frp 或 SSH 等替代方案。
