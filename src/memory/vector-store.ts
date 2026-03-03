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
  enableMMR: boolean;
  mmrLambda: number;
  candidateMultiplier: number;
}

const DEFAULT_VECTOR_CONFIG: VectorStoreConfig = {
  dimensions: 384,
  ftsWeight: 0.3,
  vectorWeight: 0.7,
  enableMMR: true,
  mmrLambda: 0.7,
  candidateMultiplier: 4,
};

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

  private contentCache = new Map<string, string>();

  async insert(
    id: string,
    content: string,
    type: string,
    embedding: number[] | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.contentCache.set(id, content.slice(0, 200));
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
    const tokens = query.split(/[\s,，。！？、；：""''（）\[\]【]]+/).filter(t => t.length > 0);
    
    if (tokens.length === 0) return [];

    const ftsQuery = tokens.map(t => `"${t}"`).join(" AND ");
    
    const results = this.db.all<{ id: string; rank: number }>(
      `SELECT id, bm25(memories_fts) as rank
       FROM memories_fts
       WHERE memories_fts MATCH ?
       ORDER BY rank ASC
       LIMIT ?`,
      [ftsQuery, limit],
    );

    if (results.length === 0) return [];

    return results.map((row) => ({
      id: row.id,
      score: 1 / (1 + Math.max(0, row.rank)),
    }));
  }

  async searchHybrid(
    queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
    threshold = 0.3,
  ): Promise<VectorSearchResult[]> {
    const candidateLimit = limit * this.config.candidateMultiplier;

    const [vectorResults, ftsResults] = await Promise.all([
      queryEmbedding
        ? this.searchVector(queryEmbedding, candidateLimit, threshold).catch(() => [])
        : Promise.resolve([]),
      this.searchFTS(queryText, candidateLimit).catch(() => []),
    ]);

    const scoreMap = new Map<string, number>();

    for (const r of vectorResults) {
      scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + r.score * this.config.vectorWeight);
    }
    for (const r of ftsResults) {
      scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + r.score * this.config.ftsWeight);
    }

    let mergedResults = Array.from(scoreMap.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);

    if (this.config.enableMMR && mergedResults.length > 1) {
      mergedResults = this.mmrRerank(mergedResults, limit, queryText);
    }

    return mergedResults.slice(0, limit);
  }

  private mmrRerank(
    results: VectorSearchResult[],
    limit: number,
    query: string,
  ): VectorSearchResult[] {
    if (results.length <= limit) return results;

    const selected: VectorSearchResult[] = [];
    const remaining = [...results];
    const lambda = this.config.mmrLambda;

    selected.push(remaining.shift()!);

    while (selected.length < limit && remaining.length > 0) {
      let bestMmr = -Infinity;
      let bestIdx = 0;

      for (let i = 0; i < remaining.length; i++) {
        const current = remaining[i];
        if (!current) continue;
        const relevance = current.score;
        const maxSimilarity = Math.max(
          0,
          ...selected.map((s) => this.jaccardSimilarity(current.id, s.id)),
        );
        const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;

        if (mmr > bestMmr) {
          bestMmr = mmr;
          bestIdx = i;
        }
      }

      const selectedItem = remaining.splice(bestIdx, 1)[0];
      if (selectedItem) selected.push(selectedItem);
    }

    return selected;
  }

  private jaccardSimilarity(id1: string, id2: string): number {
    const content1 = this.contentCache.get(id1) ?? "";
    const content2 = this.contentCache.get(id2) ?? "";
    
    if (!content1 || !content2) return 0;
    
    const words1 = new Set(content1.toLowerCase().split(/\s+/));
    const words2 = new Set(content2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  async delete(id: string): Promise<void> {
    this.contentCache.delete(id);
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
