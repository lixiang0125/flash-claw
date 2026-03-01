# Changelog

All notable changes to this project will be documented in this file.

## 2026-03-01

### 子智能体自动触发 (2026-03-01)

**目的**: 让系统能够自动检测复杂任务并创建子智能体，无需 AI 主动调用

**改造点**:
- 创建 `src/subagents/analyzer.ts`: 任务复杂度分析器
  - `analyzeComplexity()`: 检测任务复杂度
    - 多文件操作: 涉及 3+ 文件时触发
    - 多个独立任务: 可分解为并行子任务时触发
    - 耗时长命令: npm install、docker build 等
  - `splitIntoSubTasks()`: 将任务分解为子任务
- 修改 `src/chat/engine.ts`:
  - 添加 `maybeSpawnSubAgents()` 方法
  - 在工具执行后自动分析复杂度
  - 满足条件时自动创建子智能体
- System Message 添加 SubAgent 使用指南
- README 更新功能说明

### 子智能体系统 (2026-03-01)

**目的**: 类似 OpenClaw 的 sub-agents 机制，支持 AI 并行处理耗时任务

**改造点**:
- 创建 `src/subagents/index.ts`: 子智能体管理系统
  - `spawn()`: 启动子智能体
  - `getRun()`: 获取子智能体状态
  - `listRuns()`: 列出所有子智能体
  - `killRun()`: 停止子智能体
  - 配置参数: maxConcurrent, maxSpawnDepth, maxChildrenPerAgent
- 添加 SubAgent 工具到 `src/tools/index.ts`
  - AI 可以通过 `[TOOL_CALL]` 调用启动子智能体
  - 子智能体在独立会话中运行，完成后向主会话报告结果
- CLI 添加子智能体管理命令:
  - `flashclaw subagents` 列出所有子智能体
  - `flashclaw subagents <id>` 获取详情
  - `flashclaw subagents --kill <id>` 停止子智能体
- `README.md` 更新工具列表和 CLI 说明

### 自迭代机制 (2026-03-01)

**目的**: 类似 OpenClaw 的自我改进能力，让 AI 在工具执行失败时能够自动分析和修复

**改造点**:
- 创建工具重试机制 (`src/chat/engine.ts`):
  - 工具执行失败时自动重试（最多3次）
  - AI 分析错误原因并修正参数
  - 提供重试提示帮助 AI 理解失败原因
- 创建质量阈值循环:
  - 工具执行失败后 AI 进行自我审查
  - 尝试其他方法完成任务
- 多轮反馈:
  - 迭代改进直到所有工具成功或达到最大迭代次数
- Skill 接口添加 `disable_user_invocation` 和 `disable_model_invocation` 字段

### CLI 命令行工具 (2026-03-01)

**目的**: 提供便捷的命令行操作方式，无需启动服务即可管理任务和 Skills

**改造点**:
- 创建 `src/cli.ts`: CLI 入口
  - `flashclaw run` 启动服务器
  - `flashclaw tasks` 列出所有任务
  - `flashclaw tasks --cleanall` 清除所有任务
  - `flashclaw tasks --run <id>` 手动触发任务
  - `flashclaw skills` 列出所有 Skills
  - `flashclaw skills <name>` 获取指定 Skill 详情
- `package.json` 添加 bin 入口
- `README.md` 添加 CLI 使用说明

---

## 历史记录

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
