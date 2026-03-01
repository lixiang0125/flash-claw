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

## 2024-03-01 - Skill 执行系统

**目的**: 添加类似 OpenCode 的 skill 执行能力，让 AI 可以在对话中加载并使用预设的技能

**改造点**:
- 创建 `src/skills/index.ts`: Skill 核心模块
  - `listSkills()`: 列出所有可用 Skills
  - `getSkill(name)`: 获取指定 Skill
  - `searchSkills(query)`: 搜索 Skills
- 修改 `src/chat.ts`: 集成 Skill 系统
  - 支持通过 `skill` 参数加载 Skill
  - 会话级别的 Skill 状态管理
  - System Message 中注入 Skill 指令
- 添加 Skill API 端点:
  - `GET /api/skills`: 列出所有 Skills
  - `GET /api/skills/:name`: 获取指定 Skill
- 创建示例 Skills:
  - `skills/code-review/`: 代码审查助手
  - `skills/doc-writer/`: 文档编写助手
- 前端添加 Skill 选择器

## 2024-03-01 - 重构 Skill 系统符合 Claude Code 标准

**目的**: 使用 Claude Code Agent Skills 标准格式

**改造点**:
- `SKILL.md` 格式替换 `skill.json`
  - YAML frontmatter: name, description, allowed_tools 等
  - Markdown 指令内容
- 支持 `scripts/` 目录: 可执行脚本 (sh, py, js)
- 支持 `references/` 目录: 参考文档
- 添加 `POST /api/skills/:name/exec` 执行脚本
- 新增示例 Skills:
  - `skills/git-commit/`: Git 提交助手
- 移除旧的 `skill.json` 文件

## 2024-03-01 - 添加工具执行系统

**目的**: 让 AI 具有实际执行操作的能力，类似 OpenClaw/Claude Code

**改造点**:
- 创建 `src/tools/index.ts`: 工具定义和执行器
  - `Read`: 读取文件
  - `Write`: 写入文件
  - `Edit`: 编辑文件
  - `Bash`: 执行 shell 命令
  - `Glob`: 文件搜索
  - `Grep`: 内容搜索
- 修改 `src/chat.ts`: 
  - 在 System Prompt 中注入工具说明
  - 解析 `[TOOL_CALL]` 格式的工具调用
  - 添加工具执行后的总结生成
- 前端添加工具调用结果显示

## 2024-03-01 - 工具执行结果优化

**目的**: 让工具执行后的回复更自然、更有人情味

**改造点**:
- 工具执行后调用 LLM 生成友好的总结回复
- 不再显示原始的 `[TOOL_RESULT]` 标记
- 回复更加自然，像正常对话一样

## 2024-03-01 - 飞书机器人集成

**目的**: 接入飞书 IM 系统，支持在飞书中与 AI 对话

**改造点**:
- 创建 `src/integrations/feishu.ts`: 飞书机器人模块
  - 支持两种接入方式: Webhook (简单) 和 App API (完整)
  - Webhook 模式: 接收消息并回复
  - App API 模式: 支持更多功能 (卡片消息、@机器人等)

## 2024-03-01 - 飞书长连接支持

**目的**: 使用 WebSocket 长连接方式接入飞书机器人

**改造点**:
- 安装 `@larksuiteoapi/node-sdk` 依赖
- 使用 `WSClient` 建立 WebSocket 长连接
- 简化代码，移除 Webhook 依赖
- 更新 README 接入指南
- 添加 API 端点:
  - `POST /api/webhooks/feishu`: 飞书 Webhook 接收地址
  - `GET /api/webhooks/feishu/status`: 配置检查
- 环境变量配置:
  - `FEISHU_WEBHOOK_URL`: Webhook 地址
  - `FEISHU_APP_ID`: 应用 ID
  - `FEISHU_APP_SECRET`: 应用密钥
