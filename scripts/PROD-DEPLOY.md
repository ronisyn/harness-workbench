# Roni Workbench · PROD 部署指南（P6）

> 前置：DEV 本地开发完成、880 TEST 验证通过。正式上线前完成以下步骤。

## 1. 准备域名
- 域名示例：`agent.yourdomain.com`
- 在 DNS 服务商添加 A 记录：`agent.yourdomain.com → 47.106.205.196`

## 2. 部署 PROD 服务（独立端口 8081）
```bash
cd /srv/harness-workbench
git pull origin main
npm install
npm run build

# PROD 数据库（rw_prod）+ 环境
cat >> .env <<'EOF'
PORT=8081
DB_NAME=rw_prod
NODE_ENV=production
RW_FEISHU_WEBHOOK=1
EOF

# systemd 服务
cat > /etc/systemd/system/rw-prod.service <<'EOF'
[Unit]
Description=Roni Workbench PROD (8081)
After=network.target mysql.service
[Service]
Type=simple
WorkingDirectory=/srv/harness-workbench
EnvironmentFile=/srv/harness-workbench/.env
ExecStart=/usr/local/bin/node server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now rw-prod
```

## 3. HTTPS 证书（acme.sh 或 certbot）
```bash
# 以 acme.sh 为例
curl https://get.acme.sh | sh
~/.acme.sh/acme.sh --issue -d agent.yourdomain.com --nginx
~/.acme.sh/acme.sh --install-cert -d agent.yourdomain.com \
  --key-file /etc/nginx/ssl/agent.key \
  --fullchain-file /etc/nginx/ssl/agent.pem
```

## 4. nginx 反代（rw.conf，模板见下）
```bash
cp /srv/harness-workbench/scripts/nginx-rw.conf /etc/nginx/conf.d/rw.conf
# 修改 server_name / 证书路径
nginx -t && systemctl reload nginx
```

## 5. 飞书回调配置（F1-F5）
- 飞书开放平台 → 你的应用（cli_aa0d778298a29be3）→ 事件订阅
- 回调地址：`https://agent.yourdomain.com/api/feishu/webhook`
- 订阅事件：`im.message.receive_v1`（接收消息）
- 加密：使用 FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN（已配置）
- 保存后自动验证（challenge 握手）

## 6. 验证清单
- [ ] https://agent.yourdomain.com 打开登录页（Ronisyn）
- [ ] 对话（DeepSeek/Kimi 等模型）
- [ ] 微信：给机器人发消息收到回复
- [ ] 飞书：给机器人发消息收到回复
- [ ] 模型市场/设置/统计正常
- [ ] 880 TEST 保留为 staging（预发）

## 7. 对外形态（2026-09-16 起）
对外只走**一份契约**：`docs/会话API契约-v1.md`（会话 API 的端点、SSE 帧序、错误码、幂等键、已知限制逐条写死）。
运维侧要记住的四条：

- **幂等键**：外部调用 `POST /api/chat` 时带 `Idempotency-Key`，同一键重发**返回原始接受结果**、不会重复执行；
  调用方断线重连就该这么发，别自己发明重试去重。
- **死信**：`GET /api/deliveries?state=failed` 列出"没做完的外部调用"（含 attempts 与错误码）。
  **不自动重试**——重放＝用同一个幂等键重发；谁来看由人定（没有"几次算死"的阈值，因为平台没有投递重试引擎）。
- **回调来源校验**：`/api/feishu/webhook` 按飞书官方规范验签（`X-Lark-Signature`）。
  配了 `FEISHU_ENCRYPT_KEY` 就**必须**带签名，否则 401；两个密钥都没配时启动日志会明确告警"本入口不校验来源"。
- **把它当 MCP 工具给别的 agent 用**：
  ```json
  { "mcpServers": { "rw": { "command": "node",
      "args": ["/srv/harness-workbench/scripts/rw-mcp-server.mjs"],
      "env": { "RW_MCP_BASE_URL": "http://127.0.0.1:880", "RW_MCP_USER": "...", "RW_MCP_PASS": "...",
               "RW_MCP_PERMISSION": "read" } } } }
  ```
  暴露三个平台能力：`rw_chat` / `rw_status` / `rw_export`（**不暴露平台内部的模型工具**）。
  `RW_MCP_PERMISSION` 默认 `read`（最小权限），要让它真干活由运维显式提权。
  自检：`node scripts/selfcheck.mjs`（13 项，含"write 权限会话也能跑完一轮"）。
