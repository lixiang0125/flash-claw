# 项目记忆

## 2024-03-01 - 初始化对话引擎

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

## 2024-03-01 - 接入 Qwen API

**目的**: 支持阿里云 Qwen 大模型

**改造点**:
- `.env` 配置改为使用 Coding Plan 专属端点:
  - `OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1`
  - `MODEL=qwen3.5-plus`
- 安装 `dotenv` 依赖解决环境变量加载问题
- `src/chat.ts` 自动检测 dashscope 配置

## 2024-03-01 - 自动发布流程

**目的**: 代码变更后自动生成 changelog 并推送到远端

**改造点**:
- 创建 `AGENTS.md`: 记录项目约束和开发规范
- 创建 `scripts/release.ts`: 自动发布脚本
  - 检测 git 变更文件
  - 生成 CHANGELOG.md
  - 自动 git commit 并 push
- `package.json` 添加 `bun run release` 命令

## 2024-03-01 - 梳理项目结构

**目的**: 整理项目文件，更新文档

**改造点**:
- 删除旧 placeholder 文件 `index.ts`
- 更新 `README.md`: 完整的项目文档
  - 技术栈说明
  - 快速开始指南
  - API 接口文档
  - 项目结构说明

## 2024-03-01 - 添加 Chat UI 页面

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
