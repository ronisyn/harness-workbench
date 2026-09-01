# Roni Workbench (harness-workbench)

自托管的 AI 智能体 Web 平台：多厂商多模型对话、会话管理、Agent 工具、技能系统、能力开关、模型市场。

## 三环境

| 环境 | 位置 | 访问 |
|---|---|---|
| DEV 本地开发 | 本机 `E:\projects\harness-workbench` | `localhost:3000` |
| TEST 测试 | 服务器 880 端口 | `IP:880` |
| PROD 正式 | 服务器域名 + nginx + HTTPS | 域名 443 |

## 快速开始（DEV）

```bash
npm install
cp .env.example .env   # 填入 API Key
npm run dev            # localhost:3000
```

## 目录结构

```
server/         后端（Node + Express）
  index.js      入口
  config.js     配置加载
  db.js         MySQL 连接
  auth.js       登录/会话/邀请码
  llm/          多模型网关（OpenAI 兼容）
    gateway.js  统一调用
    providers.js 厂商配置
  routes/       API 路由
web/            前端（太阳大地色对话界面）
docs/           需求与文档
```

## 凭据安全

所有 API Key / 密码只存服务器 `/root/.rw-keys.env`（chmod 600），禁止明文写入文档/代码/仓库。

## 需求规格

见 `docs/roni-workbench-需求规格-v1.0.md`（从 harness-hello 同步）。
