import type { DatabaseService } from "./short-term-memory";
import type { IEmbeddingService } from "./embedding/types";
import type { VectorStore } from "./vector-store";
import type { Logger } from "./embedding/embedding-service";

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

export interface LongTermMemoryConfig {
  maxEntries: number;
  defaultRecallLimit: number;
  minRelevance: number;
  weights: {
    semantic: number;
    recency: number;
    importance: number;
  };
  decayHalfLifeHours: number;
}

const DEFAULT_LTM_CONFIG: LongTermMemoryConfig = {
  maxEntries: 100_000,
  defaultRecallLimit: 10,
  minRelevance: 0.3,
  weights: {
    semantic: 0.5,
    recency: 0.3,
    importance: 0.2,
  },
  decayHalfLifeHours: 168,
};

export class LongTermMemory {
  private vectorStore: VectorStore;
  private embedder: IEmbeddingService;
  private db: DatabaseService;
  private config: LongTermMemoryConfig;
  private logger: Logger;

  constructor(
    vectorStore: VectorStore,
    embedder: IEmbeddingService,
    db: DatabaseService,
    logger: Logger,
    config?: Partial<LongTermMemoryConfig>,
  ) {
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.db = db;
    this.logger = logger;
    this.config = { ...DEFAULT_LTM_CONFIG, ...config };
  }

  async store(entry: {
    content: string;
    type: MemoryEntry["type"];
    userId: string;
    sessionId?: string;
    importance?: number;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const importance = entry.importance ?? (await this.assessImportance(entry.content));

    let embedding: number[] | null = null;
    if (this.embedder.isReady) {
      try {
        embedding = await this.embedder.embed(entry.content);
      } catch (err) {
        this.logger.warn(`Embedding failed for memory ${id}: ${err}`);
      }
    }

    await this.vectorStore.insert(id, entry.content, entry.type, embedding, {
      userId: entry.userId,
      sessionId: entry.sessionId,
      timestamp: Date.now(),
      importance,
      ...entry.metadata,
    });

    await this.evictIfNeeded(entry.userId);

    this.logger.debug(
      `Long-term memory stored: ${id} (type=${entry.type}, importance=${importance.toFixed(2)})`,
    );

    return id;
  }

  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const limit = query.limit ?? this.config.defaultRecallLimit;
    const minRelevance = query.minRelevance ?? this.config.minRelevance;

    let queryEmbedding: number[] | null = null;
    if (this.embedder.isReady) {
      try {
        queryEmbedding = await this.embedder.embed(query.text);
      } catch {
        // 降级为 FTS-only
      }
    }

    const searchResults = await this.vectorStore.searchHybrid(
      queryEmbedding,
      query.text,
      limit * 3,
      minRelevance,
    );

    if (searchResults.length === 0) return [];

    const ids = searchResults.map((r) => r.id);
    const entries = this.loadEntries(ids, query);

    const now = Date.now();
    const wSemantic = this.config.weights.semantic;
    const wRecency = this.config.weights.recency;
    const wImportance = this.config.weights.importance;
    const halfLifeMs = this.config.decayHalfLifeHours * 60 * 60 * 1000;

    const results: MemorySearchResult[] = entries.map((entry) => {
      const searchResult = searchResults.find((r) => r.id === entry.id);
      const semanticScore = searchResult?.score ?? 0;
      const ageMs = now - entry.timestamp;
      const recencyScore = Math.exp((-0.693 * ageMs) / halfLifeMs);
      const importanceScore = entry.importance;

      const relevanceScore =
        semanticScore * wSemantic + recencyScore * wRecency + importanceScore * wImportance;

      return {
        entry,
        relevanceScore,
        scores: {
          semantic: semanticScore,
          recency: recencyScore,
          importance: importanceScore,
        },
      };
    });

    const topResults = results
      .filter((r) => r.relevanceScore >= minRelevance)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    this.updateAccessCounts(topResults.map((r) => r.entry.id));

    return topResults;
  }

  async extractAndStoreFacts(
    userMessage: string,
    assistantResponse: string,
    userId: string,
    sessionId: string,
  ): Promise<string[]> {
    const storedIds: string[] = [];
    const facts = this.extractFactsFromConversation(userMessage, assistantResponse);

    for (const fact of facts) {
      const existing = await this.recall({
        text: fact.content,
        userId,
        limit: 1,
        minRelevance: 0.9,
      });

      if (existing.length === 0) {
        const id = await this.store({
          content: fact.content,
          type: fact.type,
          userId,
          sessionId,
          importance: fact.importance,
        });
        storedIds.push(id);
      }
    }

    return storedIds;
  }

  private async assessImportance(content: string): Promise<number> {
    let score = 0.3;

    const highImportanceKeywords = [
      "记住",
      "重要",
      "偏好",
      "喜欢",
      "不喜欢",
      "总是",
      "永远",
      "remember",
      "important",
      "prefer",
      "always",
      "never",
    ];
    for (const keyword of highImportanceKeywords) {
      if (content.toLowerCase().includes(keyword)) {
        score += 0.15;
        break;
      }
    }

    if (content.length > 200) score += 0.1;
    if (content.length > 500) score += 0.1;

    if (content.includes("我的名字") || content.includes("my name")) score += 0.2;
    if (content.includes("我住在") || content.includes("I live")) score += 0.15;

    return Math.min(score, 1.0);
  }

  private extractFactsFromConversation(
    userMessage: string,
    assistantResponse: string,
  ): Array<{ content: string; type: MemoryEntry["type"]; importance: number }> {
    const facts: Array<{ content: string; type: MemoryEntry["type"]; importance: number }> =
      [];

    const preferencePatterns = [
      /我(?:喜欢|偏好|习惯|倾向于?|更愿意)(.{5,100})/,
      /我不(?:喜欢|想|要|愿意)(.{5,100})/,
      /(?:请|麻烦)?(?:以后|下次|每次)(?:都)?(.{5,100})/,
      /I (?:prefer|like|want|love|hate|dislike) (.{5,100})/i,
    ];

    for (const pattern of preferencePatterns) {
      const match = userMessage.match(pattern);
      if (match) {
        facts.push({
          content: `用户偏好: ${match[0]}`,
          type: "preference",
          importance: 0.7,
        });
      }
    }

    const factPatterns = [
      /我(?:叫|是|名字是)(.{2,50})/,
      /我(?:在|住在|来自)(.{2,50})/,
      /我(?:的工作是|做|从事)(.{5,100})/,
      /My name is (.{2,50})/i,
      /I (?:work|live|am from|study) (.{5,100})/i,
    ];

    for (const pattern of factPatterns) {
      const match = userMessage.match(pattern);
      if (match) {
        facts.push({
          content: `用户事实: ${match[0]}`,
          type: "fact",
          importance: 0.8,
        });
      }
    }

    if (userMessage.length > 50) {
      facts.push({
        content: `用户: ${userMessage.slice(0, 300)}\nAgent: ${assistantResponse.slice(0, 300)}`,
        type: "conversation",
        importance: 0.4,
      });
    }

    return facts;
  }

  private async evictIfNeeded(userId: string): Promise<void> {
    const count = this.db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM memories WHERE user_id = ?",
      [userId],
    );
    const totalCount = count?.cnt ?? 0;

    if (totalCount <= this.config.maxEntries) return;

    const toEvict = totalCount - this.config.maxEntries + 100;
    const evictIds = this.db.all<{ id: string }>(
      `SELECT id FROM memories
       WHERE user_id = ?
       ORDER BY (importance * 0.5 + (1.0 / (1.0 + (unixepoch('now') * 1000 - last_accessed_at) / 86400000.0))) ASC
       LIMIT ?`,
      [userId, toEvict],
    );

    for (const row of evictIds) {
      await this.vectorStore.delete(row.id);
    }

    this.logger.info(`Evicted ${evictIds.length} memories for user ${userId}`);
  }

  private loadEntries(ids: string[], query: MemoryQuery): MemoryEntry[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    let sql = `SELECT * FROM memories WHERE id IN (${placeholders})`;
    const params: unknown[] = [...ids];

    if (query.userId) {
      sql += " AND user_id = ?";
      params.push(query.userId);
    }
    if (query.types && query.types.length > 0) {
      sql += ` AND type IN (${query.types.map(() => "?").join(",")})`;
      params.push(...query.types);
    }
    if (query.timeRange?.start) {
      sql += " AND timestamp >= ?";
      params.push(query.timeRange.start);
    }
    if (query.timeRange?.end) {
      sql += " AND timestamp <= ?";
      params.push(query.timeRange.end);
    }

    return this.db.all(sql, params).map((row) => ({
      id: row.id as string,
      content: row.content as string,
      type: row.type as MemoryEntry["type"],
      userId: row.user_id as string,
      sessionId: row.session_id as string | undefined,
      timestamp: row.timestamp as number,
      importance: row.importance as number,
      accessCount: row.access_count as number,
      lastAccessedAt: row.last_accessed_at as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  private updateAccessCounts(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    for (const id of ids) {
      this.db.run(
        "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
        [now, id],
      );
    }
  }
}
