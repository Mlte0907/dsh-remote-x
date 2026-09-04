/**
 * dsh-remote-x 客户端模块
 *
 * 运行版本: dist/client.js（纯 JS，无构建工具时的手写版本）
 * 本文件为开发参考，功能以 dist/client.js 为准。
 *
 * 两块功能：
 * 1. 设置页「远程控制」标签 — QR 码 + 连接信息 + 公网访问
 * 2. 移动端仪表盘 — 工作区卡片 + 任务列表（图4 样式）
 *    复用 DSH 客户端服务（ctx.sessions / ctx.workspaces）
 *
 * 移动端特性：
 * - 手机自动切换为移动端布局（<768px）
 * - 工作区卡片 + 任务列表，与网页端侧栏同步
 * - 归档过滤、未分类组、空白会话清理
 * - 点击任务进入会话内容，← 返回按钮
 * - ➕ 新建任务
 * - ☰ 视图切换（分组 ↔ 单列表）
 * - ⊟ 全部折叠/展开
 * - 长按任务行弹出删除菜单
 * - 浏览器刷新保持当前视图（sessionStorage）
 * - 深色主题自动适配（data-ds-dark-theme / prefers-color-scheme）
 */

// 此文件不直接加载；DSH 模块加载器加载 dist/client.js
// 修改代码后请同步更新 dist/client.js
