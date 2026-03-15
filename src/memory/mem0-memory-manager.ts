import type { Memory } from "mem0ai/oss";
import type { Logger } from "../core/container/tokens";
import type { WorkingMemory, ConversationMessage } from "./working-memory";
import type { ShortTermMemory } from "./short-term-memory";
import type { MarkdownMemory } from "./markdown-memory";
import type { UserProfileService, UserProfile } from "./user-profile";

export interface MemoryEntry {
  id: string;
  content: string;
  type: "conversation" | "fact" | "preference" | "skill_usage" | "task_result";
  userId: string;
  sessionId?: string;
  timestamp: number;
  importance: number;
  accessCount: number;
  lastAccessedAt: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  text: string;
  userId: string;
  sessionId?: string;
  types?: MemoryEntry["type"][];
  timeRange?: { start?: number; end?: number };
  limit?: number;
  minRelevance?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  relevanceScore: number;
  scores: {
    semantic: number;
    recency: number;
    importance: number;
  };
}

export interface IncomingMessage {
  sender: { id: string };
  conversationId: string;
  platform: string;
  content: { text?: string };
}

export interface IMemoryManager {
  store(entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessedAt">): Promise<string>;
  recall(query: MemoryQuery): Promise<MemorySearchResult[]>;
  storeInteraction(msg: IncomingMessage, response: string): Promise<void>;
  getUserProfile(userId: string): Promise<UserProfile>;
  updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void>;
  cleanup(maxAge?: number): Promise<number>;
}

interface Mem0MemoryManagerConfig {
  candidateMultiplier: number;
  defaultLimit: number;
  decayHalfLifeHours: number;
  weights: {
    semantic: number;
    recency: number;
    importance: number;
  };
}

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
  private config: Mem0MemoryManagerConfig;
  private logger: Logger;
  private workingMemory: WorkingMemory;
  private shortTermMemory: ShortTermMemory;
  private mem0: Memory;
  private markdownMemory: MarkdownMemory | null;
  private userProfile: UserProfileService;

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

  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.userProfile.getProfile(userId);
  }

  async updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    return this.userProfile.updateProfile(userId, updates);
  }

  async cleanup(maxAge?: number): Promise<number> {
    return this.shortTermMemory.cleanup();
  }

  async getMemory(memoryId: string) { return this.mem0.get(memoryId); }
  async updateMemory(memoryId: string, content: string) { return this.mem0.update(memoryId, content); }
  async deleteMemory(memoryId: string) { return this.mem0.delete(memoryId); }
  async deleteAllMemories(userId: string) { return this.mem0.deleteAll({ userId, agentId: "flash-claw" }); }
  async listMemories(userId: string, limit = 100) { return this.mem0.getAll({ userId, agentId: "flash-claw", limit }); }
  async getMemoryHistory(memoryId: string) { return this.mem0.history(memoryId); }

  /**
   * Session reset: flush working memory through agentic extraction, then clear.
   * Called when user starts a new session or explicitly resets.
   * (OpenClaw trigger #3: session save on /new or /reset)
   */
  async resetSession(sessionId: string): Promise<void> {
    this.logger.info("Session reset triggered, flushing memories", { sessionId: sessionId.slice(0, 8) });
    await this.workingMemory.resetSession(sessionId);
  }
}
