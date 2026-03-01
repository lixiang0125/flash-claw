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
- **Heartbeat 心跳系统**: 定期主动检查任务清单
  - HEARTBEAT.md 配置
  - 支持时间窗口
  - 每 5 分钟检查一次

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

---

## 历史记录 (从 memory.md 迁移)

### 初始化对话引擎 (2024-03-01)

**目的**: 创建基于 LangChain 的基础对话引擎

**技术栈**:
- Hono + Bun 作为 Web 框架
- LangChain + OpenAI 接入大模型

**改造点**:
- 创建 `src/chat.ts`: 对话引擎核心类 ChatEngine
  - 使用 ChatOpenAI 模型
  - 内存会话管理 (Map<sessionId, messages>)
  - 支持 sessionId 隔离会话
- 创建 `src/index.ts`: Hono REST API
  - GET / - 健康检查
  - POST /chat - 对话接口
  - POST /chat/clear - 清除会话
- 创建 `.env.example` 和 `.env` 环境配置
- 更新 `package.json` 添加 dev/start 脚本

### 接入 Qwen API (2024-03-01)

**目的**: 支持阿里云 Qwen 大模型

**改造点**:
- `.env` 配置改为使用 Coding Plan 专属端点:
  - `OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1`
  - `MODEL=qwen3.5-plus`
- 安装 `dotenv` 依赖解决环境变量加载问题
- `src/chat.ts` 自动检测 dashscope 配置

### 自动发布流程 (2024-03-01)

**目的**: 代码变更后自动生成 changelog 并推送到远端

**改造点**:
- 创建 `AGENTS.md`: 记录项目约束和开发规范
- 创建 `scripts/release.ts`: 自动发布脚本
  - 检测 git 变更文件
  - 生成 CHANGELOG.md
  - 自动 git commit 并 push
- `package.json` 添加 `bun run release` 命令

### 梳理项目结构 (2024-03-01)

**目的**: 整理项目文件，更新文档

**改造点**:
- 删除旧 placeholder 文件 `index.ts`
- 更新 `README.md`: 完整的项目文档
  - 技术栈说明
  - 快速开始指南
  - API 接口文档
  - 项目结构说明

### 添加 Chat UI 页面 (2024-03-01)

**目的**: 提供可视化的聊天界面

**改造点**:
- 创建 `src/web/`: React 前端项目
  - `components/`: UI 组件 (Header, MessageList, MessageInput, TypingIndicator)
  - `hooks/useChat.ts`: 聊天逻辑 hook
  - `api/chat.ts`: API 服务层
  - `types/index.ts`: 类型定义
- 安装 React 相关依赖: react, react-dom, vite, @vitejs/plugin-react
- 创建 `vite.config.mts`: Vite 配置
- 创建 `scripts/build-web.ts`: 前端构建脚本
- 修改 `src/index.ts`: API 路径改为 `/api/*`，静态文件指向 `dist/`
- 删除旧的 `public/` 文件夹

### Skill 执行系统 (2024-03-01)

**目的**: 添加类似 OpenCode 的 skill 执行能力

**改造点**:
- 创建 `src/skills/index.ts`: Skill 核心模块
  - `listSkills()`: 列出所有可用 Skills
  - `getSkill(name)`: 获取指定 Skill
  - `searchSkills(query)`: 搜索 Skills
- 修改 `src/chat.ts`: 集成 Skill 系统
  - 支持通过 `skill` 参数加载 Skill
  - 会话级别的 Skill 状态管理
  - System Message 中注入 Skill 指令
- 添加 Skill API 端点
- 创建示例 Skills: code-review, doc-writer, git-commit

### 添加工具执行系统 (2024-03-01)

**目的**: 让 AI 具有实际执行操作的能力

**改造点**:
- 创建 `src/tools/index.ts`: 工具定义和执行器
  - Read, Write, Edit, Bash, Glob, Grep 工具
- 修改 `src/chat.ts`: 解析 `[TOOL_CALL]` 格式的工具调用
- 添加工具执行后的总结生成

### 飞书机器人集成 (2024-03-01)

**目的**: 接入飞书 IM 系统

**改造点**:
- 创建 `src/integrations/feishu.ts`: 飞书机器人模块
- 支持 Webhook 和 App API 两种模式

### 飞书长连接支持 (2024-03-01)

**目的**: 使用 WebSocket 长连接方式接入飞书机器人

**改造点**:
- 安装 `@larksuiteoapi/node-sdk` 依赖
- 使用 `WSClient` 建立 WebSocket 长连接
- 修复 SDK 事件注册方式
- 修复获取 tenant_access_token 方式
- 成功实现长连接模式机器人对话

### 添加 WebFetch 工具 (2024-03-01)

**目的**: 让 AI 能够获取网页内容

**改造点**:
- 添加 WebFetch 工具
- 使用 @mozilla/readability + jsdom 提取网页可读内容
- Playwright 支持动态页面渲染
- 支持 markdown 和 text 模式

### 飞书机器人优化 (2024-03-01)

**目的**: 改善用户体验

**改造点**:
- 收到消息后立即回复 "收到！正在处理中..." 然后后台处理
- 工具结果截断从 200 字符提升到 10000 字符

### 任务系统 (2024-03-01)

**目的**: 添加定时任务调度功能

**改造点**:
- 使用 bun:sqlite 持久化任务
- 使用 cron-parser 解析 cron 表达式
- 实现任务 CRUD API
- 支持手动触发和自动调度
- 每分钟检查并执行到期的任务

### 用户画像 (2024-03-01)

**目的**: 个性化用户信息

**改造点**:
- 创建 `src/profiles/index.ts`: 用户画像存储
- 添加 GetProfile 和 UpdateProfile 工具
- 在 System Message 中注入用户画像
- 创建 MEMORY.md 模板
