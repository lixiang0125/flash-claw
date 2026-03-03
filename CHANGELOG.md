# Changelog

All notable changes to this project will be documented in this file.

### DI 容器激活 (2026-03-03)

**架构改进**:

- **H-1**: 激活 DI 容器，消除 ~800 行死代码
  - 在 `tokens.ts` 添加 CHAT_ENGINE, FEISHU_BOT, TASK_SCHEDULER, HEARTBEAT_SYSTEM, SUB_AGENT_SYSTEM, HTTP_SERVER
  - 在 `bootstrap.ts` 注册所有应用服务
  - 创建 `src/infra/hono-app.ts` 封装 Hono 应用创建
  - 修改 `src/index.ts` 使用 bootstrap() 替代手动构建
  - 完善 Database 接口 (添加 exec, get, all, run 方法)
  - 22 个服务全部通过 DI 容器管理

**验证结果**:

- 服务器启动成功，所有 API 端点正常工作
- 工具调用 (glob, read_file) 正常
- 依赖注入正确工作，结构化日志正常输出

---

### 架构治理与功能增强 (2026-03-03)

**架构改进**:

- **H-2**: 统一工具系统 - Zod-based 工具系统已启用
- **H-3**: 建立测试框架 + CI/CD
  - 添加 `bun test` 脚本
  - 添加 GitHub Actions CI 工作流
  - 创建 `.github/workflows/ci.yml`
- **H-5**: 合并双重用户画像
  - 扩展 UserProfile 接口
  - 使用统一的 UserProfileService
- **H-6**: 统一记忆系统
  - 标记 legacy.ts 为 @deprecated
- **H-7**: 合并 SQLite
  - tasks 和 heartbeat 默认使用 flashclaw.db
  - 可通过环境变量配置

**功能增强**:

- **M-12**: 引入 pino 结构化日志
- **M-13**: Feishu Token 并发保护
- **M-1, M-2**: SubAgent AbortController 支持
- **H-8**: 会话内存泄漏修复
- **M-6**: 命令白名单 + shell-quote 解析

**Bug 修复**:

- **H-4**: 删除废弃的 Stub 文件
- 删除 llm-service.ts, agent-core.ts 等

### 安全加固与 Bug 修复 (2026-03-03)

**安全漏洞修复**:

- **C-1**: 实现边界文件读写校验 (`src/infra/fs/boundary.ts`)
  - 添加路径边界检查，防止目录穿越攻击
  - 符号链接穿越检测
  - 敏感路径保护 (.env, .git, node_modules)

- **C-2**: 修复 Skill 脚本执行命令注入
  - 使用 `execFile` 替代 `execSync` 直接执行命令
  - 参数数组传递，避免 shell 解析

- **C-3**: 默认安全策略改为最小权限
  - `readablePathPatterns` 限制为 data/, .flashclaw/, skills/
  - `writablePathPatterns` 限制为 data/, .flashclaw/skills/, .flashclaw/evolution/

- **C-4**: 本地沙箱添加最低隔离
  - 生产环境强制要求 Docker 沙箱
  - 开发环境使用临时目录隔离
  - 添加受限环境变量

- **C-5**: Legacy Bash 工具添加安全检查
  - 集成 SecurityLayer 命令黑名单检查

- **C-6**: SSRF 保护升级
  - 使用异步 DNS 检查 (`checkWithDNS`)
  - 添加重定向目标检查

- **C-7**: Evolution 高风险计划添加确认门
  - 高/中风险计划需要用户确认才能执行

**Bug 修复**:

- **M-3**: 修复 edit-file matchCount bug
  - 替换前先计数，而非替换后计数

- **M-4**: 修复 ILonTermMemory 拼写错误
  - 改为 ILongTermMemory

- **M-9**: 修复 SESSION_TIMEOUT 文档与代码不一致
  - 读取环境变量而非硬编码

- **M-11**: 错误消息脱敏
  - 添加 ErrorSanitizer 统一错误处理
  - 错误编号追踪，内部日志记录

**功能增强**:

- **M-8**: 实现环境变量 Zod 校验 (`src/config/env.ts`)
  - 启动时校验必要环境变量
  - 类型安全的配置访问

### 记忆系统 (2026-03-03)

**改造点**:
- WorkingMemory: 纯内存工作记忆，当前对话窗口
- ShortTermMemory: SQLite 会话级记忆，24小时自动过期
- LongTermMemory: 向量语义检索，跨会话永久记忆
- LocalEmbeddingService: 本地嵌入服务 (Transformers.js / Ollama)
- VectorStore: sqlite-vec 向量存储 + FTS5 全文搜索混合检索
- MemoryManager: 三级记忆统一入口
- ContextBudget: 上下文预算管理，控制 Token 在 20K 以内
- UserProfile: 用户画像系统
- PromptBuilder: 预算感知的上下文组装器

**技术特性**:
- 本地嵌入模型，数据不出本地
- sqlite-vec 向量搜索 + FTS5 混合检索
- 记忆综合排序: semantic×0.5 + recency×0.3 + importance×0.2
- 时间衰减公式（一周半衰期）
- 事实提取和去重

**新增依赖**:
- @xenova/transformers: 本地嵌入模型
- sqlite-vec: 向量搜索扩展

### LLM Service 切换到 Vercel AI SDK (2026-03-02)

**改造点**:
- 使用 Vercel AI SDK 替换 LangChain
- 使用 @ai-sdk/openai-compatible provider
- 成功集成 DashScope (qwen-plus)

### Chat Engine 集成 (2026-03-02)

**改造点**:
- 简化 Chat Engine，保留核心功能
- 修复 LangChain API 兼容性问题
- 修复解析工具调用和记忆功能的 bug

### 基础设施重构 (2026-03-02)

**改造点**:
- 添加 createFlashClaw 工厂函数
- 导出 FlashClaw 接口 (run, registerTool)
- 整合所有核心组件
- 使用 Vercel AI SDK 替换 LangChain
- 使用 @ai-sdk/openai-compatible provider
- 成功集成 DashScope (qwen-plus)
- 简化 Chat Engine，保留核心功能
- 修复 LangChain API 兼容性问题
- 修复解析工具调用和记忆功能的 bug

**改造点**:
- 实现 ToolRegistry 工具注册中心
- 实现 SessionManager 会话管理器
- 实现 AgentCoreImpl 智能体循环
- 添加类型定义和单元测试
- 注意: tool calling 还需要进一步完善

### LLM Service 实现 (2026-03-02)

**改造点**:
- 实现 LLM Service，使用 LangChain
- 支持 generateText, streamText, generateObject 方法
- 注册 LLM_SERVICE 到 bootstrap

### DI 容器实现 (2026-03-02)

**改造点**:
- 实现 Token-based DI 容器 (Container, ScopedContainer)
- 支持三种生命周期: Singleton, Transient, Scoped
- 实现 TypedEventBus 事件总线
- 实现 Bootstrap 启动引导和异步初始化
- 预定义服务令牌: CONFIG, LOGGER, EVENT_BUS, DATABASE
- 添加单元测试

### Heartbeat 心跳系统升级 (2026-03-02)

**目的**: 改进心跳系统，使其能真正检测问题并通知用户

**改造点**:
- 添加内置健康检查：飞书连接状态、任务执行情况、服务器运行时长
- 添加通知机制：检测到问题时自动通过飞书通知用户
- 修复任务检查逻辑：检测错 过执行时间的任务
- 为 FeishuBot 添加 getStatus 方法用于检查连接状态

### 飞书消息确认优化 (2026-03-02)

**目的**: 改进消息确认体验，使用飞书表情回复替代文本

**改造点**:
- 收到消息时自动添加 THINKING 表情，无需 LLM 生成
- 实际回复和错误回复仍使用 LLM 生成，更友好
- 参考 OpenClaw 实现添加 addReaction 方法

### 飞书 Skills 系统 (2026-03-02)

**目的**: 完善 Skill 架构，定义何时使用飞书工具能力

**改造点**:
- 创建 `.flashclaw/skills/feishu-doc/SKILL.md`: 飞书文档操作技能
- 创建 `.flashclaw/skills/feishu-drive/SKILL.md`: 飞书云盘管理技能
- 创建 `.flashclaw/skills/feishu-perm/SKILL.md`: 飞书权限管理技能
- 创建 `.flashclaw/skills/feishu-wiki/SKILL.md`: 飞书 Wiki 知识库技能
- 更新 README.md 添加内置 Skills 说明

架构说明: Tools 定义"如何做"（代码实现），Skills 定义"何时用"（策略定义）

### 对话驱动进化系统 (2026-03-01)

**目的**: 类似 OpenClaw，让用户通过自然语言对话驱动 Agent 持续进化

**改造点**:
- 创建 `src/evolution/feedback_analyzer.ts`: 反馈分析器
  - 分析用户输入是否为进化类反馈
  - 分类：skill_optimize, skill_add, prompt_optimize, config_adjust, tool_fix
  - 提取进化需求和优先级
- 创建 `src/evolution/evolution_planner.ts`: 进化规划器
  - 将进化需求转化为可执行的方案
  - 生成 Skill 更新、配置修改等脚本
- 创建 `src/evolution/evolution_executor.ts`: 进化执行器
  - 执行进化方案
  - 自动备份和回滚
  - 验证进化效果
- 集成到 ChatEngine: 每次对话后自动检测进化需求
- 高优先级反馈自动触发进化

### Jina AI Reader WebFetch (2026-03-01)

**目的**: 替换不稳定的 WebFetch 实现，使用免费的 Jina AI Reader API

**改造点**:
- 修改 `src/tools/index.ts` 中的 `executeWebFetch` 函数
- 使用 Jina AI Reader API: `https://r.jina.ai/<URL>`
- 大幅简化代码，移除 jsdom 和 readability 依赖
- 更稳定、更快的网页内容获取

### WebSearch 互联网搜索 (2026-03-01)

**目的**: 让 AI 能够搜索互联网获取最新信息

**改造点**:
- 添加 WebSearch 工具到 `src/tools/index.ts`
- 使用 Tavily API 进行搜索
- 需要在 `.env` 中配置 `TAVILY_API_KEY`
- 返回搜索结果标题、内容摘要和 URL

### LLM 任务解析 (2026-03-01)

**目的**: 使用 LLM 智能解析任务请求，替代正则规则

**改造点**:
- 创建 `src/chat/llm-parser.ts`: LLM 任务解析器
- 使用 LLM 分析用户消息中的任务意图
- 支持更灵活的自然语言任务描述
- 一次性任务和循环任务智能识别

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
