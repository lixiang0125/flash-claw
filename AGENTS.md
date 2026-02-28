# 项目约束

## 开发规范

- 使用 Bun 作为运行时
- 使用 Hono 构建 REST API
- 使用 LangChain 接入大模型

## 前端开发

- UI 使用 React 实现
- 代码维护在 `/src/web` 目录
- 组件化开发，保持代码组织合理
- 核心位置需补充注释
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
