#!/usr/bin/env bash
# =============================================================================
# verify.sh — dsh-remote-x 插件的 API 级实机实测（在部署机上执行）
#
# 用法：bash deploy/verify.sh          （先完成 deploy-remote.sh 部署）
# 环境变量：PORT=3080  PATCH=~/dsh-remote/remote.patch.yml
# =============================================================================
set -uo pipefail

PATCH="${PATCH:-$HOME/dsh-remote/remote.patch.yml}"
if [ ! -f "$PATCH" ]; then
  echo "找不到 $PATCH —— 请先运行 deploy/deploy-remote.sh 完成部署"
  exit 1
fi
# 端口优先取环境变量，其次读补丁里生成的 port
PORT="${PORT:-$(grep -o 'port: [0-9]*' "$PATCH" | head -1 | awk '{print $2}')}"
PORT="${PORT:-3080}"
BASE="http://127.0.0.1:$PORT/remote"

TOKEN="$(grep -o "token: '[^']*'" "$PATCH" | head -1 | sed "s/token: '//; s/'$//")"
if [ -z "$TOKEN" ]; then
  echo "在 $PATCH 中未找到 token"; exit 1
fi

AUTH=(-H "x-remote-token: $TOKEN")
JSON=(-H 'content-type: application/json')
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1   —— $2"; fail=$((fail+1)); }

echo "== dsh-remote-x API 实机实测（$BASE）=="
echo

# 1. 首页（带 token）
body="$(curl -s "${AUTH[@]}" "$BASE/")"
if printf '%s' "$body" | grep -q 'DeepSeek 远程控制'; then ok "1 首页 HTML 渲染"; else bad "1 首页 HTML 渲染" "$(printf '%s' "$body" | head -c 120)"; fi

# 2. 无 token → 401
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tasks")"
if [ "$code" = "401" ]; then ok "2 无 token 返回 401"; else bad "2 无 token 返回 401" "实际 $code"; fi

# 3. bootstrap（模型目录）
boot="$(curl -s "${AUTH[@]}" "$BASE/api/bootstrap")"
if printf '%s' "$boot" | grep -q '"providers"'; then
  providers="$(printf '%s' "$boot" | grep -o '"id":"[^"]*"' | tr '\n' ' ')"
  ok "3 bootstrap 模型目录：$providers"
else
  bad "3 bootstrap 模型目录" "$(printf '%s' "$boot" | head -c 160)"
fi

# 4. 任务列表
tasks="$(curl -s "${AUTH[@]}" "$BASE/api/tasks")"
if printf '%s' "$tasks" | grep -q '"tasks"'; then ok "4 任务列表"; else bad "4 任务列表" "$(printf '%s' "$tasks" | head -c 120)"; fi

# 5. 创建任务（显式选择 Echo 模型，保证无 API Key 也全链路）
create="$(curl -s -X POST "${AUTH[@]}" "${JSON[@]}" -d '{"cwd":"'"$HOME"'","provider":"echo","model":"echo-1","reasoningEffort":"low"}' "$BASE/api/tasks")"
SID="$(printf '%s' "$create" | grep -o 'session-[a-f0-9-]*' | head -1)"
if [ -n "$SID" ]; then ok "5 创建任务 $SID"; else bad "5 创建任务" "$(printf '%s' "$create" | head -c 160)"; fi

# 6. 发送消息
msg="$(curl -s -X POST "${AUTH[@]}" "${JSON[@]}" -d '{"content":"实机测试你好","mode":"queue"}' "$BASE/api/tasks/$SID/messages")"
if printf '%s' "$msg" | grep -q '"accepted":true'; then ok "6 发送消息 accepted"; else bad "6 发送消息" "$(printf '%s' "$msg" | head -c 160)"; fi

# 7. SSE 实时事件流（真实 session/event：真实 agent-loop + Echo 适配器）
curl -sN -m 25 "${AUTH[@]}" "$BASE/api/events?sessionId=$SID" > /tmp/zr-sse.txt 2>/dev/null
sse_ok=1
for event_type in 'snapshot' 'turn/start' 'user/message' 'assistant/chunk' 'assistant/message' 'turn/end'; do
  if grep -q "$event_type" /tmp/zr-sse.txt; then ok "7 SSE 事件 $event_type"; else bad "7 SSE 事件 $event_type" "未捕获"; sse_ok=0; fi
done
if grep -q 'text-delta' /tmp/zr-sse.txt; then ok "7a SSE 逐字流 text-delta"; else bad "7a SSE 逐字流" "无 text-delta"; fi
if grep -q '实机测试你好' /tmp/zr-sse.txt; then ok "7b 回显内容到达 SSE"; else bad "7b 回显内容" "未在流中发现用户文本"; fi

# 8. 重命名
rename="$(curl -s -X POST "${AUTH[@]}" "${JSON[@]}" -d '{"title":"实机测试任务"}' "$BASE/api/tasks/$SID/rename")"
if printf '%s' "$rename" | grep -q '实机测试任务'; then ok "8 重命名"; else bad "8 重命名" "$(printf '%s' "$rename" | head -c 160)"; fi

# 9. 停止
cancel="$(curl -s -X POST "${AUTH[@]}" "${JSON[@]}" "$BASE/api/tasks/$SID/cancel")"
if printf '%s' "$cancel" | grep -q '"accepted":true'; then ok "9 停止生成"; else bad "9 停止生成" "$(printf '%s' "$cancel" | head -c 120)"; fi

# 10. 复查任务列表
sleep 1
tasks2="$(curl -s "${AUTH[@]}" "$BASE/api/tasks")"
if printf '%s' "$tasks2" | grep -q '实机测试任务'; then ok "10 列表标题已更新"; else bad "10 列表标题" "未见「实机测试任务」"; fi

echo
echo "== 结果：$pass 通过 / $fail 失败 =="
[ "$fail" -eq 0 ] || exit 1
