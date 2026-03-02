export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  isAvailable(): Promise<boolean>;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  initialize(): Promise<void>;
}

export interface IEmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly providerName: string;
  readonly isReady: boolean;
  initialize(): Promise<void>;
}

export interface EmbeddingCacheEntry {
  contentHash: string;
  embedding: number[];
  providerName: string;
  dimensions: number;
  createdAt: number;
}
