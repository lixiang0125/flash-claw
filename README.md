# Flash Claw

基于 Hono + Bun + LangChain 的 AI 对话引擎，支持 Skill 执行系统。

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
│   ├── index.ts      # Hono 服务入口
│   ├── chat.ts       # 对话引擎核心
│   └── skills/       # Skill 加载模块
├── src/web/         # React 前端
│   ├── components/  # UI 组件
│   ├── hooks/       # 业务逻辑
│   └── api/         # API 服务
├── .flashclaw/skills/  # Skills 目录
├── scripts/
│   ├── release.ts   # 自动发布脚本
│   └── build-web.ts # 前端构建脚本
├── .env             # 环境变量 (不提交)
├── .env.example     # 环境变量模板
├── vite.config.mts  # Vite 配置
└── package.json
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
