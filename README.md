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
  index.js      入口：API 路由 + 静态托管 web/dist
  agent.js      Agent 主循环（工具执行/护栏/子代理编排）
  auth.js       登录/会话/邀请码
  scheduler.js  定时任务调度 + 空闲长会话自动归档
  autotitle.js  LLM 会话智能起名
  llm/          多模型网关（gateway.js 统一调用 / providers.js / market.js）
  tools/        工具注册表与实现（index.js + checkpoint/hooks/repomap/extract/…）
  channels/     外部渠道接入（wechat / feishu-webhook）
src/            前端源码（React + Vite 太阳大地色对话界面）
web/dist        前端构建产物（vite build 输出，服务端静态托管）
docs/           需求规格与演进文档
scripts/        运维脚本（selfcheck.mjs 自检 / kpi.mjs 周报 / verify.mjs）
prototype/      早期 UI 原型（参考，非运行代码）
```

## 凭据安全

所有 API Key / 密码只存服务器 `/root/.rw-keys.env`（chmod 600），禁止明文写入文档/代码/仓库。

## 需求规格

见 `docs/roni-workbench-需求规格-v1.0.md`（从 harness-hello 同步）。
