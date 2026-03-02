import { createHash } from "crypto";
import type { DatabaseService } from "../short-term-memory";
import type { EmbeddingProvider, IEmbeddingService } from "./types";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class EmbeddingService implements IEmbeddingService {
  private providers: EmbeddingProvider[];
  private activeProvider: EmbeddingProvider | null = null;
  private cache: EmbeddingCache;
  private logger: Logger;

  constructor(
    providers: EmbeddingProvider[],
    db: DatabaseService,
    logger: Logger,
  ) {
    this.providers = providers;
    this.cache = new EmbeddingCache(db);
    this.logger = logger;
  }

  get dimensions(): number {
    return this.activeProvider?.dimensions ?? 384;
  }

  get providerName(): string {
    return this.activeProvider?.name ?? "none";
  }

  get isReady(): boolean {
    return this.activeProvider !== null;
  }

  async initialize(): Promise<void> {
    for (const provider of this.providers) {
      try {
        const available = await provider.isAvailable();
        if (available) {
          await provider.initialize();
          this.activeProvider = provider;
          this.logger.info(
            `Embedding provider initialized: ${provider.name} (${provider.dimensions}d)`,
          );
          return;
        }
      } catch (err) {
        this.logger.warn(`Embedding provider ${provider.name} unavailable: ${err}`);
      }
    }

    this.logger.warn(
      "No embedding provider available. Memory system will use FTS-only search.",
    );
  }

  async embed(text: string): Promise<number[]> {
    if (!this.activeProvider) {
      throw new Error("No embedding provider available");
    }

    const hash = this.contentHash(text);
    const cached = this.cache.get(hash);
    if (cached) return cached;

    const embedding = await this.activeProvider.embed(text);
    const providerName = this.activeProvider.name ?? "unknown";
    const dimensions = this.dimensions;
    this.cache.set(hash, embedding, providerName, dimensions ?? 384);

    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.activeProvider) {
      throw new Error("No embedding provider available");
    }

    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncached: { index: number; text: string }[] = [];
    const providerName = this.activeProvider.name ?? "unknown";
    const dimensions = this.dimensions ?? 384;

    for (let i = 0; i < texts.length; i++) {
      const textItem = texts[i];
      if (!textItem) continue;
      const hash = this.contentHash(textItem);
      const cached = this.cache.get(hash);
      if (cached) {
        results[i] = cached;
      } else {
        uncached.push({ index: i, text: textItem });
      }
    }

    this.logger.debug(
      `Embedding batch: ${texts.length} total, ${texts.length - uncached.length} cached, ${uncached.length} to compute`,
    );

    if (uncached.length > 0) {
      const embeddings = await this.activeProvider.embedBatch(
        uncached.map((u) => u.text),
      );
      const pName = providerName;
      const dims = dimensions;
      for (let i = 0; i < uncached.length; i++) {
        const embedding = embeddings[i];
        const uncachedItem = uncached[i];
        if (embedding && uncachedItem) {
          results[uncachedItem.index] = embedding;
          const hash = this.contentHash(uncachedItem.text);
          this.cache.set(hash, embedding, pName, dims);
        }
      }
    }

    return results as number[][];
  }

  private contentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}

class EmbeddingCache {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
    this.ensureTable();
  }

  get(hash: string): number[] | null {
    const row = this.db.get<{ embedding: string }>(
      "SELECT embedding FROM embedding_cache WHERE content_hash = ?",
      [hash],
    );
    if (!row) return null;
    return JSON.parse(row.embedding);
  }

  set(hash: string, embedding: number[], provider: string, dimensions: number): void {
    this.db.run(
      `INSERT OR REPLACE INTO embedding_cache
        (content_hash, embedding, provider, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [hash, JSON.stringify(embedding), provider, dimensions, Date.now()],
    );
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        content_hash TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        provider TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }
}
