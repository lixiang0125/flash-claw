# 项目约束

## 开发规范

- 使用 Bun 作为运行时
- 使用 Hono 构建 REST API
- 使用 LangChain 接入大模型
- 核心位置需补充注释

## 前端开发

- UI 使用 React 实现
- 代码维护在 `/src/web` 目录
- 组件化开发，保持代码组织合理
- 使用 Vite 构建前端

## 环境变量

- 所有敏感配置存储在 `.env` 中
- `.env` 文件不提交到 git（已在 .gitignore 中）
- 使用 `dotenv` 加载环境变量

## 代码变更流程

每次代码变更后运行：
```bash
bun run release
```

自动执行：
1. 生成 CHANGELOG.md 记录变更
2. 自动 git commit
3. 推送到远端

## 对话引擎

- 模型配置通过环境变量 `MODEL` 设置
- baseURL 通过 `OPENAI_BASE_URL` 配置
- 支持多会话管理（sessionId 隔离）

## API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | / | 健康检查 |
| GET | /index.html | 前端页面 |
| POST | /api/chat | 对话接口 |
| POST | /api/chat/clear | 清除会话 |
| GET | /api/skills | 列出所有 Skills |
| GET | /api/skills/:name | 获取指定 Skill |
| POST | /api/skills/:name/exec | 执行 Skill 脚本 |

## Skill 系统

符合 Claude Code Agent Skills 标准。

### 目录结构

Skills 放在以下目录（按优先级）:
1. `./flashclaw/skills/`
2. `./agents/skills/`

```
flashclaw/skills/  (或 agents/skills/)
├── skill-name/
│   ├── SKILL.md          # 必需：Skill 定义
│   ├── scripts/          # 可选：可执行脚本
│   │   ├── script.sh
│   │   └── script.py
│   ├── references/      # 可选：参考文档
│   │   └── guide.md
│   └── assets/          # 可选：静态资源
```

### SKILL.md 格式

```yaml
---
name: skill-name
description: Skill 描述，说明何时使用
allowed_tools: Bash,Read,Write,Edit
---

# Skill 指令

这里是详细的技能指令...
```

### Frontmatter 字段

- `name`: 唯一标识符（小写字母、数字、短横线）
- `description`: 描述（说明何时触发，最大 1024 字符）
- `version`: 版本号（可选）
- `allowed_tools`: 允许使用的工具列表
- `disable_user_invocation`: 禁止用户调用
- `disable_model_invocation`: 禁止模型自动调用
