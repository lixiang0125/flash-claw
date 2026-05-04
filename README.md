# Flash-Claw

[![CI](https://github.com/lixiang0125/flash-claw/actions/workflows/ci.yml/badge.svg)](https://github.com/lixiang0125/flash-claw/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![Hono](https://img.shields.io/badge/framework-Hono-E36002?logo=hono)](https://hono.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Flash-Claw 是一个基于 Bun、Hono、React 和 OpenAI-compatible 模型服务的本地 AI 智能体引擎。它提供对话引擎、四级记忆、工具调用、Skill、任务调度、飞书单/多机器人接入、心跳和基础安全边界。

## 当前能力

- 对话引擎：支持普通对话、流式响应、多步工具调用、任务意图解析和记忆检索。
- 记忆系统：工作记忆、短期记忆、mem0 向量记忆和 Markdown 记忆。
- 工具系统：内置文件、shell、搜索、网页抓取和本地浏览器 CDP 工具，并通过审批 gate 控制高风险工具。
- Skill 系统：兼容 Claude Code Agent Skills 标准，从 `.flashclaw/skills/`、`.agents/skills/` 和父目录同名路径动态发现。
- 飞书集成：保留 legacy 单机器人配置，同时支持 `FEISHU_BOTS` 多机器人管理器、路由分发、会话/记忆隔离和流式卡片。
- 任务与心跳：支持 cron、固定间隔、一次性任务和结构化飞书通知目标。
- Web 前端：React 19 + Vite 单页聊天界面。
- 安全边界：本机默认监听、API token gate、路径边界、命令过滤、SSRF 防护和工具审批。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| HTTP | Hono |
| 前端 | React 19 + Vite |
| LLM | OpenAI SDK，兼容 OpenAI / DashScope / 其他 OpenAI-compatible 网关 |
| 数据 | SQLite、JSON 文件 |
| 记忆 | mem0ai OSS、`@xenova/transformers` 本地 embedding |
| 测试 | Bun test、TypeScript `tsc --noEmit` |

## 快速开始

### 依赖

- Bun >= 1.0
- Node.js >= 18，仅在 Vite / Playwright 辅助能力需要 Node 侧生态时使用

### 安装

```bash
git clone git@github.com:lixiang0125/flash-claw.git
cd flash-claw
bun install
```

### 配置

```bash
cp .env.example .env
```

最小可用配置：

```bash
OPENAI_API_KEY=sk-xxxxx
OPENAI_BASE_URL=https://api.openai.com/v1
MODEL=gpt-4o-mini
```

DashScope 或其他 OpenAI-compatible 网关示例：

```bash
OPENAI_API_KEY=your-compatible-api-key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL=qwen-plus
```

### 运行

```bash
# 后端 + 前端静态资源服务，开发时由 Bun watch 重启
bun run dev

# 构建 Web 前端
bun run build:web

# 启动生产入口
bun run start
```

默认监听 `127.0.0.1:3000`。确需暴露给外部网络时再设置 `HOST=0.0.0.0`，并为受保护 API 配置 `FLASH_CLAW_API_TOKEN`。

### 验证

```bash
curl http://127.0.0.1:3000/health

curl -X POST http://127.0.0.1:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好，介绍一下你自己","sessionId":"default","userId":"local:user"}'
```

## 配置项

### 模型

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI-compatible API Key；也可回退读取 `DASHSCOPE_API_KEY` | 空 |
| `OPENAI_BASE_URL` | OpenAI-compatible API 地址；也可回退读取 `DASHSCOPE_BASE_URL` | OpenAI SDK 默认值 |
| `MODEL` | 主模型名；也可回退读取 `OPENAI_MODEL`、`MODEL_NAME` | `gpt-4o-mini` |

### 服务与安全

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | HTTP 服务端口 | `3000` |
| `HOST` | HTTP 绑定地址 | `127.0.0.1` |
| `NODE_ENV` | 运行环境 | `development` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `FLASH_CLAW_API_TOKEN` | 受保护 API 的访问 token；生产环境未配置时保护路由返回 503 | 空 |
| `FLASH_CLAW_AUTO_APPROVE_TOOLS` | 是否自动执行需要审批的高风险工具 | `false` |
| `USE_DOCKER_SANDBOX` | 是否启用 Docker 沙箱 | `false` |
| `SANDBOX_IMAGE` | Docker 沙箱镜像 | `flash-claw-sandbox:latest` |
| `ALLOWED_PATHS` | 允许工具访问的附加路径，逗号分隔 | 空 |

### 数据与记忆

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `DB_PATH` | DI 数据库路径 | `./data/FlashClaw.db` |
| `WORKSPACE_PATH` | Markdown 记忆和工作区路径 | `./data/workspace` |
| `TASKS_JSON_PATH` | 任务 JSON 文件路径 | `./data/cron/jobs.json` |
| `SESSION_TIMEOUT` | 短期记忆过期时间，毫秒 | `1800000` |
| `MEM0_BASE_URL` | mem0 LLM 网关覆盖 | 复用主 LLM 配置 |
| `MEM0_LLM_MODEL` | mem0 LLM 模型覆盖 | 复用主模型 |
| `MEM0_EMBEDDING_MODE` | `local` 或 `remote` | `local` |
| `MEM0_LOCAL_MODEL` | 本地 embedding 模型 | `Xenova/multilingual-e5-small` |
| `MEM0_EMBEDDING_BASE_URL` | 远程 embedding 地址 | `https://api.minimax.io/v1` |
| `MEM0_EMBEDDING_MODEL` | 远程 embedding 模型 | `embo-01` |
| `MEM0_COLLECTION` | mem0 collection 名称 | `flash_claw_memories` |
| `MEM0_HISTORY_DB` | mem0 history DB | `./data/mem0_history.db` |
| `MEM0_VECTOR_DB` | mem0 vector DB | `./data/mem0_vectors.db` |

### 搜索与浏览器

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| Web 搜索 | 当前内置 DuckDuckGo HTML provider，无需 API Key | — |
| `BROWSER_CDP_URL` | 本地 Chrome CDP 地址 | `http://127.0.0.1:9222` |
| `CHROME_PATH` | Chrome 可执行文件路径 | 自动探测 |

### 飞书

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `FEISHU_APP_ID` | legacy 单机器人应用 ID | 空 |
| `FEISHU_APP_SECRET` | legacy 单机器人应用 Secret | 空 |
| `FEISHU_WEBHOOK_URL` | legacy 单机器人发送消息 webhook | 空 |
| `FEISHU_VERIFICATION_TOKEN` | legacy 单机器人事件验证 token | 空 |
| `FEISHU_ENCRYPT_KEY` | legacy 单机器人事件加密 key | 空 |
| `FEISHU_MODE` | legacy 连接模式，`webhook` 或 `websocket` | `webhook` |
| `FEISHU_USE_LONG_CONNECTION` | legacy WebSocket 开关；若设置 `FEISHU_MODE`，以 `FEISHU_MODE` 为准 | `true` |
| `FEISHU_STREAMING` | legacy 流式卡片开关 | `true` |
| `FEISHU_SHOW_ELAPSED` | legacy 耗时 footer 开关 | `true` |
| `FEISHU_BOTS` | 多机器人 JSON 配置，支持对象映射或数组 | 空 |
| `FEISHU_DEFAULT_BOT_ID` | 多机器人默认 botId | 首个可用 bot |

## 飞书接入

### legacy 单机器人

没有配置 `FEISHU_BOTS` 时，系统会读取旧环境变量创建 `default` 机器人。旧部署只要保留原有 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_WEBHOOK_URL` 等配置即可继续运行。

```bash
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
FEISHU_VERIFICATION_TOKEN=xxxxx
FEISHU_ENCRYPT_KEY=xxxxx
FEISHU_MODE=webhook
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

### 多机器人

`FEISHU_BOTS` 支持对象映射：

```bash
FEISHU_DEFAULT_BOT_ID=ops
FEISHU_BOTS='{
  "ops": {
    "appId": "cli_ops_xxxxx",
    "appSecret": "ops_secret",
    "verificationToken": "ops_token",
    "mode": "webhook",
    "enableStreaming": true,
    "showElapsed": true
  },
  "sales": {
    "appId": "cli_sales_xxxxx",
    "appSecret": "sales_secret",
    "verificationToken": "sales_token",
    "mode": "websocket",
    "enableStreaming": true,
    "showElapsed": true
  }
}'
```

也支持数组形式：

```json
[
  { "id": "ops", "appId": "cli_ops", "appSecret": "secret", "isDefault": true },
  { "id": "notice", "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" }
]
```

路由选择顺序：

1. URL 中显式 `:botId`。
2. 飞书事件里的 `app_id`。
3. 飞书事件里的 token。
4. `FEISHU_DEFAULT_BOT_ID` 或默认机器人。

多机器人模式下，飞书入口会向对话引擎传入隔离后的身份：

```text
sessionId = feishu:${connectorId}:${tenantKey}:${chatId}:${sender}
userId    = feishu:${connectorId}:${tenantKey}:${sender}
```

这样不同机器人、租户、群聊和用户不会串会话，也不会把长期记忆写入默认用户。

## HTTP API

`GET /`、`GET /health`、`GET /api/status` 和飞书 webhook POST 路由公开。其他 API 在生产环境需要 `FLASH_CLAW_API_TOKEN`，通过 `Authorization: Bearer <token>` 或 `X-Flash-Claw-Token` 传入。

### 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 文本健康入口 |
| `GET` | `/health` | JSON 健康检查 |
| `GET` | `/api/status` | Web 前端使用的模型与后端状态摘要 |

### 对话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/chat` | 发送对话消息 |
| `POST` | `/api/chat/clear` | 清除指定 `sessionId` 的会话 |

### Skill

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/skills` | 列出所有 Skill，支持 `q` 查询 |
| `GET` | `/api/skills/:name` | 获取指定 Skill |
| `POST` | `/api/skills/:name/exec` | 执行 Skill `scripts/` 下的脚本 |

### 飞书

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/webhooks/feishu/status` | 默认飞书状态 |
| `GET` | `/api/webhooks/feishu/:botId/status` | 指定机器人状态 |
| `POST` | `/api/webhooks/feishu` | 自动识别 / 默认飞书 webhook |
| `POST` | `/api/webhooks/feishu/:botId` | 指定机器人 webhook |
| `GET` | `/api/feishu/webhook/status` | legacy 状态路径 |
| `GET` | `/api/feishu/webhook/:botId/status` | legacy 指定机器人状态路径 |
| `POST` | `/api/feishu/webhook` | legacy webhook 路径 |
| `POST` | `/api/feishu/webhook/:botId` | legacy 指定机器人 webhook 路径 |

### 任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/tasks` | 列出任务 |
| `POST` | `/api/tasks` | 创建 cron 或一次性任务 |
| `GET` | `/api/tasks/:id` | 获取任务详情 |
| `PATCH` | `/api/tasks/:id` | 更新任务 |
| `DELETE` | `/api/tasks/:id` | 删除任务 |
| `POST` | `/api/tasks/:id/run` | 立即执行任务 |
| `GET` | `/api/tasks/:id/runs` | 获取任务执行记录 |

### 心跳与子代理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/heartbeat/status` | 心跳状态 |
| `POST` | `/api/heartbeat/trigger` | 手动触发心跳 |
| `GET` | `/api/heartbeat/file` | 读取 `HEARTBEAT.md` |
| `POST` | `/api/heartbeat/file` | 写入 `HEARTBEAT.md` |
| `GET` | `/api/subagents` | 列出子代理运行记录 |
| `GET` | `/api/subagents/:id` | 获取子代理详情 |
| `DELETE` | `/api/subagents/:id` | 停止子代理 |

## CLI

项目的 npm scripts：

```bash
bun run dev
bun run start
bun run build:web
bun run typecheck
bun run test
bun run test:run
bun run release
```

安装为 bin 后可用的 CLI：

```bash
flashclaw run
flashclaw tasks
flashclaw tasks --cleanall
flashclaw tasks --run <id>
flashclaw skills
flashclaw skills <name>
flashclaw subagents
flashclaw subagents <id>
flashclaw subagents --kill <id>
```

## 项目结构

```text
flash-claw/
├── AGENTS.md                    # 统一 Agent 执行契约
├── CLAUDE.md -> AGENTS.md       # Claude 入口软链，避免规则漂移
├── docs/                        # 规则库、知识库、验证矩阵
├── scripts/                     # 构建、发布、SDK patch、浏览器 helper
├── src/
│   ├── index.ts                 # Bun 服务启动入口，加载 .env 并启动 Hono
│   ├── cli.ts                   # flashclaw CLI
│   ├── core/container/          # DI 容器、token、bootstrap
│   ├── infra/                   # Hono app、LLM 配置、FS/网络边界
│   ├── chat/                    # 对话引擎、流式调用、LLM parser
│   ├── agent/                   # PromptBuilder
│   ├── memory/                  # 四级记忆、mem0、embedding、vector store
│   ├── tools/                   # 工具注册、执行、内置工具、sandbox
│   ├── skills/                  # Skill 加载、搜索和脚本执行实现
│   ├── integrations/            # 飞书机器人、manager、流式卡片
│   ├── tasks/                   # JSON 文件任务调度
│   ├── heartbeat/               # 心跳系统
│   ├── security/                # 安全层
│   ├── subagents/               # 子代理运行管理
│   ├── evolution/               # 反馈分析和自进化策略
│   └── web/                     # React + Vite 前端
├── tests/                       # Bun 测试
├── data/                        # 运行时数据，勿提交
├── .env.example                 # 环境变量模板
├── package.json
├── tsconfig.json
└── vite.config.mts
```

## 文档与开发规则

`AGENTS.md` 是本项目唯一 Agent 规则入口；`CLAUDE.md` 通过软链指向它。开始修改代码前先读 `AGENTS.md`，再按任务范围阅读 `docs/README.md` 的索引。

常用文档：

- `docs/rules/development-guide.md`：开发规范、交付约束、文档同步和提交流程。
- `docs/test/verification-matrix.md`：按变更类型选择验证命令。
- `docs/knowledge-base/project-overview.md`：项目结构和核心子系统。
- `docs/knowledge-base/feishu-integration.md`：飞书单/多机器人、路由和会话/记忆隔离。
- `docs/knowledge-base/skills-and-tools.md`：Skill、工具、安全边界。
- `docs/channel-shared-memory-design.md`：多 channel 共享长期记忆设计草案。

每次代码变更必须同步更新 `README.md` 和 `CHANGELOG.md`，并在验证通过后提交、推送。

## 验证

基础命令：

```bash
bun run typecheck
bun test --run
bun run build:web
```

额外未使用代码检查：

```bash
bun run typecheck -- --noUnusedLocals true --noUnusedParameters true
```

不同变更类型的验证组合见 `docs/test/verification-matrix.md`。

## 发布

```bash
bun run release
```

当前 release 脚本会根据工作区改动生成 `CHANGELOG.md` 片段，然后执行 `git add -A`、commit 和 push。使用前先确认工作区没有无关改动，避免误提交本地文件。

## 许可证

[MIT](LICENSE)
