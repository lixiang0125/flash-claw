# Changelog

All notable changes to this project will be documented in this file.

## 2026-03-01

### Added

- **对话引擎**: 基于 LangChain + Qwen 的 AI 对话系统
- **多会话支持**: 通过 sessionId 隔离不同用户的对话
- **Skill 执行系统**: 支持 Claude Code 标准的 Skill
  - SKILL.md 格式
  - scripts/ 目录执行脚本
  - references/ 参考文档
- **工具执行系统**: AI 可以实际执行操作
  - Read/Write/Edit 文件
  - Bash 命令执行
  - Glob/Grep 搜索
  - WebFetch 网页抓取 (使用 Readability + Playwright)
- **飞书机器人**: WebSocket 长连接模式
  - 立即回复确认
  - 自动处理消息
- **任务系统**: 定时任务调度
  - cron 表达式支持
  - 手动触发
  - 任务历史记录
- **用户画像 (MEMORY.md)**: 个性化用户信息

### 技术栈

- Runtime: Bun
- Web: Hono
- AI: LangChain + Qwen (阿里云百炼)
- 前端: React + Vite
- 数据库: bun:sqlite
- 依赖: cron-parser, @larksuiteoapi/node-sdk, @mozilla/readability, jsdom, playwright

### API 端点

| Method | Path | Description |
|--------|------|-------------|
| GET | / | Health check |
| GET | /index.html | Frontend |
| POST | /api/chat | Chat |
| POST | /api/chat/clear | Clear session |
| GET | /api/skills | List skills |
| GET | /api/skills/:name | Get skill |
| POST | /api/skills/:name/exec | Execute script |
| GET | /api/tasks | List tasks |
| POST | /api/tasks | Create task |
| GET | /api/tasks/:id | Get task |
| PATCH | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| POST | /api/tasks/:id/run | Run task |
| GET | /api/tasks/:id/runs | Task history |
| POST | /api/webhooks/feishu | Feishu webhook |
| GET | /api/webhooks/feishu/status | Feishu status |
