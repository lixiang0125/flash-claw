import type { DatabaseService } from "./short-term-memory";
import type { Logger } from "./embedding/embedding-service";

export interface VectorSearchResult {
  id: string;
  score: number;
}

export interface IVectorStore {
  initialize(): Promise<void>;
  insert(
    id: string,
    content: string,
    type: string,
    embedding: number[] | null,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  searchVector(
    queryEmbedding: number[],
    limit: number,
    threshold?: number,
  ): Promise<VectorSearchResult[]>;
  searchFTS(query: string, limit: number): Promise<VectorSearchResult[]>;
  searchHybrid(
    queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
    threshold?: number,
  ): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
  getStats(): { totalMemories: number; totalVectors: number; vecAvailable: boolean };
}

export interface VectorStoreConfig {
  dimensions: number;
  ftsWeight: number;
  vectorWeight: number;
}

const DEFAULT_VECTOR_CONFIG: VectorStoreConfig = {
  dimensions: 384,
  ftsWeight: 0.3,
  vectorWeight: 0.7,
};

const STOP_WORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "and",
  "but",
  "or",
  "not",
  "no",
  "nor",
  "so",
  "for",
  "yet",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
]);

export class VectorStore implements IVectorStore {
  private db: DatabaseService;
  private config: VectorStoreConfig;
  private vecAvailable = false;
  private logger: Logger;

  constructor(
    db: DatabaseService,
    logger: Logger,
    config?: Partial<VectorStoreConfig>,
  ) {
    this.db = db;
    this.logger = logger;
    this.config = { ...DEFAULT_VECTOR_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    try {
      const sqliteVec = await import("sqlite-vec");
      const dbAny = this.db as unknown as { raw: unknown };
      sqliteVec.load(dbAny.raw);
      this.vecAvailable = true;
      this.logger.info("sqlite-vec extension loaded successfully");
    } catch (err) {
      this.logger.warn(
        `sqlite-vec not available: ${err}. Falling back to FTS-only search.`,
      );
      this.vecAvailable = false;
    }

    this.ensureTables();
  }

  async insert(
    id: string,
    content: string,
    type: string,
    embedding: number[] | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO memories
        (id, content, type, user_id, session_id, timestamp, importance, access_count, last_accessed_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        content,
        type,
        metadata?.userId ?? "default",
        metadata?.sessionId ?? null,
        metadata?.timestamp ?? Date.now(),
        metadata?.importance ?? 0.5,
        Date.now(),
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    if (this.vecAvailable && embedding) {
      this.db.run(
        "INSERT OR REPLACE INTO memories_vec (id, embedding) VALUES (?, ?)",
        [id, new Float32Array(embedding)],
      );
    }

    this.db.run(
      "INSERT OR REPLACE INTO memories_fts (id, content, type) VALUES (?, ?, ?)",
      [id, content, type],
    );
  }

  async searchVector(
    queryEmbedding: number[],
    limit: number,
    threshold = 0.3,
  ): Promise<VectorSearchResult[]> {
    if (!this.vecAvailable) return [];

    const results = this.db.all<{ id: string; distance: number }>(
      `SELECT id, vec_distance_cosine(embedding, ?) as distance
       FROM memories_vec
       WHERE distance < ?
       ORDER BY distance ASC
       LIMIT ?`,
      [new Float32Array(queryEmbedding), 1 - threshold, limit],
    );

    return results.map((row) => ({
      id: row.id,
      score: 1 - row.distance,
    }));
  }

  async searchFTS(query: string, limit: number): Promise<VectorSearchResult[]> {
    const processedQuery = this.processSearchQuery(query);
    if (!processedQuery) return [];

    const results = this.db.all<{ id: string; rank: number }>(
      `SELECT id, rank
       FROM memories_fts
       WHERE memories_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      [processedQuery, limit],
    );

    if (results.length === 0) return [];
    const firstResult = results[0];
    const maxRank = firstResult ? Math.abs(firstResult.rank) : 0;

    return results.map((row) => ({
      id: row.id,
      score: maxRank > 0 ? Math.abs(row.rank) / maxRank : 0,
    }));
  }

  async searchHybrid(
    queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
    threshold = 0.3,
  ): Promise<VectorSearchResult[]> {
    const [vectorResults, ftsResults] = await Promise.all([
      queryEmbedding
        ? this.searchVector(queryEmbedding, limit * 3, threshold)
        : Promise.resolve([]),
      this.searchFTS(queryText, limit * 3),
    ]);

    const scoreMap = new Map<string, number>();

    for (const r of vectorResults) {
      scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + r.score * this.config.vectorWeight);
    }
    for (const r of ftsResults) {
      scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + r.score * this.config.ftsWeight);
    }

    return Array.from(scoreMap.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
    if (this.vecAvailable) {
      this.db.run("DELETE FROM memories_vec WHERE id = ?", [id]);
    }
    this.db.run("DELETE FROM memories_fts WHERE id = ?", [id]);
  }

  getStats(): { totalMemories: number; totalVectors: number; vecAvailable: boolean } {
    const memCount = this.db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM memories");
    const vecCount = this.vecAvailable
      ? this.db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM memories_vec")
      : { cnt: 0 };

    return {
      totalMemories: memCount?.cnt ?? 0,
      totalVectors: vecCount?.cnt ?? 0,
      vecAvailable: this.vecAvailable,
    };
  }

  private processSearchQuery(query: string): string {
    const tokens = query
      .replace(/[，。！？、；：""''（）\[\]【】]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .filter((t) => !STOP_WORDS.has(t));

    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t}"`).join(" OR ");
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    `);

    if (this.vecAvailable) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${this.config.dimensions}]
        );
      `);
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        content,
        type,
        tokenize='unicode61'
      );
    `);
  }
}
