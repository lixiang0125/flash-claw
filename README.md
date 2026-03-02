# Flash Claw

基于 Hono + Bun + OpenAI SDK 的 AI 对话引擎，支持 Skill 执行系统和工具执行能力。

## 技术栈

- **运行时**: Bun
- **Web 框架**: Hono
- **AI**: OpenAI SDK (DashScope 阿里云百炼) + Qwen Function Calling
- **前端**: React 19 + Vite
- **数据库**: SQLite (bun:sqlite)

## 功能特性

- AI 对话：智能理解用户意图，支持多会话管理
- 工具执行：内置多种工具（搜索、文件读写、代码执行等）
- Skill 系统：支持自定义技能扩展
- 任务调度：定时任务提醒
- 飞书集成：接收和回复飞书消息
- 记忆系统：记住用户偏好和重要信息
- 子智能体：复杂任务自动拆分处理
- Heartbeat：系统健康检查和自动通知

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
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
MODEL=qwen3.5-plus
```

### 运行

```bash
bun run build:web  # 构建前端
bun run start      # 启动服务
```

服务启动后访问 http://localhost:3000

## 功能特性

### AI 对话

支持多会话管理，通过 sessionId 隔离不同用户的对话上下文。

### 工具执行

AI 使用 Qwen Function Calling 自动调用工具:

- **read_file**: 读取文件内容
- **write_file**: 创建或写入文件
- **edit_file**: 编辑文件
- **bash**: 执行 shell 命令
- **glob**: 文件搜索
- **grep**: 内容搜索
- **web_fetch**: 获取网页内容（自动提取主体内容并转为 Markdown）
- **web_search**: 互联网搜索

用户发送 URL 时，AI 会自动调用 web_fetch 工具获取内容并总结。

### 自迭代机制

AI 具备自我改进能力，类似 OpenClaw:

1. **工具重试**: 工具执行失败时自动重试（最多3次），AI 会分析错误原因并修正参数
2. **质量阈值循环**: 工具执行失败后，AI 会进行自我审查，尝试其他方法完成任务
3. **多轮反馈**: 通过迭代改进，直到所有工具执行成功或达到最大迭代次数
4. **子智能体**: AI 可以手动或自动启动子智能体处理耗时任务
   - 手动: AI 主动调用 SubAgent 工具
   - 自动: 系统检测到复杂任务时自动创建子智能体
5. **对话驱动进化**: 用户反馈可触发 Agent 自我进化
   - 自动分析用户反馈类型（功能问题、体验优化、新增能力）
   - 生成可执行的进化方案
   - 自动执行并验证效果

### 任务系统

支持定时任务，使用 LLM 智能解析用户请求：
- "一分钟后提醒我喝水" (一次性任务)
- "每5分钟提醒我休息" (循环任务)
- "每天早上8点叫我起床" (循环任务)

### 用户画像

AI 会记住用户的信息。包含三个文件：

- **USER.md**: 用户个人信息（名字、公司、偏好等）
- **MEMORY.md**: 长期记忆（重要事件、习惯等）
- **SOUL.md**: AI 人格定义

随着对话自动更新，不需要显式告诉 AI 更新。

### Heartbeat 心跳系统

定期自动检查系统健康状态，发现问题时通过飞书通知用户：

**内置检查项**:
- 飞书连接状态: 检测 WebSocket 是否正常
- 任务执行: 检测是否有任务错过执行时间  
- 服务器运行: 检测运行时长

**自定义检查**: 可在 `HEARTBEAT.md` 中添加自定义检查项：
```markdown
# Heartbeat Checklist

- 检查待办任务: every 30 min
- 检查生产环境: every 30 min, 9-21
```

### Skill 系统

符合 Claude Code Agent Skills 标准，可加载预设的技能增强 AI 能力。

### 内置 Skills

#### 飞书 Skills

AI 具备飞书文档、云盘、权限、Wiki 的操作能力：

| Skill | 描述 |
|-------|------|
| feishu-doc | 飞书文档操作（创建、读取、写入） |
| feishu-drive | 飞书云盘管理（浏览文件、创建文件夹） |
| feishu-perm | 飞书权限管理（查看分享权限） |
| feishu-wiki | 飞书 Wiki 知识库操作 |

消息确认：收到消息时自动添加 THINKING 表情，表示正在处理中。

这些 Skill 使 AI 能够在对话中直接操作飞书资源。

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
2. 开通必要权限:
   - im:message — 获取与发送消息
   - im:message:send_as_bot — 以机器人身份发消息
   - im:message.group_at_msg — 接收群聊@消息
   - im:message.p2p_msg — 接收单聊消息
3. 在「事件与回调」中选择「使用长连接接收事件」
4. 订阅事件: `im.message.receive_v1`
5. 配置环境变量:
   ```
   FEISHU_APP_ID=your-app-id
   FEISHU_APP_SECRET=your-app-secret
   ```
6. 发布应用

启动服务后会自动建立 WebSocket 长连接。

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

### 加载 Skill

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我审查这段代码", "skill": "code-review"}'
```

## Skill 系统

符合 Claude Code Agent Skills 标准。

### 目录结构

Skills 放置在以下目录:
- `.flashclaw/skills/` (项目级)
- `.agents/skills/` (项目级)
- 向上查找父目录的相同路径

### 创建 Skill

在 `.flashclaw/skills/` 下创建目录:

```
.flashclaw/skills/my-skill/
├── SKILL.md          # 必需：Skill 定义
├── scripts/          # 可选：可执行脚本
├── references/      # 可选：参考文档
└── assets/          # 可选：静态资源
```

### SKILL.md 格式

```yaml
---
name: my-skill
description: Skill 描述，说明何时使用
allowed_tools: Bash,Read,Write,Edit
---

# Skill 指令

这里是详细的技能指令...
```

## 项目结构

```
flash-claw/
├── src/
│   ├── index.ts              # Hono 服务入口
│   ├── cli.ts                # CLI 命令行工具
│   ├── chat/                 # 对话引擎
│   │   ├── engine.ts        # 聊天核心逻辑
│   │   ├── parsers.ts       # 消息解析器
│   │   ├── llm-parser.ts   # LLM 任务解析
│   │   └── types.ts        # 类型定义
│   ├── core/                 # 核心基础设施
│   │   ├── container/       # DI 容器
│   │   │   ├── container.ts
│   │   │   ├── bootstrap.ts
│   │   │   ├── llm-service.ts
│   │   │   └── tokens.ts
│   │   └── agent/           # Agent 循环
│   │       ├── agent-core.ts
│   │       ├── session-manager.ts
│   │       └── tool-registry.ts
│   ├── Skill 加载模块
│   ├── skills/              # tools/               # 工具定义和执行器
│   ├── memory/              # 记忆系统
│   ├── profiles/            # 用户画像
│   ├── tasks/               # 任务调度
│   ├── heartbeat/           # 心跳系统
│   ├── subagents/           # 子智能体
│   ├── evolution/           # 自迭代进化
│   ├── integrations/        # 第三方集成
│   │   └── feishu.ts        # 飞书集成
│   └── web/                 # React 前端
│       ├── components/     # UI 组件
│       ├── hooks/          # 业务逻辑
│       └── api/            # API 服务
├── .flashclaw/skills/       # Skills 目录
├── data/                    # SQLite 数据库
├── scripts/
│   ├── release.ts          # 自动发布脚本
│   └── build-web.ts        # 前端构建脚本
├── .env                     # 环境变量 (不提交)
├── .env.example             # 环境变量模板
├── vite.config.mts         # Vite 配置
└── package.json
```

## 环境变量

| 变量 | 描述 |
|------|------|
| OPENAI_API_KEY | API 密钥 |
| OPENAI_BASE_URL | API 端点地址 |
| MODEL | 模型名称 |
| FEISHU_WEBHOOK_URL | 飞书 Webhook 地址 |
| FEISHU_APP_ID | 飞书应用 ID |
| FEISHU_APP_SECRET | 飞书应用密钥 |
| TAVILY_API_KEY | Tavily 搜索 API Key |

## CLI 命令行工具

Flash Claw 提供命令行工具，方便快速操作:

```bash
flashclaw run                   # 启动服务器
flashclaw tasks                 # 列出所有任务
flashclaw tasks --cleanall      # 清除所有任务
flashclaw tasks --run <id>      # 手动触发任务
flashclaw skills                # 列出所有 Skills
flashclaw skills <name>         # 获取指定 Skill 详情
flashclaw subagents             # 列出所有子智能体
flashclaw subagents <id>        # 获取子智能体详情
flashclaw subagents --kill <id> # 停止子智能体
flashclaw help                  # 显示帮助信息
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
