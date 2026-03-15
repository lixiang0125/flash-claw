# Flash-Claw ⚡🦞

[![CI](https://github.com/anthropics/flash-claw/actions/workflows/ci.yml/badge.svg)](https://github.com/anthropics/flash-claw/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![Hono](https://img.shields.io/badge/framework-Hono-E36002?logo=hono)](https://hono.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 基于 Bun + Hono + OpenAI SDK 的 AI 智能体引擎 —— 内置四级记忆、自进化、任务调度、安全沙箱与飞书集成。

---

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **运行时** | [Bun](https://bun.sh) | 高性能 JavaScript/TypeScript 运行时 |
| **Web 框架** | [Hono](https://hono.dev) | 超轻量 Web 框架，兼容多运行时 |
| **AI 推理** | OpenAI SDK | 兼容 DashScope / 阿里云百炼，使用 Qwen Function Calling |
| **前端** | React 19 + Vite | 单页应用，Vite 构建 |
| **数据库** | SQLite (`bun:sqlite`) | 内嵌数据库，零依赖部署 |
| **向量记忆** | [mem0ai](https://github.com/mem0ai/mem0) v2.3.0 OSS | 本地向量搜索，`better-sqlite3` → `bun:sqlite` shim |
| **Embedding** | `@xenova/transformers` | 本地推理，模型 `Xenova/multilingual-e5-small`（384 维） |
| **DI 容器** | 自研 IoC 容器 | Singleton / Transient / Scoped 三种生命周期 |

---

## 功能特性概览

- **对话引擎** — 多步工具循环、记忆检索、任务调度意图解析，一次对话即可完成复杂任务
- **四级记忆系统** — T0 工作记忆 → T1 短期记忆 → T2 向量记忆 → T3 Markdown 记忆，兼顾速度与持久化
- **自进化系统** — 对话反馈分析 + 进化策略规划，智能体可从交互中自主学习与改进
- **8 个内置工具** — bash、文件读写编辑、glob/grep 搜索、Web 搜索与抓取
- **Skill 系统** — 兼容 Claude Code Agent Skills 标准，内置 10 个 Skill
- **任务调度** — cron / interval / one-time 三种模式，LLM 智能解析多语言任务意图
- **飞书集成** — Webhook + WebSocket 长连接双模式
- **安全层** — 路径边界检查、命令安全过滤、速率限制、SSRF 防护、审计日志
- **DI 容器** — 自研 IoC 容器，24 个服务 Token，循环依赖检测与有序销毁
- **心跳系统** — 定时健康检查与自动恢复

---

## 快速开始

### 前置要求

- [Bun](https://bun.sh) >= 1.0
- Node.js >= 18（仅 Vite 构建前端时需要）

### 安装

```bash
# 克隆仓库
git clone https://github.com/anthropics/flash-claw.git
cd flash-claw

# 安装依赖
bun install
```

### 配置

复制环境变量模板并填写必要配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件，至少配置以下变量：

```bash
# AI 推理（必须）
DASHSCOPE_API_KEY=sk-xxxxx          # 阿里云百炼 / DashScope API Key
MODEL_NAME=qwen-max                  # 模型名称

# 可选
TAVILY_API_KEY=tvly-xxxxx           # Web 搜索（Tavily）
FEISHU_APP_ID=cli_xxxxx             # 飞书应用 ID
FEISHU_APP_SECRET=xxxxx             # 飞书应用 Secret
```

### 运行

```bash
# 开发模式（后端 + 前端热重载）
bun run dev

# 仅构建前端
bun run build:web

# 生产模式
bun run start
```

### 验证

```bash
# 健康检查
curl http://localhost:3000/health

# 发送对话
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好，介绍一下你自己"}'
```

---

## 架构设计

### DI 容器

Flash-Claw 使用自研的 IoC（控制反转）容器管理所有服务的生命周期与依赖关系。

#### 三种生命周期

| 生命周期 | 行为 | 适用场景 |
|----------|------|----------|
| **Singleton** | 全局唯一实例，首次解析时创建 | 数据库、配置、日志等基础设施 |
| **Transient** | 每次解析都创建新实例 | 无状态工具、临时处理器 |
| **Scoped** | 在同一作用域内共享实例 | 请求级别的上下文 |

#### 服务注册表（24 个 Token）

```
CONFIG, LOGGER, EVENT_BUS, DATABASE,
SANDBOX_MANAGER, TOOL_REGISTRY, TOOL_EXECUTOR,
WORKING_MEMORY, MARKDOWN_MEMORY, SHORT_TERM_MEMORY,
USER_PROFILE, MEMORY_MANAGER, CONTEXT_BUDGET,
PROMPT_BUILDER, CHAT_ENGINE,
FEISHU_BOT, TASK_SCHEDULER, HEARTBEAT_SYSTEM,
SUB_AGENT_SYSTEM, EVOLUTION_ENGINE, HTTP_SERVER
```

> 另有 `EMBEDDING_SERVICE`、`VECTOR_STORE`、`LONG_TERM_MEMORY`、`LLM_SERVICE`、`AGENT_CORE` 作为 Token 定义，由其他服务内部使用。

#### 核心特性

- **循环依赖检测** — 注册阶段即可发现循环引用
- **有序销毁** — 按依赖拓扑逆序执行 `dispose()`，确保资源安全释放
- **类型安全** — 基于 `ServiceToken<T>` 泛型，解析结果自动推断类型

```typescript
// 定义 Token
const CHAT_ENGINE = new ServiceToken<IChatEngine>('ChatEngine');

// 注册服务
container.registerSingleton(CHAT_ENGINE, ChatEngine, [
  TOOL_EXECUTOR, MEMORY_MANAGER, PROMPT_BUILDER, TASK_SCHEDULER
]);

// 解析服务（类型自动推断为 IChatEngine）
const engine = container.resolve(CHAT_ENGINE);
```

---

### 对话引擎

对话引擎（`ChatEngine`）是 Flash-Claw 的核心，负责编排整个对话流程：

```
用户输入
  │
  ▼
意图解析（任务调度 / 普通对话）
  │
  ├─ 任务意图 → LLM 智能解析 → 创建定时任务
  │
  └─ 对话意图 → 记忆检索 → 提示词构建 → LLM 推理
                                              │
                                              ▼
                                        工具调用循环
                                         （多步执行）
                                              │
                                              ▼
                                        记忆写入 + 响应
```

#### 关键能力

- **多步工具循环** — 单次对话可连续调用多个工具，自动处理工具结果并继续推理
- **记忆检索** — 自动从四级记忆中检索相关上下文，注入提示词
- **任务调度意图解析** — 识别「每天早上 8 点提醒我...」等自然语言，自动创建定时任务
- **LLM 智能任务解析** — 使用 LLM 解析复杂任务意图，支持多语言
- **记忆查询重写** — LLM 自动优化检索查询，提高记忆召回质量

---

### 四级记忆系统

Flash-Claw 实现了从易失到持久的四级记忆体系，每一级服务不同的时间尺度与使用场景。

#### 记忆层级总览

| 层级 | 名称 | 存储介质 | 生命周期 | 延迟 | 典型用途 |
|------|------|----------|----------|------|----------|
| **T0** | 工作记忆 | 内存 | 会话级（进程退出即丢失） | < 1ms | 当前对话上下文、工具调用状态 |
| **T1** | 短期记忆 | SQLite | 30 分钟自动过期 | ~ 1ms | 近期对话摘要、临时事实 |
| **T2** | 向量记忆 | SQLite 向量库 (mem0) | 永久 | ~ 10ms | 用户偏好、长期知识、语义搜索 |
| **T3** | Markdown 记忆 | 文件系统 | 永久 | ~ 5ms | 结构化笔记、项目文档、知识库 |

#### T0 工作记忆（Working Memory）

- 纯内存存储，零序列化开销
- 维护当前会话的完整对话历史
- 工具调用的中间状态暂存
- 进程重启后自动清空

#### T1 短期记忆（Short-Term Memory）

- 基于 SQLite 的 KV 存储
- 每条记录带 TTL，默认 30 分钟过期
- 后台定时清理过期数据
- 用于缓存近期对话的关键信息

#### T2 向量记忆（mem0 Memory）

- 基于 mem0ai v2.3.0 OSS 版本
- 使用 `bun:sqlite` shim 替代 `better-sqlite3`，无需原生编译
- Embedding 模型：`Xenova/multilingual-e5-small`（384 维，本地推理）
- 支持混合搜索（向量相似度 + 关键词匹配）
- MMR（最大边际相关性）重排序，减少结果冗余
- 用户画像自动提取与更新

#### T3 Markdown 记忆（Markdown Memory）

- 以 Markdown 文件存储结构化知识
- 支持目录层级组织
- 文件级别的读写操作
- 适合存储项目文档、技术笔记等长文本

#### 上下文预算管理

`ContextBudget` 组件根据模型的上下文窗口大小，动态分配各级记忆的 Token 预算：

```typescript
// 预算分配示例
{
  systemPrompt: 2000,    // 系统提示词
  workingMemory: 4000,   // T0 工作记忆
  shortTermMemory: 2000, // T1 短期记忆
  longTermMemory: 3000,  // T2 向量记忆
  tools: 1000,           // 工具定义
  userMessage: 4000      // 用户消息
}
```

#### 数据目录

```
data/
├── flash-claw.db          # SQLite 主数据库（T1 短期记忆 + 任务调度）
├── mem0/                  # T2 向量记忆数据
│   └── vectors.db         # 向量索引
├── memory/                # T3 Markdown 记忆
│   ├── notes/
│   └── profiles/
└── models/                # 本地 Embedding 模型缓存
    └── Xenova/
        └── multilingual-e5-small/
```

---

### 自进化系统

自进化系统（Evolution System）是 Flash-Claw 的独特能力——智能体可以从每一次对话交互中学习，自主改进自身行为。

#### 工作原理

```
对话完成
  │
  ▼
反馈分析器（Feedback Analyzer）
  │  ├─ 规则引擎：模式匹配、关键词检测
  │  └─ LLM 引擎：深度语义分析用户满意度
  │
  ▼
反馈信号（正向 / 负向 / 中性）
  │
  ▼
策略规划器（Strategy Planner）
  │  ├─ 分析反馈趋势
  │  ├─ 识别薄弱环节
  │  └─ 生成改进策略
  │
  ▼
进化执行
  ├─ 调整提示词策略
  ├─ 优化工具选择偏好
  └─ 更新记忆检索权重
```

#### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **进化引擎** | `evolution-engine.ts` | 协调整个进化流程，管理进化周期 |
| **反馈分析器** | `feedback-analyzer.ts` | 双引擎分析（规则 + LLM），从对话中提取反馈信号 |
| **策略规划器** | `strategy-planner.ts` | 基于反馈趋势规划进化策略，生成可执行的改进方案 |

#### 反馈分析双引擎

**规则引擎**：基于预定义模式快速检测明确的反馈信号

- 关键词匹配（如「谢谢」→ 正向，「不对」→ 负向）
- 对话模式识别（如重复提问 → 理解不足）
- 工具调用成功率统计

**LLM 引擎**：深度分析对话语义，捕捉隐含的用户满意度

- 上下文理解用户意图是否被满足
- 分析回答质量与用户期望的差距
- 提取可改进的具体方向

#### 进化策略示例

```typescript
// 策略规划器可能生成的改进方案
{
  type: 'prompt_optimization',
  target: 'code_generation',
  action: '增加代码示例中的注释密度',
  confidence: 0.85,
  evidence: '最近 20 次代码生成对话中，用户追问代码含义的比例达 40%'
}
```

---

### 工具系统

Flash-Claw 提供 8 个内置工具，覆盖文件操作、代码执行与信息检索：

| 工具 | 函数名 | 描述 | 安全等级 |
|------|--------|------|----------|
| **Bash** | `bash` | 执行 shell 命令 | 高风险（沙箱可选） |
| **读文件** | `read_file` | 读取指定路径的文件内容 | 低风险 |
| **写文件** | `write_file` | 创建或覆盖写入文件 | 中风险 |
| **编辑文件** | `edit_file` | 基于查找替换的精确编辑 | 中风险 |
| **Glob** | `glob` | 文件模式匹配搜索 | 低风险 |
| **Grep** | `grep` | 文件内容正则搜索 | 低风险 |
| **Web 搜索** | `web_search` | 互联网搜索（Tavily API） | 低风险 |
| **Web 抓取** | `web_fetch` | 网页内容抓取（Playwright + Readability） | 低风险 |

#### 工具执行流程

```
ChatEngine 请求工具调用
  │
  ▼
ToolExecutor（安全检查）
  ├─ 路径边界检查
  ├─ 命令安全过滤
  └─ 速率限制
  │
  ▼
ToolRegistry → 查找工具实现
  │
  ▼
执行工具 → 返回结果
```

#### Docker 沙箱

对于高风险操作（如 `bash`），可启用 Docker 沙箱隔离：

```bash
# .env 配置
SANDBOX_ENABLED=true
SANDBOX_IMAGE=flash-claw-sandbox:latest
```

---

### 安全层

安全是 Flash-Claw 的核心设计原则之一。多层安全机制协同工作：

| 安全机制 | 模块 | 说明 |
|----------|------|------|
| **路径边界检查** | `infra/fs/boundary.ts` | 限制文件操作在允许的目录范围内 |
| **命令安全过滤** | `security/` | 拦截危险命令（如 `rm -rf /`） |
| **速率限制** | `security/` | 防止工具调用过于频繁 |
| **SSRF 防护** | `infra/net/ssrf.ts` | 阻止对内网地址的请求 |
| **审计日志** | `security/` | 记录所有工具调用与敏感操作 |

---

## Skill 系统

Flash-Claw 的 Skill 系统遵循 **Claude Code Agent Skills 标准**，以 `SKILL.md` 文件定义技能的触发条件、执行逻辑和输出格式。

### 内置 10 个 Skills

| Skill | 说明 |
|-------|------|
| `git-commit` | 智能 Git 提交（分析 diff、生成 commit message） |
| `doc-writer` | 文档生成（README、API 文档、技术方案） |
| `test-generator` | 测试用例生成 |
| `code-review` | 代码审查（安全、性能、最佳实践） |
| `feishu-doc` | 飞书文档操作 |
| `feishu-drive` | 飞书云盘操作 |
| `feishu-perm` | 飞书权限管理 |
| `feishu-wiki` | 飞书知识库操作 |
| `wechat-fetcher` | 微信公众号内容抓取 |
| `skill-creator` | Skill 自创建（元技能） |

### Skill 定义格式

每个 Skill 是一个目录，包含 `SKILL.md` 和可选的辅助脚本：

```
skills/
├── git-commit/
│   └── SKILL.md
├── doc-writer/
│   └── SKILL.md
├── test-generator/
│   └── SKILL.md
└── ...
```

---

## 任务调度

任务调度系统支持自然语言创建定时任务，底层使用 JSON 文件持久化存储。

### 三种调度模式

| 模式 | 说明 | 示例 |
|------|------|------|
| **cron** | 标准 cron 表达式 | `0 9 * * 1-5`（工作日早 9 点） |
| **interval** | 固定间隔 | 每 30 分钟执行一次 |
| **one-time** | 一次性定时 | 明天下午 3 点执行 |

### 自然语言解析

用户可以直接用自然语言创建任务，LLM 智能解析意图：

```
用户：每天早上 9 点帮我检查一下服务器状态
Flash-Claw：已创建定时任务
  - 模式：cron
  - 表达式：0 9 * * *
  - 描述：检查服务器状态
```

支持中文、英文等多语言输入。`cronToHumanReadable` 工具可将 cron 表达式转为人类可读描述。

---

## 飞书集成

Flash-Claw 支持两种飞书接入模式：

### Webhook 模式

- 配置飞书事件订阅回调 URL
- 适合简单场景，无需维护长连接
- 支持消息事件、卡片交互

### WebSocket 长连接模式

- 基于飞书开放平台 WebSocket 协议
- 自动重连、心跳保活
- 适合高实时性场景

### 配置

```bash
# .env
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
FEISHU_ENCRYPT_KEY=xxxxx          # 可选，事件加密
FEISHU_VERIFICATION_TOKEN=xxxxx   # 可选，事件验证

# 连接模式（二选一）
FEISHU_MODE=webhook               # 或 websocket
FEISHU_WEBHOOK_PORT=3001          # webhook 模式端口
```

---

## Heartbeat 心跳系统

心跳系统提供定期健康检查与自动恢复能力：

- 定时检查各服务组件的运行状态
- 异常时自动尝试恢复
- 通过事件总线广播健康状态变化
- 集成到 DI 容器，随应用生命周期启停

---

## API 接口

### 对话

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/chat` | 发送对话消息 |
| `POST` | `/api/chat/stream` | 流式对话（SSE） |
| `GET` | `/api/chat/history` | 获取对话历史 |
| `DELETE` | `/api/chat/history` | 清除对话历史 |

### 记忆

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/memory` | 获取记忆列表 |
| `POST` | `/api/memory` | 写入记忆 |
| `DELETE` | `/api/memory/:id` | 删除指定记忆 |
| `GET` | `/api/memory/search` | 搜索记忆 |

### 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/tasks` | 获取任务列表 |
| `POST` | `/api/tasks` | 创建任务 |
| `PUT` | `/api/tasks/:id` | 更新任务 |
| `DELETE` | `/api/tasks/:id` | 删除任务 |

### 工具

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/tools` | 获取可用工具列表 |
| `POST` | `/api/tools/execute` | 执行指定工具 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/status` | 系统状态 |

### 飞书

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/feishu/webhook` | 飞书事件回调 |

---

## CLI 命令

```bash
# 开发模式（后端 + 前端热重载）
bun run dev

# 构建前端
bun run build:web

# 生产模式启动
bun run start

# 发布新版本
bun run release

# 运行测试
bun run test

# 单次运行测试（不 watch）
bun run test:run

# 类型检查
bun run typecheck
```

---

## 项目结构

```
flash-claw/
├── src/
│   ├── core/
│   │   └── container/               # DI 容器系统
│   │       ├── container.ts          #   IoC 容器（循环检测、生命周期、有序销毁）
│   │       ├── tokens.ts             #   27 个接口 + 24 个 ServiceToken
│   │       ├── bootstrap.ts          #   服务注册与启动引导
│   │       └── types.ts              #   基础类型定义
│   │
│   ├── chat/                         # 对话引擎
│   │   ├── engine.ts                 #   ChatEngine 核心（多步工具循环）
│   │   ├── llm-parser.ts            #   LLM 智能任务解析 + 记忆查询重写
│   │   └── parsers.ts               #   cronToHumanReadable 等工具函数
│   │
│   ├── memory/                       # 四级记忆系统
│   │   ├── working-memory.ts         #   T0 工作记忆（内存，会话级）
│   │   ├── short-term-memory.ts      #   T1 短期记忆（SQLite，30 分钟过期）
│   │   ├── mem0-memory-manager.ts    #   T2 mem0 记忆（SQLite 向量库，永久）
│   │   ├── markdown-memory.ts        #   T3 Markdown 记忆（文件，永久）
│   │   ├── memory-manager.ts         #   记忆管理门面
│   │   ├── long-term-memory.ts       #   长期记忆
│   │   ├── vector-store.ts           #   向量存储（混合搜索 + MMR 重排序）
│   │   ├── context-budget.ts         #   上下文令牌预算分配
│   │   ├── user-profile.ts           #   用户画像
│   │   ├── daily-summarizer.ts       #   每日摘要器
│   │   └── embedding/                #   嵌入服务
│   │
│   ├── tools/                        # 工具系统
│   │   ├── bash.ts                   #   Shell 命令执行
│   │   ├── read-file.ts              #   文件读取
│   │   ├── write-file.ts             #   文件写入
│   │   ├── edit-file.ts              #   文件编辑（查找替换）
│   │   ├── glob.ts                   #   文件模式匹配
│   │   ├── grep.ts                   #   内容搜索
│   │   ├── web-search.ts             #   互联网搜索（Tavily）
│   │   ├── web-fetch.ts              #   网页抓取（Playwright + Readability）
│   │   ├── tool-registry.ts          #   工具注册表
│   │   ├── tool-executor.ts          #   工具执行器（含安全层）
│   │   ├── legacy-adapter.ts         #   旧工具适配器
│   │   └── sandbox/                  #   Docker 沙箱支持
│   │
│   ├── evolution/                    # 自进化系统
│   │   ├── evolution-engine.ts       #   进化引擎核心
│   │   ├── feedback-analyzer.ts      #   对话反馈分析（规则 + LLM 双引擎）
│   │   ├── strategy-planner.ts       #   进化策略规划
│   │   └── types.ts                  #   类型定义
│   │
│   ├── agent/                        # 智能体
│   │   └── prompt-builder.ts         #   提示词构建器（令牌预算分配）
│   │
│   ├── skills/                       # Skill 系统（Claude Code Agent Skills 标准）
│   │   ├── git-commit/
│   │   ├── doc-writer/
│   │   ├── test-generator/
│   │   ├── code-review/
│   │   ├── feishu-doc/
│   │   ├── feishu-drive/
│   │   ├── feishu-perm/
│   │   ├── feishu-wiki/
│   │   ├── wechat-fetcher/
│   │   └── skill-creator/
│   │
│   ├── tasks/                        # 任务调度系统
│   │                                 #   JSON 存储 / cron+interval+one-time
│   │
│   ├── integrations/                 # 飞书集成
│   │                                 #   Webhook + WebSocket 双模式
│   │
│   ├── heartbeat/                    # 心跳系统
│   │
│   ├── subagents/                    # 子智能体系统
│   │
│   ├── security/                     # 安全层
│   │                                 #   路径边界、命令安全、速率限制、审计日志
│   │
│   ├── infra/                        # 基础设施
│   │   ├── hono-app.ts               #   HTTP 服务器（Hono）
│   │   ├── error-handler.ts          #   全局错误处理
│   │   ├── fs/
│   │   │   └── boundary.ts           #   文件系统边界检查
│   │   └── net/
│   │       └── ssrf.ts               #   SSRF 防护
│   │
│   ├── web/                          # React 前端（Vite）
│   │
│   └── config/                       # 配置
│       └── config.ts                 #   应用配置（被 bootstrap 引用）
│
├── data/                             # 运行时数据（自动生成）
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 环境变量

### 必需

| 变量 | 说明 | 示例 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 阿里云百炼 / DashScope API Key | `sk-xxxxx` |

### AI 模型

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MODEL_NAME` | 主模型名称 | `qwen-max` |
| `BASE_URL` | OpenAI 兼容 API 地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

### 工具 API

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TAVILY_API_KEY` | Tavily 搜索 API Key | — |

### 飞书

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 ID | — |
| `FEISHU_APP_SECRET` | 飞书应用 Secret | — |
| `FEISHU_ENCRYPT_KEY` | 事件加密 Key | — |
| `FEISHU_VERIFICATION_TOKEN` | 事件验证 Token | — |
| `FEISHU_MODE` | 连接模式（`webhook` / `websocket`） | `webhook` |

### 服务器

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | HTTP 服务端口 | `3000` |
| `HOST` | 绑定地址 | `0.0.0.0` |

### 安全

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SANDBOX_ENABLED` | 是否启用 Docker 沙箱 | `false` |
| `SANDBOX_IMAGE` | 沙箱 Docker 镜像 | `flash-claw-sandbox:latest` |
| `ALLOWED_PATHS` | 允许操作的路径（逗号分隔） | — |

### 记忆

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EMBEDDING_MODEL` | Embedding 模型 | `Xenova/multilingual-e5-small` |
| `DATA_DIR` | 数据存储目录 | `./data` |

---

## 发布

使用内置的发布脚本：

```bash
# 发布新版本（自动 bump 版本号、生成 changelog、打 tag）
bun run release
```

发布流程：
1. 运行类型检查（`typecheck`）
2. 运行测试（`test:run`）
3. 构建前端（`build:web`）
4. 更新版本号
5. 生成 Changelog
6. 创建 Git Tag
7. 推送到远程仓库

---

## 许可证

[MIT](LICENSE)
