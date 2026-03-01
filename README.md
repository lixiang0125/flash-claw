# Flash Claw

基于 Hono + Bun + LangChain 的 AI 对话引擎，支持 Skill 执行系统和工具执行能力。

## 技术栈

- **运行时**: Bun
- **Web 框架**: Hono
- **AI**: LangChain + Qwen (阿里云百炼)
- **前端**: React + Vite

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

AI 具有实际执行操作的能力，可以在对话中直接操作文件:

- **Read**: 读取文件内容
- **Write**: 创建或写入文件
- **Edit**: 编辑文件
- **Bash**: 执行 shell 命令
- **Glob**: 文件搜索
- **Grep**: 内容搜索
- **WebFetch**: 获取网页内容
- **GetProfile**: 获取用户画像
- **UpdateProfile**: 更新用户画像

AI 使用 `[TOOL_CALL]` 格式触发工具调用，执行后会自动生成友好的回复。

### 任务系统

支持定时任务，可以对话创建:
- "5分钟后提醒我喝水"
- "每小时提醒我休息"
- "每天早上8点叫我起床"

### 用户画像

AI 会记住用户的信息，在 System Prompt 中自动注入用户画像。告诉 AI 你的信息（如"我叫张三"），AI 会自动保存。

### Skill 系统

符合 Claude Code Agent Skills 标准，可加载预设的技能增强 AI 能力。

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
| GET | /api/tasks/:id/runs | 获取任务执行历史 |

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
│   ├── index.ts          # Hono 服务入口
│   ├── chat.ts           # 对话引擎核心
│   ├── skills/           # Skill 加载模块
│   ├── tools/            # 工具定义和执行器
│   └── integrations/
│       └── feishu.ts     # 飞书机器人集成
├── src/web/              # React 前端
│   ├── components/       # UI 组件
│   ├── hooks/            # 业务逻辑
│   └── api/              # API 服务
├── .flashclaw/skills/    # Skills 目录
├── scripts/
│   ├── release.ts        # 自动发布脚本
│   └── build-web.ts      # 前端构建脚本
├── .env                  # 环境变量 (不提交)
├── .env.example          # 环境变量模板
├── vite.config.mts       # Vite 配置
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

## 发布

每次代码变更后运行:

```bash
bun run release
```

自动执行:
1. 生成 CHANGELOG.md
2. Git commit
3. 推送到远端
