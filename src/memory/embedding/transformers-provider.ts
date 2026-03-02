import type { EmbeddingProvider } from "./types";

interface TransformersPipeline {
  (text: string, options: Record<string, unknown>): Promise<{ data: Float32Array }>;
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = "transformers-local";
  readonly dimensions = 384;

  private model: TransformersPipeline | null = null;
  private modelId: string;
  private available: boolean | null = null;

  constructor(modelId = "Xenova/all-MiniLM-L6-v2") {
    this.modelId = modelId;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await import("@xenova/transformers");
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.model) return;
    try {
      const mod = await import("@xenova/transformers");
      const pipeline = mod.pipeline as (task: string, model: string, opts?: Record<string, unknown>) => Promise<TransformersPipeline>;
      this.model = await pipeline("feature-extraction", this.modelId, { quantized: true });
    } catch {
      console.warn(`Failed to load Transformers model`);
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.model) await this.initialize();
    if (!this.model) throw new Error("Transformers model not loaded");

    const output = await this.model(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data);
    return this.l2Normalize(embedding);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const CHUNK_SIZE = 32;
    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CHUNK_SIZE);
      const embeddings = await Promise.all(chunk.map((t) => this.embed(t)));
      results.push(...embeddings);
    }
    return results;
  }

  private l2Normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}
