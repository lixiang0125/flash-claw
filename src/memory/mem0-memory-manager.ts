/**
 * @module Mem0MemoryManager
 * @description 长期记忆管理器模块 —— 四级记忆体系的协调层。
 *
 * 本模块实现了基于 mem0 向量数据库的长期记忆管理，同时作为
 * 四级记忆体系的协调器，统一管理工作记忆、短期记忆、
 * Markdown 文件记忆和 mem0 向量记忆的存储与检索。
 *
 * 四级记忆体系：
 * 1. **工作记忆**（WorkingMemory）—— 当前请求的上下文窗口
 * 2. **短期记忆**（ShortTermMemory）—— 会话级数据库持久化
 * 3. **Markdown 记忆**（MarkdownMemory）—— 文件系统持久化
 * 4. **长期记忆**（mem0 向量嵌入）—— 语义检索 ← 本模块
 */
import type { Memory } from "mem0ai/oss";
import type { Logger } from "../core/container/tokens";
import type { WorkingMemory, ConversationMessage } from "./working-memory";
import type { ShortTermMemory } from "./short-term-memory";
import type { MarkdownMemory } from "./markdown-memory";
import type { UserProfileService, UserProfile } from "./user-profile";

/**
 * 记忆条目结构。
 *
 * 表示存储在记忆系统中的单条记忆，包含内容、类型、
 * 重要性评分、访问计数等元信息。
 */
export interface MemoryEntry {
  /** 记忆条目的唯一标识。 */
  id: string;
  /** 记忆的文本内容。 */
  content: string;
  /** 记忆类型：对话、事实、偏好、技能使用或任务结果。 */
  type: "conversation" | "fact" | "preference" | "skill_usage" | "task_result";
  /** 关联的用户标识。 */
  userId: string;
  /** 关联的会话标识（可选）。 */
  sessionId?: string;
  /** 记忆创建的时间戳（Unix 毫秒）。 */
  timestamp: number;
  /** 重要性评分（0-1），用于检索时的加权排序。 */
  importance: number;
  /** 被访问的次数。 */
  accessCount: number;
  /** 最后被访问的时间戳（Unix 毫秒）。 */
  lastAccessedAt: number;
  /** 可选的附加元数据。 */
  metadata?: Record<string, unknown>;
}

/**
 * 记忆查询参数。
 *
 * 定义从记忆系统中检索记忆时的查询条件，
 * 支持语义搜索文本、类型过滤、时间范围和相关性阈值。
 */
export interface MemoryQuery {
  /** 语义搜索的查询文本。 */
  text: string;
  /** 关联的用户标识。 */
  userId: string;
  /** 关联的会话标识（可选）。 */
  sessionId?: string;
  /** 可选的记忆类型过滤列表。 */
  types?: MemoryEntry["type"][];
  /** 可选的时间范围过滤（Unix 毫秒）。 */
  timeRange?: { start?: number; end?: number };
  /** 最多返回的结果数量。 */
  limit?: number;
  /** 最低相关性分数阈值（0-1）。 */
  minRelevance?: number;
}

/**
 * 记忆搜索结果。
 *
 * 包含匹配的记忆条目及其综合相关性评分和各维度的分项评分。
 */
export interface MemorySearchResult {
  /** 匹配的记忆条目。 */
  entry: MemoryEntry;
  /** 综合相关性评分（语义 + 时效 + 重要性的加权和）。 */
  relevanceScore: number;
  /** 各维度的分项评分。 */
  scores: {
    /** 语义相似度评分。 */
    semantic: number;
    /** 时效性评分（基于指数衰减）。 */
    recency: number;
    /** 重要性评分。 */
    importance: number;
  };
}

/**
 * 传入消息结构。
 *
 * 表示从外部平台接收到的用户消息，包含发送者信息、
 * 会话标识、来源平台和消息内容。
 */
export interface IncomingMessage {
  /** 消息发送者，包含用户 ID。 */
  sender: { id: string };
  /** 所属会话的唯一标识。 */
  conversationId: string;
  /** 消息来源平台标识（如 'web'、'slack' 等）。 */
  platform: string;
  /** 消息内容，包含可选的文本字段。 */
  content: { text?: string };
}

/**
 * 记忆管理器接口。
 *
 * 定义了记忆系统的核心操作契约，包括存储、检索、
 * 交互记录、用户画像管理和过期清理。
 */
export interface IMemoryManager {
  /**
   * 存储一条记忆条目到记忆系统。
   *
   * @param entry - 记忆条目（不含 id、accessCount、lastAccessedAt，由系统自动生成）
   * @returns 新创建的记忆条目 ID
   */
  store(entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessedAt">): Promise<string>;
  /**
   * 从记忆系统中检索相关记忆。
   *
   * @param query - 查询参数
   * @returns 按相关性排序的搜索结果数组
   */
  recall(query: MemoryQuery): Promise<MemorySearchResult[]>;
  /**
   * 存储一次完整的用户交互（用户消息 + 助手回复）。
   *
   * @param msg - 用户传入消息
   * @param response - 助手的回复文本
   */
  storeInteraction(msg: IncomingMessage, response: string): Promise<void>;
  /**
   * 获取用户画像。
   *
   * @param userId - 用户标识
   * @returns 用户画像对象
   */
  getUserProfile(userId: string): Promise<UserProfile>;
  /**
   * 更新用户画像。
   *
   * @param userId - 用户标识
   * @param updates - 要更新的画像字段
   */
  updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void>;
  /**
   * 清理过期的记忆数据。
   *
   * @param maxAge - 可选的最大保留时间（毫秒）
   * @returns 被清理的记录数量
   */
  cleanup(maxAge?: number): Promise<number>;
}

/**
 * Mem0 记忆管理器配置选项。
 *
 * 控制检索候选倍数、默认返回数量、时效衰减半衰期和评分权重。
 */
interface Mem0MemoryManagerConfig {
  /** 候选结果倍数。实际向 mem0 请求 `limit * multiplier` 条候选，再重排序截取。 */
  candidateMultiplier: number;
  /** 默认返回的最大结果数量。 */
  defaultLimit: number;
  /** 时效衰减的半衰期（小时）。默认 168 小时（7 天）。 */
  decayHalfLifeHours: number;
  /** 各评分维度的权重配置。 */
  weights: {
    /** 语义相似度的权重（默认 0.6）。 */
    semantic: number;
    /** 时效性的权重（默认 0.3）。 */
    recency: number;
    /** 重要性的权重（默认 0.1）。 */
    importance: number;
  };
}

/**
 * Mem0 记忆管理器的默认配置。
 *
 * - `candidateMultiplier`：2 倍候选
 * - `defaultLimit`：10 条
 * - `decayHalfLifeHours`：168 小时（7 天半衰期）
 * - `weights`：语义 0.6、时效 0.3、重要性 0.1
 */
const DEFAULT_CONFIG: Mem0MemoryManagerConfig = {
  candidateMultiplier: 2,
  defaultLimit: 10,
  decayHalfLifeHours: 168,
  weights: { semantic: 0.6, recency: 0.3, importance: 0.1 },
};

/**
 * Mem0-backed memory manager — the **coordination layer** for multi-source recall.
 *
 * Architecture role (orchestrator — delegates to each memory layer):
 *
 *   ┌────────────────────────────────────────────────┐
 *   │              Mem0MemoryManager                  │
 *   │         (orchestrator / query router)           │
 *   ├────────────┬────────────┬───────────┬──────────┤
 *   │ Working    │ ShortTerm  │ mem0      │ Markdown │
 *   │ Memory     │ Memory     │ (vector)  │ Memory   │
 *   │ (session)  │ (SQLite)   │ (LTM)     │ (files)  │
 *   └────────────┴────────────┴───────────┴──────────┘
 *
 * Each layer's responsibility in recall():
 *   - WorkingMemory:   Current session's recent messages (hot buffer, <5 items).
 *                      Already used directly by ChatEngine for context window;
 *                      included here for completeness in cross-source search.
 *   - ShortTermMemory: SQLite-backed session history. Not queried by recall()
 *                      directly (accessed via ChatEngine's history loading).
 *   - mem0 (vector):   Semantic search across all sessions. The primary source
 *                      for cross-session long-term recall.
 *   - MarkdownMemory:  Full-text search over MEMORY.md and daily log files.
 *                      Captures durable facts and daily conversation digests.
 *                      Accessed via searchInFiles(), not in default recall path.
 *
 * Storage flow (storeInteraction):
 *   1. Append to WorkingMemory (immediate, in-process)
 *   2. Persist to ShortTermMemory/SQLite (synchronous)
 *   3. Send to mem0 for LLM extraction (async, non-blocking)
 *   4. Markdown daily logs handled by bootstrap.ts pre-compaction flush
 */
export class Mem0MemoryManager implements IMemoryManager {
  /** 当前生效的配置。 */
  private config: Mem0MemoryManagerConfig;
  /** 日志记录器。 */
  private logger: Logger;
  /** 工作记忆实例（第一级）。 */
  private workingMemory: WorkingMemory;
  /** 短期记忆实例（第二级）。 */
  private shortTermMemory: ShortTermMemory;
  /** mem0 向量记忆实例（第四级）。 */
  private mem0: Memory;
  /** Markdown 文件记忆实例（第三级），可为 null 表示未启用。 */
  private markdownMemory: MarkdownMemory | null;
  /** 用户画像服务实例。 */
  private userProfile: UserProfileService;

  /**
   * 创建 Mem0MemoryManager 实例。
   *
   * @param logger - 日志记录器
   * @param workingMemory - 工作记忆实例（第一级）
   * @param shortTermMemory - 短期记忆实例（第二级）
   * @param mem0 - mem0 向量数据库实例（第四级）
   * @param markdownMemory - Markdown 文件记忆实例（第三级），传入 null 表示未启用
   * @param userProfile - 用户画像服务实例
   * @param config - 可选的配置覆盖项
   */
  constructor(
    logger: Logger,
    workingMemory: WorkingMemory,
    shortTermMemory: ShortTermMemory,
    mem0: Memory,
    markdownMemory: MarkdownMemory | null,
    userProfile: UserProfileService,
    config?: Partial<Mem0MemoryManagerConfig>,
  ) {
    this.logger = logger;
    this.workingMemory = workingMemory;
    this.shortTermMemory = shortTermMemory;
    this.mem0 = mem0;
    this.markdownMemory = markdownMemory;
    this.userProfile = userProfile;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 存储一条记忆条目。
   *
   * 根据重要性评分决定存储策略：
   * - 若关联了会话 ID，同步写入短期记忆（SQLite）
   * - 若重要性 >= 0.3，异步写入 mem0 向量数据库
   *
   * @param entry - 记忆条目（不含 id、accessCount、lastAccessedAt）
   * @returns 新创建的记忆条目 ID
   */
  async store(
    entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessedAt">,
  ): Promise<string> {
    if (entry.sessionId) {
      this.shortTermMemory.saveMessage(entry.sessionId, {
        role: "user",
        content: entry.content,
        timestamp: entry.timestamp,
      });
    }
    if (entry.importance >= 0.3) {
      try {
        const result = await this.mem0.add(entry.content, {
          userId: entry.userId,
          agentId: "flash-claw",
          runId: entry.sessionId || "",
          metadata: { type: entry.type, importance: entry.importance, ...entry.metadata },
        });
        const results = (result as { results?: Array<{ id: string }> })?.results || [];
        return results[0]?.id || crypto.randomUUID();
      } catch (err) {
        this.logger.error("mem0 store (single) failed", { err });
        return crypto.randomUUID();
      }
    }
    return crypto.randomUUID();
  }

  /**
   * Multi-source recall with hash-based deduplication.
   *
   * Query routing:
   *   1. WorkingMemory — current session's recent messages (if sessionId given)
   *   2. mem0 vector search — semantic cross-session long-term recall
   *
   * Note: ShortTermMemory (SQLite) is accessed by ChatEngine directly for
   * session history loading, not through this recall path.
   * MarkdownMemory search is available via searchInFiles() but not included
   * in the default recall to avoid slow filesystem scans on every query.
   */
  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const limit = query.limit || this.config.defaultLimit;

    // --- Layer 1: WorkingMemory (current session hot buffer) ---
    // Fast, in-process lookup. Only includes recent user/assistant messages
    // from the active session. Provides immediate conversational context.
    if (query.sessionId) {
      const recent = this.workingMemory.getRecent(query.sessionId, 5);
      for (const msg of recent) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        results.push({
          entry: {
            id: `wm-${msg.timestamp}`,
            content: msg.content,
            type: "conversation",
            userId: query.userId,
            sessionId: query.sessionId,
            timestamp: msg.timestamp,
            importance: 0.8,
            accessCount: 0,
            lastAccessedAt: Date.now(),
          },
          relevanceScore: 0.9,
          scores: { semantic: 0.9, recency: 1.0, importance: 0.8 },
        });
      }
    }

    // --- Layer 2: mem0 vector search (cross-session long-term memory) ---
    // Semantic similarity search over all stored memories. Returns candidates
    // ranked by embedding distance, then re-scored with recency/importance.
    try {
      const mem0Results = await this.mem0.search(query.text, {
        userId: query.userId,
        agentId: "flash-claw",
        limit: limit * this.config.candidateMultiplier,
      });
      const items = (mem0Results as unknown as { results?: Array<Record<string, unknown>> })?.results || [];
      for (const item of items) {
        results.push(this.toSearchResult(item, query));
      }
    } catch (err) {
      this.logger.error("mem0 search failed", { err, query: query.text });
    }

    return this.deduplicateResults(results, limit);
  }

  /**
   * 存储一次完整的用户交互。
   *
   * 存储流程：
   * 1. 追加到工作记忆（即时、进程内）
   * 2. 持久化到短期记忆 / SQLite（同步）
   * 3. 发送到 mem0 进行 LLM 提取（异步、非阻塞）
   *
   * @param msg - 用户传入消息
   * @param response - 助手的回复文本
   */
  async storeInteraction(msg: IncomingMessage, response: string): Promise<void> {
    const userId = msg.sender.id;
    const sessionId = msg.conversationId;
    const userText = msg.content.text ?? "";
    const now = Date.now();
    this.workingMemory.append(sessionId, { role: "user", content: userText, timestamp: now });
    this.workingMemory.append(sessionId, { role: "assistant", content: response, timestamp: now });
    await this.workingMemory.tryFlush(sessionId);
    this.shortTermMemory.upsertSession(sessionId, userId, msg.platform);
    this.shortTermMemory.saveMessage(sessionId, { role: "user", content: userText, timestamp: now });
    this.shortTermMemory.saveMessage(sessionId, { role: "assistant", content: response, timestamp: now });
    // mem0 LLM extraction (async, non-blocking)
    this.storeTomem0(userText, response, userId, sessionId).catch((err) =>
      this.logger.error("mem0 store failed", { err }),
    );
    // NOTE: Markdown daily logs are handled by pre-compaction agentic flush
    // in bootstrap.ts, not here. No idle-timer or per-message buffering needed.
  }

  /**
   * 将用户对话发送到 mem0 进行 LLM 记忆提取。
   *
   * mem0 会利用 LLM 从对话中自动提取事实、偏好等记忆，
   * 并以向量形式存储，支持后续的语义检索。
   *
   * @param userMessage - 用户消息文本
   * @param assistantResponse - 助手回复文本
   * @param userId - 用户标识
   * @param sessionId - 会话标识
   * @private
   */
  private async storeTomem0(userMessage: string, assistantResponse: string, userId: string, sessionId: string): Promise<void> {
    const messages = [
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantResponse },
    ];
    const result = await this.mem0.add(messages, {
      userId,
      agentId: "flash-claw",
      runId: sessionId,
      metadata: { source: "chat", timestamp: Date.now() },
    });
    const results = (result as unknown as { results?: Array<{ event: string }> })?.results || [];
    const stats = {
      added: results.filter((r) => r.event === "ADD").length,
      updated: results.filter((r) => r.event === "UPDATE").length,
      deleted: results.filter((r) => r.event === "DELETE").length,
      noop: results.filter((r) => r.event === "NONE").length,
    };
    this.logger.info("mem0 store completed", { userId, sessionId, ...stats });
  }

  /**
   * 将 mem0 返回的原始搜索结果转换为标准的 MemorySearchResult 格式。
   *
   * 计算综合评分：语义相似度 * 权重 + 时效衰减 * 权重 + 重要性 * 权重。
   * 时效衰减采用指数衰减模型，半衰期由配置的 `decayHalfLifeHours` 决定。
   *
   * @param item - mem0 返回的原始记录
   * @param query - 原始查询参数
   * @returns 标准化的搜索结果
   * @private
   */
  private toSearchResult(item: Record<string, unknown>, query: MemoryQuery): MemorySearchResult {
    const now = Date.now();
    const createdAt = item.created_at ? new Date(item.created_at as string).getTime() : now;
    const ageMs = now - createdAt;
    const halfLifeMs = this.config.decayHalfLifeHours * 3600 * 1000;
    const semanticScore = (item.score as number) ?? 0;
    const recencyScore = Math.exp((-0.693 * ageMs) / halfLifeMs);
    const importanceScore = ((item.metadata as Record<string, unknown>)?.importance as number) ?? 0.5;
    const { weights } = this.config;
    const relevanceScore = semanticScore * weights.semantic + recencyScore * weights.recency + importanceScore * weights.importance;
    return {
      entry: {
        id: (item.id as string) || "",
        content: (item.memory as string) || "",
        type: ((item.metadata as Record<string, unknown>)?.type as MemoryEntry["type"]) || "fact",
        userId: (item.user_id as string) || query.userId,
        sessionId: (item.metadata as Record<string, unknown>)?.session_id as string,
        timestamp: createdAt,
        importance: importanceScore,
        accessCount: 0,
        lastAccessedAt: now,
        metadata: item.metadata as Record<string, unknown>,
      },
      relevanceScore,
      scores: { semantic: semanticScore, recency: recencyScore, importance: importanceScore },
    };
  }

  /**
   * Hash-based deduplication with substring containment check.
   *
   * Replaces the previous simple Set<prefix> approach with a two-tier strategy:
   *
   * Tier 1 — Normalized prefix key (O(1) lookup):
   *   Normalize content (trim, lowercase, collapse whitespace), then use the
   *   first 100 chars as a hash key. Exact prefix matches are caught instantly.
   *
   * Tier 2 — Substring containment (O(n) per new entry, but n is small):
   *   For entries that survive Tier 1, check if the normalized content is a
   *   substring of any already-seen entry (or vice versa). This catches cases
   *   like "user prefers dark mode" vs "user prefers dark mode for all apps"
   *   without the O(n^2) cost of Levenshtein distance.
   *
   * In both tiers, the result with the higher relevanceScore wins.
   *
   * Complexity: O(n * k) where n = number of results, k = average size of
   * `seen` map. Since k is bounded by `limit` (typically 10-20), this is
   * effectively O(n) for practical workloads.
   */
  private deduplicateResults(results: MemorySearchResult[], limit: number): MemorySearchResult[] {
    const seen = new Map<string, MemorySearchResult>();

    for (const result of results) {
      // Normalize: trim, lowercase, collapse whitespace
      const normalizedContent = result.entry.content.trim().toLowerCase().replace(/\s+/g, ' ');
      const key = normalizedContent.substring(0, 100);

      if (seen.has(key)) {
        // Tier 1: exact prefix match — keep higher score
        const existing = seen.get(key)!;
        if (result.relevanceScore > existing.relevanceScore) {
          seen.set(key, result);
        }
      } else {
        // Tier 2: substring containment check against existing entries
        let isDuplicate = false;
        for (const [existingKey, existing] of seen) {
          if (normalizedContent.includes(existingKey) || existingKey.includes(normalizedContent)) {
            // One is a substring of the other — treat as duplicate
            if (result.relevanceScore > existing.relevanceScore) {
              seen.delete(existingKey);
              seen.set(key, result);
            }
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          seen.set(key, result);
        }
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  /**
   * 获取用户画像。
   *
   * @param userId - 用户标识
   * @returns 用户画像对象
   */
  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.userProfile.getProfile(userId);
  }

  /**
   * 更新用户画像。
   *
   * @param userId - 用户标识
   * @param updates - 要更新的画像字段
   */
  async updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    return this.userProfile.updateProfile(userId, updates);
  }

  /**
   * 清理过期的记忆数据。
   *
   * 委托给短期记忆的 cleanup 方法执行实际清理。
   *
   * @param maxAge - 可选的最大保留时间（毫秒）
   * @returns 被清理的记录数量
   */
  async cleanup(maxAge?: number): Promise<number> {
    return this.shortTermMemory.cleanup();
  }

  /** 根据 ID 获取单条 mem0 记忆。@param memoryId - 记忆条目 ID */
  async getMemory(memoryId: string) { return this.mem0.get(memoryId); }
  /** 更新指定 mem0 记忆的内容。@param memoryId - 记忆条目 ID @param content - 新的记忆内容 */
  async updateMemory(memoryId: string, content: string) { return this.mem0.update(memoryId, content); }
  /** 删除指定的 mem0 记忆。@param memoryId - 记忆条目 ID */
  async deleteMemory(memoryId: string) { return this.mem0.delete(memoryId); }
  /** 删除指定用户的所有 mem0 记忆。@param userId - 用户标识 */
  async deleteAllMemories(userId: string) { return this.mem0.deleteAll({ userId, agentId: "flash-claw" }); }
  /** 列出指定用户的所有 mem0 记忆。@param userId - 用户标识 @param limit - 最大返回数量，默认 100 */
  async listMemories(userId: string, limit = 100) { return this.mem0.getAll({ userId, agentId: "flash-claw", limit }); }
  /** 获取指定记忆的变更历史。@param memoryId - 记忆条目 ID */
  async getMemoryHistory(memoryId: string) { return this.mem0.history(memoryId); }

  /**
   * 重置会话：将工作记忆中的对话刷写到长期记忆后清空。
   *
   * 当用户开始新会话或执行 `/new`、`/reset` 命令时触发。
   * 确保会话中的重要记忆在清空前被持久化。
   *
   * @param sessionId - 要重置的会话标识
   */
  async resetSession(sessionId: string): Promise<void> {
    this.logger.info("Session reset triggered, flushing memories", { sessionId: sessionId.slice(0, 8) });
    await this.workingMemory.resetSession(sessionId);
  }
}
