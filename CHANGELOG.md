# Changelog

## 2026-03-15 (8)

### LLM-based task parsing, JSON storage, memory query rewriting

**Motivation**: Regex-based task parsing cannot handle multilingual input. SQLite storage is opaque. Hardcoded memory search keywords only work for Chinese.

**Changes**:

- **`src/chat/llm-parser.ts`** (new implementation):
  - `parseTaskWithLLM(message)` — LLM-based task scheduling intent detection
  - Handles any language (Chinese, English, Japanese, Korean, etc.)
  - Returns structured `ParsedTask` with cron expression or executeAfter (ms)
  - Distinguishes past-tense ("3 minutes ago") from future scheduling ("in 3 minutes")
  - Low temperature (0.1), short max_tokens (200), 10s timeout for speed
  - `rewriteMemoryQuery(message)` — LLM-based memory search query rewriting
  - Generates 3-5 language-agnostic keywords for vector memory retrieval
  - Replaces hardcoded Chinese regex patterns in `buildMemorySearchText()`

- **`src/tasks/index.ts`** (rewritten — JSON storage):
  - Replaced SQLite (`bun:sqlite`) with `data/cron/jobs.json` file storage
  - OpenClaw-compatible JSON structure: `{version, jobs: [{id, name, schedule, state, runs}]}`
  - Three schedule kinds: `cron` (recurring), `every` (interval), `at` (one-time)
  - Human-readable 2-space-indented JSON, git-friendly
  - Task runs stored inline per job (last 50, auto-pruned)
  - All scheduling logic preserved (concurrent guard, 24h setTimeout cap, poll)
  - All public API unchanged

- **`src/chat/engine.ts`** (updated):
  - `parseAndScheduleTask()` now calls `parseTaskWithLLM()` instead of regex `parseTaskFromMessage()`
  - Memory recall now calls `rewriteMemoryQuery()` instead of `buildMemorySearchText()`
  - Removed `buildMemorySearchText()` method entirely

## 2026-03-14 (7)

### Cron task system audit & fix

**Problem**: The cron/task subsystem had multiple critical bugs — circular dependency with chatEngine, no concurrency guard, setTimeout overflow for long delays, false-positive task parsing, and no DI wiring.

**Changes**:

- **`src/tasks/index.ts`** (rewritten):
  - Replaced hard imports of chatEngine/feishuBot with DI callbacks (`setExecutor()`, `setNotifier()`)
  - `start()` is now explicit (no longer auto-called in constructor)
  - Added concurrent execution guard (`executing: Set<string>`)
  - Capped `setTimeout` at 24h with re-evaluation (avoids JS 2^31 ms overflow)
  - One-time tasks disabled instead of deleted (preserves run history)
  - Cron validation on create/update via `CronExpressionParser.parse()`
  - `pollMissedTasks()` respects executing guard
  - Added `ON DELETE CASCADE` for task_runs foreign key

- **`src/chat/parsers.ts`** (rewritten):
  - Added TASK_INTENT gate (must contain task-intent keywords to avoid false positives)
  - One-time patterns require explicit "后/之后" suffix
  - Reasonable bounds: minutes 1-10080, hours 1-168, days 1-30
  - Weekly patterns: "每周一/二/三..." with proper day-of-week mapping
  - AM/PM handling: "下午3点" -> hour 15, "晚上8点" -> hour 20
  - Minute precision: "每天9:30" -> `30 9 * * *`
  - Fixed `cronToHumanReadable` to handle all patterns including weekly

- **`src/chat/engine.ts`** (fixed):
  - Removed hard `taskScheduler` import (was a circular dependency risk)
  - Added `setTaskScheduler()` DI method
  - `parseAndScheduleTask()` now differentiates one-time (`createOneTimeTask`) vs recurring (`createTask`)
  - Task creation result injected into LLM context for user acknowledgment

- **`src/chat/llm-parser.ts`** (cleaned up):
  - Removed dead keyword check that always returned null
  - Documented as intentional no-op stub for future LLM-based parsing

- **`src/core/container/bootstrap.ts`** (wiring):
  - Wires `taskScheduler.setExecutor()` with chatEngine callback
  - Wires `taskScheduler.setNotifier()` with feishuBot callback
  - Calls `taskScheduler.start()` after container init
  - Calls `chatEngine.setTaskScheduler()` in CHAT_ENGINE factory

- **`src/infra/hono-app.ts`** (API update):
  - `POST /api/tasks` now accepts `executeAfter` (ms) for one-time tasks
  - Validates: must provide either `schedule` (cron) or `executeAfter`, not neither

- **`src/core/container/tokens.ts`** (interface update):
  - `ITaskScheduler`: Added `createOneTimeTask`, `setExecutor`, `setNotifier`, `start`, `stop`

## 2026-03-14 (6)

### Session-reset save + periodic consolidation to MEMORY.md

**Core changes**:

1. **Session-reset save (OpenClaw trigger #3)**: When a session is cleared
   (via `/api/chat/clear` or session timeout), all remaining messages are
   flushed through the agentic memory extraction pipeline before wiping.
   This ensures no conversation is lost on reset.

2. **Periodic consolidation**: On startup, the system checks if MEMORY.md
   was last consolidated before today. If so, it reads the last 7 days of
   daily `.md` logs, sends them to the LLM to extract durable facts (identity,
   preferences, projects, decisions), and appends new findings to MEMORY.md.
   Consolidation markers (`<!-- Consolidated: YYYY-MM-DD -->`) prevent
   redundant runs.

**Modified files**:

| File | Change |
|------|--------|
| `src/memory/working-memory.ts` | New `resetSession()` flushes all messages then clears |
| `src/memory/mem0-memory-manager.ts` | New `resetSession()` delegates to WorkingMemory |
| `src/chat/engine.ts` | `clearSession()` now async, calls `resetSession` first |
| `src/infra/hono-app.ts` | `/api/chat/clear` endpoint awaits clearSession |
| `src/core/container/tokens.ts` | Updated IMemoryManager, IChatEngine, IMarkdownMemory |
| `src/memory/daily-summarizer.ts` | New `consolidateDailyLogs()` for MEMORY.md extraction |
| `src/memory/markdown-memory.ts` | New `readMemoryFile()`, `appendConsolidatedMemory()`, `getLastConsolidationDate()` |
| `src/core/container/init.ts` | Post-init startup consolidation with 24h guard |

**4 memory write triggers now fully implemented** (OpenClaw-inspired):

| # | Trigger | Status |
|---|---------|--------|
| 1 | User explicit command | Existing (mem0 `add`) |
| 2 | Pre-compaction agentic flush | Done in (5) |
| 3 | Session save on reset | **NEW** |
| 4 | Periodic consolidation to MEMORY.md | **NEW** |


## 2026-03-14 (5)

### Pre-compaction Agentic Flush (OpenClaw style)

**Core change**: Markdown daily memory switched from idle-timer summary to
**pre-compaction agentic flush**. When WorkingMemory context is about to
overflow and triggers compression, a silent LLM turn is injected. The LLM
autonomously decides what is worth persisting to `memory/YYYY-MM-DD.md`.
At most once per compaction cycle.

**Inspiration**: OpenClaw's 4 memory write triggers, specifically the
"Pre-compaction memory flush" pattern.

**Modified files**:

| File | Change |
|------|--------|
| `src/memory/daily-summarizer.ts` | Rewritten as pre-compaction extraction agent with `extractMemories()` |
| `src/core/container/init.ts` | Flush callback now uses `DailySummarizer.extractMemories()` with fallback |
| `src/core/container/tokens.ts` | `IMarkdownMemory` interface gains `writeDailySummary()` |
| `src/memory/mem0-memory-manager.ts` | Removed `dailyBuffer`/`summaryTimer`/`bufferForDailySummary` idle-timer |

**Design**:

- LLM decides what matters (not every message gets recorded)
- `NO_REPLY` mechanism: LLM returns nothing if nothing worth saving
- One flush per compaction cycle (`hasFlushedInCompaction` flag)
- Graceful fallback: if LLM call fails, raw messages are appended instead
- Separation of concerns: DI wiring handles flush callback, memory manager focuses on mem0


## 2026-03-14 (4)

### Markdown 记忆改为 LLM 每日摘要

**核心变更**: Markdown 每日记录从逐条消息追加改为 LLM 生成的每日摘要。对话 turn
在内存中缓冲，空闲 5 分钟后触发 DailySummarizer 生成精炼 digest，写入
`data/workspace/memory/YYYY-MM-DD.md`。

**新增文件**:

| 文件 | 说明 |
|------|------|
| `src/memory/daily-summarizer.ts` | DailySummarizer — 使用主 LLM 将对话摘要为结构化 Markdown |

**修改文件**:

| 文件 | 变更说明 |
|------|----------|
| `src/memory/mem0-memory-manager.ts` | 移除逐条 appendMarkdownLog，改为 dailyBuffer + idle timer + flushDailySummary |
| `src/memory/markdown-memory.ts` | 新增 writeDailySummary() 方法（整体覆写而非追加） |
| `src/memory/index.ts` | 导出 DailySummarizer |

**设计要点**:

- **缓冲 + 空闲触发**: 每次 storeInteraction 将 turn 压入 dailyBuffer，重置 5 分钟 idle timer
- **LLM 摘要**: 使用主 LLM (MODEL 变量) 将所有 turns 总结为分类 bullet points
- **覆写模式**: writeDailySummary 整体覆写当天文件，而非追加，保证可读性
- **优雅退出**: flushAllPending() 在进程退出前强制刷写所有缓冲

**验证结果**:

- TypeScript 编译零新增错误 ✅
- DailySummarizer 对 3 轮对话生成了 245 字的结构化摘要 ✅
- 摘要按主题分类（系统配置、待办事项等），非逐条堆砌 ✅

---

## 2026-03-14 (3)

### mem0 LLM 切换为 coding 端点

**核心变更**: mem0 的 LLM 服务从通用 DashScope 端点切换为 coding 端点，复用主 LLM
的 `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `MODEL`，无需额外配置单独的 API key。

**问题**: 之前 mem0 的 LLM 指向 `dashscope.aliyuncs.com/compatible-mode/v1`（通用端点），
但项目的 `OPENAI_API_KEY` 是 coding 专用 key（`sk-sp-*`），只能用于
`coding.dashscope.aliyuncs.com/v1`，导致 `memory.add()` / `memory.search()` 返回 401。

**解决方案**: mem0 LLM 的 baseURL 回退链改为 `MEM0_BASE_URL → OPENAI_BASE_URL → 默认 coding 端点`，
默认使用 `MODEL` 环境变量（qwen3.5-plus），与主聊天模型一致。

**修改文件**:

| 文件 | 变更说明 |
|------|----------|
| `src/memory/mem0-factory.ts` | LLM 默认复用 OPENAI_BASE_URL + MODEL |
| `.env` | 删除 MEM0_BASE_URL 及 MiniMax 残留变量 |
| `.env.example` | 更新说明：LLM 默认复用主配置 |

**验证结果**:

- `memory.add()` 英文/中文 → 成功提取记忆条目 ✅
- `memory.search()` 语义检索 → 返回正确结果，相似度分数合理 ✅
- LLM 智能拆分：\用户住在北京，喜欢周末爬山\ → 拆为两条独立记忆 ✅
- TypeScript 编译零新增错误 ✅

---

## 2026-03-14 (2)

### 本地 Embedding 模型替代线上 API

**核心变更**: 将 mem0 的 Embedding 服务从线上 MiniMax API (embo-01, 1024d) 切换为本地
`@xenova/transformers` 模型 (`Xenova/multilingual-e5-small`, 384d)，消除对外部 Embedding
API 的依赖，数据完全不出本地。

**新增文件**:

| 文件 | 说明 |
|------|------|
| `src/memory/local-embedder.ts` | LocalTransformersEmbedder — 封装 @xenova/transformers，提供 mem0 兼容的 embed() 接口 |

**修改文件**:

| 文件 | 变更说明 |
|------|----------|
| `src/memory/mem0-embedder-patch.ts` | 新增 `patchEmbedderLocal()` — 将 mem0 embedder 整体替换为本地实例 |
| `src/memory/mem0-factory.ts` | 支持 `embeddingMode: "local" \| "remote"`，默认 local；使用 `Xenova/multilingual-e5-small` |
| `src/memory/index.ts` | 导出 `LocalTransformersEmbedder` 和 `patchEmbedderLocal` |
| `.env` | 切换为 local 模式，维度 1024 → 384 |
| `.env.example` | 格式与 .env 对齐，添加 local/remote 双模式说明 |

**删除文件**:

| 文件 | 说明 |
|------|------|
| `test-minimax-embed.ts` | 清理 MiniMax 测试文件 |
| `data/mem0_vectors.db*` | 清理旧 1024d 向量库（维度不兼容） |

**技术细节**:

- **模型**: `Xenova/multilingual-e5-small` — 多语言支持，384 维，~100MB ONNX，<0.5B 参数
- **加载策略**: 懒加载 — ONNX pipeline 在首次 embed() 调用时加载，不阻塞启动
- **monkey-patch**: `patchEmbedderLocal()` 直接替换 mem0 Memory 实例的 `embedder` 属性
- **createMem0Memory()** 保持同步返回，DI 容器无需修改
- **向后兼容**: 设置 `MEM0_EMBEDDING_MODE=remote` 可切回线上 API

**验证结果**:

- TypeScript 编译零新增错误 ✅
- `LocalTransformersEmbedder.embed()` 英文/中文均产出 384d 归一化向量 ✅
- `createMem0Memory()` 成功实例化，embedder 被正确替换 ✅
- L2 范数 = 1.000000 ✅

**环境配置说明**:

```
# 本地 Embedding（默认，无需额外 API key）
MEM0_EMBEDDING_MODE=local
MEM0_LOCAL_MODEL=Xenova/multilingual-e5-small
MEM0_EMBEDDING_DIMS=384

# 远程 Embedding（可选）
# MEM0_EMBEDDING_MODE=remote
# MEMO_API_KEY=your-key
# MEM0_EMBEDDING_BASE_URL=https://api.minimax.io/v1
# MEM0_EMBEDDING_MODEL=embo-01
# MEM0_EMBEDDING_DIMS=1024
```

---

## 2026-03-14

### mem0 Bun 运行时兼容性修复 & 数据目录整理

**核心问题**: mem0ai v2.3.0 内部使用 `better-sqlite3` 原生 addon，而 Bun 运行时不支持加载该 addon，导致 `Memory` 实例化时抛出 `ERR_DLOPEN_FAILED` 错误。

**解决方案**: 创建 `better-sqlite3` → `bun:sqlite` 透明 shim，通过 postinstall 脚本自动替换原生模块入口。

**变更文件**:

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `shims/better-sqlite3-bun.js` | 新增 | bun:sqlite shim — 包装 Database/Statement/SqliteError |
| `scripts/patch-better-sqlite3.js` | 新增 | postinstall 脚本，自动替换 node_modules 中的 addon |
| `src/memory/mem0-factory.ts` | 修改 | 新增 `vectorStoreDbPath` 选项，所有 DB 路径指向 `data/` |
| `src/memory/mem0-embedder-patch.ts` | 修改 | 增强 instanceof 检查和幂等性 |
| `src/memory/mem0-memory-manager.ts` | 修改 | 清理无用 import，增强错误处理 |
| `package.json` | 修改 | mem0ai 升级到 ^2.3.0，添加 postinstall hook |
| `.gitignore` | 修改 | 添加 `*.db` / `*.db-shm` / `*.db-wal` 规则 |
| `.env.example` | 修改 | 添加 mem0 专用配置段 (MEM0_BASE_URL 等) |

**Shim 技术细节**:

- `Database` 构造函数：映射 better-sqlite3 选项到 bun:sqlite 选项
- `Statement` 包装器：`run()` / `get()` / `all()` 直接代理
- `pragma()` 方法：通过 `PREPARE 'PRAGMA ...'` 模拟（mem0 未使用）
- `SqliteError`：自定义错误类，保持 `.code` 属性兼容
- BLOB 处理：bun:sqlite 返回 `Uint8Array`，与 `Float32Array` 重建兼容

**数据目录整理**:

- mem0 vector store DB: `./data/mem0_vectors.db`（原先在项目根目录 `vector_store.db`）
- mem0 history DB: `./data/mem0_history.db`（原先 `memory.db`）
- 根目录 `memory.db` / `vector_store.db` 已从 git 移除
- `data/` 目录整体 gitignore，仅初始化逻辑上传远端

**验证结果**:

- `require("better-sqlite3")` → bun:sqlite Database ✅
- `db.exec()` / `db.prepare()` / `stmt.run()` / `stmt.all()` / `stmt.get()` ✅
- `db.transaction()` 批量插入 ✅
- BLOB (Float32Array ↔ Buffer) 读写往返 ✅
- `new Memory({...})` 实例化成功 ✅
- TypeScript 编译零错误 (`src/memory/` 目录) ✅

**环境配置说明**:

mem0 使用通用 DashScope 端点（非 coding 端点），需要在 `.env` 中配置:

```
DASHSCOPE_API_KEY=sk-your-general-dashscope-key
MEM0_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MEM0_LLM_MODEL=qwen-plus
MEM0_EMBEDDING_MODEL=text-embedding-v3
```

> 注意: `coding.dashscope.aliyuncs.com` 端点不支持 embedding 模型，mem0 的 baseURL 不应 fallback 到 `OPENAI_BASE_URL`。

---

## 2026-03-04

**Changed files:**
- CHANGELOG.md
- README.md
- bun.lock
- package.json
- src/core/container/bootstrap.ts
- src/memory/index.ts
- memory.db
- src/memory/mem0-embedder-patch.ts
- src/memory/mem0-factory.ts
- src/memory/mem0-memory-manager.ts
- vector_store.db

# Changelog

All notable changes to this project will be documented in this file.

### mem0 记忆系统接入 (2026-03-04)

**重构完成**:

- **M-31**: 使用 mem0ai OSS 本地模式替代自研 LongTermMemory
- **M-32**: LLM 使用 qwen3.5-plus (dashscope)，支持智能记忆抽取
- **M-33**: Embedding 使用 text-embedding-v3，本地 SQLite 向量存储
- **M-34**: 修复 mem0 OpenAIEmbedder baseURL bug (monkey-patch)
- **M-35**: 删除 @xenova/transformers 和 sqlite-vec 依赖，减小项目体积

**架构变更**:

```
接入前                                    接入后
───────────────────────────              ────────────────────────────
ChatEngine                                ChatEngine
  └─ MemoryManager                          └─ Mem0MemoryManager
       ├─ WorkingMemory (T0, 内存)               ├─ WorkingMemory (T0, 保留)
       ├─ ShortTermMemory (T1, SQLite)           ├─ ShortTermMemory (T1, 保留)
       ├─ LongTermMemory (T2)                    ├─ mem0 Memory (替代 T2)
       │    ├─ VectorStore (sqlite-vec+FTS5)     │    ├─ LLM: qwen3.5-plus
       │    └─ EmbeddingService                  │    ├─ Embedder: text-embedding-v3
       │         ├─ TransformersProvider         │    └─ VectorStore: SQLite 本地
       │         └─ OllamaProvider               ├─ MarkdownMemory (T3, 仅归档)
       └─ MarkdownMemory (T3)                    └─ UserProfile (保留)
            └─ UserProfile
```

**依赖变更**:

| 依赖 | 变化 |
|------|------|
| mem0ai | 新增 |
| @xenova/transformers | 移除 (~200MB) |
| sqlite-vec | 移除 |

---

### Markdown 记忆系统集成 (2026-03-04)

**集成完成**:

- **M-27**: 在 bootstrap.ts 注册 MarkdownMemory 服务
- **M-28**: 添加 WORKSPACE_PATH 环境变量配置
- **M-29**: 预压缩刷写回调集成 - 对话溢出前自动保存到 daily log
- **M-30**: 创建工作区目录和 MEMORY.md 初始化

**工作区结构**:
```
./data/workspace/
├── MEMORY.md              # 长期策划记忆
└── memory/
    └── YYYY-MM-DD.md     # 日记式记录
```

---

### 记忆系统增强 (2026-03-04)

**混合搜索优化**:

- **M-14**: 并集设计 - 向量搜索和 FTS 搜索独立执行、独立失败
- **M-15**: BM25 归一化 - 使用 `1/(1+bm25_rank)` 将排名转换为 0-1 分数
- **M-16**: MMR 重排序 - 基于内容相似度保证结果多样性
- **M-17**: 候选倍增器 - 默认 4 倍，从更多候选中筛选

**预压缩刷写 (Pre-Compaction Flush)**:

- **M-18**: 新增 `setFlushCallback()` 注册刷写回调
- **M-19**: 新增 `shouldFlush()` 检测软阈值（距上限 4000 tokens）
- **M-20**: 新增 `tryFlush()` 在压缩前触发刷写
- **M-21**: 跟踪每个压缩周期，防止重复刷写

**Markdown 文件存储**:

- **M-22**: 新增 `MarkdownMemory` 类
- **M-23**: 支持 MEMORY.md 长期策划记忆
- **M-24**: 支持 memory/YYYY-MM-DD.md 日记式记录
- **M-25**: 会话启动时加载"今天 + 昨天"日志
- **M-26**: 提供关键字搜索功能

---

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
