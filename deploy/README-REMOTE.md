# 远程主机部署指南（实机实测）

本目录包含把 `dsh-remote-x` 插件部署到 **远程 Linux 主机** 并实机运行所需的一切：

```
deploy/
├── deploy-remote.sh     # 一键部署脚本（Node + Harness 源码 + 插件 + 0.0.0.0 补丁 + 启动）
├── echo-adapter.ts      # Echo 测试适配器（无 API Key 时跑通全链路的夹具，生产勿挂）
└── README-REMOTE.md     # 本文件
```

## 方式 A：把连接信息给 DSH，由它远程执行

只要本机（Windows）能 `ssh` 到那台主机，就可以全程由 DSH 代跑：
打包上传 → 执行部署脚本 → 用内置浏览器打开 `http://<主机IP>:3080/remote/` 实机测试。

需要提供（任选一种认证方式）：

1. `ssh 用户名@主机IP` + 密码（或已有免密登录）；
2. 或 `ssh 用户名@主机IP -i 密钥文件路径`。

> 如果远程主机不在当前局域网/不可直达，需要能端口转发或公网可达 3080 端口。

## 方式 B：自己在远程主机上执行（两条命令）

```bash
# 1) 本机（Windows，工作区根目录）打包并上传
tar -czf dsh-remote-x.tar.gz dsh-remote-x
scp dsh-remote-x.tar.gz 用户名@主机IP:~/

# 2) 远程主机上解压并一键部署
ssh 用户名@主机IP
tar -xzf dsh-remote-x.tar.gz
bash dsh-remote-x/deploy/deploy-remote.sh
```

脚本结束时打印带口令的访问地址，例如：

```
http://<主机IP>:3080/remote/?token=AbCdEf1234567890abcd
```

## 脚本做了什么

1. 安装 Node v24（官方二进制，解压到安装目录，**不需要 sudo**；已有 ≥22.19 的 Node 则直接用）；
2. corepack 激活 pnpm 11.7（与 Harness `packageManager` 对齐）；
3. 下载 DeepSeek Harness 源码并 `pnpm install`（源码运行，无需构建）；
4. 复制 `dsh-remote-x` 插件，生成 `remote.patch.yml`：
   - 按 id 覆盖 `webserver` 行 → `host: 0.0.0.0`（手机可直连）+ 固定端口 + gzip；
   - 挂载插件（`token` 已自动生成，页面与 API 全部要求口令）；
   - **未检测到 `DEEPSEEK_API_KEY`** 时自动追加 Echo 适配器（provider `echo`），
     保证没有真实 Key 也能端到端跑通会话/流式/停止全链路；
5. `nohup pnpm dsh web --patch remote.patch.yml --no-open` 后台启动，打印日志/停止/重启命令。

## 安全说明

- `0.0.0.0` 绑定后**所有访问都必须带 token**（`?token=` 或 `x-remote-token` 头）；
- 桌面端 Harness 自带 SPA 的 `/api` 仍受其 Host/Origin 回环围栏保护，不因 0.0.0.0 打开；
- 如需更严的暴露面，可改用 SSH 隧道：`ssh -L 3080:127.0.0.1:3080 用户名@主机`，
  然后本机访问 `http://127.0.0.1:3080/remote/`（此时可去掉 token）。

## 部署后如何实测（由 DSH 内置浏览器执行）

1. 打开 `http://<主机IP>:3080/remote/?token=...`；
2. 检查仪表盘（工作区 / 任务计数）与模型目录（Echo 或 DeepSeek）；
3. 新建任务 → 发送消息 → 观察 `session/event` SSE 实时流（思考 / 工具 / 逐字回复）；
4. 停止生成、重命名、命令面板、明暗主题逐项过一遍；
5. 对照本目录 README 的功能对照表输出实测结论。
