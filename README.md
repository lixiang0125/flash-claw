# Flash Claw

基于 Hono + Bun + OpenAI SDK 的 AI 对话引擎，支持 Skill 执行系统和工具执行能力。

## 技术栈

- **运行时**: Bun
- **Web 框架**: Hono
- **AI**: OpenAI SDK (DashScope 阿里云百炼) + Qwen Function Calling
- **前端**: React 19 + Vite
- **数据库**: SQLite (bun:sqlite) + mem0ai v2.3.0 OSS (本地向量搜索, better-sqlite3→bun:sqlite shim)
- **Embedding**: 本地 @xenova/transformers (Xenova/multilingual-e5-small, 384d) — 无需外部 API
- **DI 容器**: 自研 IoC 容器 (Singleton/Transient/Scoped 生命周期)

## 功能特性

- AI 对话：智能理解用户意图，支持多会话管理
- 工具执行：内置 7 种工具（搜索、文件读写、代码执行等）
- Skill 系统：支持自定义技能扩展，符合 Claude Code Agent Skills 标准
- 任务调度：定时任务提醒，LLM 智能解析
- 飞书集成：Webhook + 长连接两种模式
- 记忆系统：三级记忆体系 (Working/ShortTerm/LongTerm)
- 子智能体：复杂任务自动拆分处理，支持 AbortController
- Heartbeat：系统健康检查和自动通知
- DI 容器：22 个服务通过 IoC 容器管理

## 快速开始

### 安装依赖

```bash
bun install
```

### 配置环境变量

复制 `.env.example` 为 `.env` 并配置:

```bash
cp .env.example .env
```

修改 `.env` 中的配置:

```bash
# 主 LLM (coding 端点)
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
MODEL=qwen3.5-plus

# mem0 记忆系统
MEM0_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# Embedding 默认使用本地模型，无需额外 API key
MEM0_EMBEDDING_MODE=local
```

> **注意**: Embedding 默认使用本地 `Xenova/multilingual-e5-small` 模型，首次运行会自动下载 (~100MB)。如需切换为远程 API，设置 `MEM0_EMBEDDING_MODE=remote` 并配置相应 API key。

### 运行

```bash
bun run build:web  # 构建前端
bun run start      # 启动服务
```

服务启动后访问 http://localhost:3000

## 架构

### DI 容器

项目使用自研 IoC 容器管理所有服务：

```
Container
├── CONFIG          # 应用配置
├── LOGGER         # 结构化日志 (pino)
├── EVENT_BUS      # 事件总线
├── DATABASE       # SQLite 数据库
├── SANDBOX_MANAGER # 工具执行沙箱
├── TOOL_REGISTRY  # 工具注册表
├── TOOL_EXECUTOR  # 工具执行器
├── WORKING_MEMORY # 工作记忆
├── SHORT_TERM_MEMORY # 短期记忆
├── USER_PROFILE   # 用户画像
├── MEMORY_MANAGER # 记忆管理器 (mem0)
├── CONTEXT_BUDGET # 上下文预算
├── PROMPT_BUILDER # 提示词构建
├── CHAT_ENGINE    # 对话引擎
├── FEISHU_BOT     # 飞书机器人
├── TASK_SCHEDULER # 任务调度器
├── HEARTBEAT_SYSTEM # 心跳系统
├── SUB_AGENT_SYSTEM # 子智能体
└── HTTP_SERVER    # HTTP 服务器
```

启动时通过 `bootstrap()` 初始化所有服务：

```typescript
import { bootstrap } from "./core/container/bootstrap";

const container = await bootstrap();
const chatEngine = container.resolve(CHAT_ENGINE);
```

### 记忆系统

基于 OpenClaw 设计的四级记忆体系，让 Agent 具备跨会话持久化记忆能力：

| 层级 | 名称 | 存储位置 | 生命周期 |
|------|------|----------|----------|
| T0 | WorkingMemory | 内存 | 当前会话 |
| T1 | ShortTermMemory | SQLite | 30分钟自动过期 |
| T2 | mem0 Memory | SQLite 向量库 (`data/mem0_vectors.db`) | 永久 |
| T3 | MarkdownMemory | Markdown 文件 | 永久 |

**核心设计理念**：

- **文件即真相**：Markdown 文件是记忆的真实来源，数据库是派生索引，可随时重建
- **LLM 自主判断**：不通过关键词判断什么该记住，由 LLM 决定（使用 mem0 的 LLM 抽取能力）
- **优雅降级**：向量搜索失败 → 用户仍可直接读取 Markdown 文件
- **本地优先**：使用 mem0 OSS 本地模式，数据完全存储在本地 SQLite
- **Bun 兼容**：mem0ai 内部依赖 `better-sqlite3` 原生 addon，Bun 不支持加载。项目通过 `shims/better-sqlite3-bun.js` 透明映射到 `bun:sqlite`，postinstall 脚本自动生效

**5 种记忆写入触发路径**（参考 OpenClaw）：

| 触发路径 | 写入目标 | 说明 |
|----------|----------|------|
| 用户显式指令 | `MEMORY.md` | 用户说"记住这个" |
| 对话自动记录 | `memory/YYYY-MM-DD.md` | 每次对话自动追加到当日日志 |
| 预压缩刷写 | `memory/YYYY-MM-DD.md` | 上下文即将溢出时自动保存 |
| 会话重置 | `sessions/` | `/new` 或会话结束时保存 |
| 周期性综合 | `MEMORY.md` | 从日志提炼持久事实到长期记忆 |

**技术特性**：

- **混合搜索**：向量相似度 + BM25 关键字搜索并集设计，权重分配 70%/30%
- **MMR 重排序**：基于内容相似度保证结果多样性，避免重复
- **时间衰减**：新近记忆自然排名更高（半衰期可配置）

**数据目录结构**（`data/` 整体 gitignore，不上传远端）：
```
data/
├── FlashClaw.db           # 主数据库 (会话、任务等)
├── mem0_vectors.db        # mem0 向量存储
├── mem0_history.db        # mem0 记忆变更历史
├── profiles.db            # 用户画像
├── heartbeat.db           # 心跳记录
├── tasks.db               # 任务调度
└── workspace/
    ├── MEMORY.md          # 长期策划记忆（人名、偏好、决策）
    └── memory/
        ├── 2026-03-14.md  # 今日对话日志
        └── 2026-03-13.md  # 昨日对话日志
```

**配置选项**：
```typescript
// 向量存储
VectorStoreConfig {
  enableMMR: true,           // 启用 MMR 重排序
  mmrLambda: 0.7,           // 相关性/多样性平衡
  candidateMultiplier: 4,   // 候选倍增
  vectorWeight: 0.7,         // 向量权重
  ftsWeight: 0.3,           // 关键字权重
}

// 工作内存
WorkingMemoryConfig {
  memoryFlushEnabled: true,           // 启用预压缩刷写
  memoryFlushSoftThreshold: 4000,    // 距上限触发阈值
  reserveTokensFloor: 20000,          // 保留空间
}

// Markdown 存储
MarkdownMemoryConfig {
  workspacePath: "./data/workspace",
  enableDailyLogs: true,
  enableMemoryFile: true,
}
```

## 功能特性

### AI 对话

支持多会话管理，通过 sessionId 隔离不同用户的对话上下文。

### 工具执行

AI 使用 Qwen Function Calling 自动调用工具:

| 工具 | 描述 |
|------|------|
| read_file | 读取文件内容 |
| write_file | 创建或写入文件 |
| edit_file | 编辑文件 |
| bash | 执行 shell 命令 |
| glob | 文件搜索 |
| grep | 内容搜索 |
| web_search | 互联网搜索 |

用户发送 URL 时，AI 会自动调用 web_fetch 工具获取内容并总结。

### 任务系统

支持定时任务，使用 LLM 智能解析用户请求：
- "一分钟后提醒我喝水" (一次性任务)
- "每5分钟提醒我休息" (循环任务)
- "每天早上8点叫我起床" (循环任务)

### Heartbeat 心跳系统

定期自动检查系统健康状态，发现问题时通过飞书通知用户：

**内置检查项**:
- 飞书连接状态: 检测 WebSocket 是否正常
- 任务执行: 检测是否有任务错过执行时间  
- 服务器运行: 检测运行时长

**自定义检查**: 可在 `HEARTBEAT.md` 中添加自定义检查项

### Skill 系统

符合 Claude Code Agent Skills 标准，可加载预设的技能增强 AI 能力。

#### 内置 Skills

| Skill | 描述 |
|-------|------|
| git-commit | Git 提交助手 |
| doc-writer | 文档编写助手 |
| test-generator | 测试生成助手 |
| code-review | 代码审查助手 |
| feishu-doc | 飞书文档操作 |
| feishu-drive | 飞书云盘管理 |
| feishu-perm | 飞书权限管理 |
| feishu-wiki | 飞书 Wiki 知识库 |
| wechat-fetcher | 公众号文章抓取 |
| skill-creator | Skill 创建助手 |

## 飞书集成

支持两种接入方式:

### 方式1: Webhook (简单)

1. 在飞书创建自定义机器人，获取 Webhook URL
2. 配置环境变量:
   ```
   FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
   ```

### 方式2: 长连接 (推荐)

使用 `@larksuiteoapi/node-sdk` 建立 WebSocket 长连接:

1. 在飞书开放平台创建自建应用，添加机器人能力
2. 开通必要权限
3. 在「事件与回调」中选择「使用长连接接收事件」
4. 订阅事件: `im.message.receive_v1`
5. 配置环境变量:
   ```
   FEISHU_APP_ID=your-app-id
   FEISHU_APP_SECRET=your-app-secret
   ```

## API 接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | / | 健康检查 |
| GET | /index.html | 前端页面 |
| POST | /api/chat | 对话接口 |
| POST | /api/chat/clear | 清除会话 |
| GET | /api/skills | 列出所有 Skills |
| GET | /api/skills/:name | 获取指定 Skill |
| POST | /api/skills/:name/exec | 执行 Skill 脚本 |
| POST | /api/webhooks/feishu | 飞书 Webhook |
| GET | /api/webhooks/feishu/status | 飞书配置状态 |
| GET | /api/tasks | 列出所有任务 |
| POST | /api/tasks | 创建任务 |
| GET | /api/tasks/:id | 获取任务详情 |
| PATCH | /api/tasks/:id | 更新任务 |
| DELETE | /api/tasks/:id | 删除任务 |
| POST | /api/tasks/:id/run | 手动触发任务 |
| GET | /api/tasks/:id/runs | 获取任务历史 |
| GET | /api/heartbeat/status | 心跳状态 |
| POST | /api/heartbeat/trigger | 手动触发心跳 |
| GET | /api/heartbeat/file | 获取 HEARTBEAT.md |
| POST | /api/heartbeat/file | 更新 HEARTBEAT.md |
| GET | /api/subagents | 列出所有子智能体 |
| GET | /api/subagents/:id | 获取子智能体详情 |
| DELETE | /api/subagents/:id | 停止子智能体 |

### 对话接口

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好", "sessionId": "user123"}'
```

响应:

```json
{
  "response": "你好！有什么我可以帮你的吗？",
  "sessionId": "user123"
}
```

## 项目结构

```
flash-claw/
├── src/
│   ├── index.ts              # 服务入口 (使用 bootstrap)
│   ├── cli.ts                # CLI 命令行工具
│   ├── core/
│   │   ├── container/        # DI 容器
│   │   │   ├── container.ts  # IoC 容器实现
│   │   │   ├── bootstrap.ts   # 服务启动引导
│   │   │   ├── tokens.ts     # Service Token 定义
│   │   │   └── types.ts      # 类型定义
│   │   └── agent/            # Agent 系统
│   ├── chat/                 # 对话引擎
│   │   ├── engine.ts         # 聊天核心逻辑
│   │   ├── parsers.ts        # 消息解析器
│   │   └── types.ts          # 类型定义
│   ├── memory/               # 记忆系统
│   │   ├── working-memory.ts
│   │   ├── short-term-memory.ts
│   │   ├── long-term-memory.ts
│   │   ├── memory-manager.ts
│   │   ├── markdown-memory.ts  # Markdown 文件存储
│   │   ├── context-budget.ts
│   │   ├── user-profile.ts
│   │   ├── vector-store.ts
│   │   └── embedding/
│   ├── tools/                # 工具系统
│   │   ├── builtin/          # Zod-based 工具
│   │   ├── tool-registry.ts
│   │   ├── tool-executor.ts
│   │   └── sandbox/
│   ├── skills/               # Skill 加载模块
│   ├── tasks/               # 任务调度
│   ├── heartbeat/            # 心跳系统
│   ├── subagents/            # 子智能体
│   ├── evolution/            # 自迭代进化
│   ├── integrations/         # 第三方集成
│   │   └── feishu.ts
│   ├── security/             # 安全层
│   └── infra/               # 基础设施
│       └── hono-app.ts      # Hono 应用创建
├── .flashclaw/skills/       # Skills 目录
├── data/                    # SQLite 数据库 + Markdown 记忆
├── .env                     # 环境变量 (不提交)
├── .env.example             # 环境变量模板
└── package.json
```

## 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| OPENAI_API_KEY | API 密钥 | - |
| OPENAI_BASE_URL | API 端点地址 | https://coding.dashscope.aliyuncs.com/v1 |
| MODEL | 模型名称 | qwen3.5-plus |
| PORT | 服务端口 | 3000 |
| NODE_ENV | 运行环境 | development |
| LOG_LEVEL | 日志级别 | info |
| FEISHU_WEBHOOK_URL | 飞书 Webhook | - |
| FEISHU_APP_ID | 飞书应用 ID | - |
| FEISHU_APP_SECRET | 飞书应用密钥 | - |
| TAVILY_API_KEY | Tavily 搜索 API | - |
| USE_DOCKER_SANDBOX | 使用 Docker 沙箱 | false |
| WORKSPACE_PATH | Markdown 记忆工作区路径 | ./data/workspace |

## CLI 命令

```bash
flashclaw run                   # 启动服务器
flashclaw tasks                 # 列出所有任务
flashclaw tasks --cleanall      # 清除所有任务
flashclaw tasks --run <id>     # 手动触发任务
flashclaw skills               # 列出所有 Skills
flashclaw skills <name>        # 获取指定 Skill 详情
flashclaw subagents            # 列出所有子智能体
flashclaw subagents <id>       # 获取子智能体详情
flashclaw subagents --kill <id> # 停止子智能体
flashclaw help                 # 显示帮助信息
```

## 发布

每次代码变更后运行:

```bash
bun run release
```

自动执行:
1. 生成 CHANGELOG.md
2. Git commit
3. 推送到远端
