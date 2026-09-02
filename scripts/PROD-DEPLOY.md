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
