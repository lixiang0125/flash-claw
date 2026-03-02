import type { EmbeddingProvider } from "./types";

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  dimensions: number;

  private baseUrl: string;
  private modelName: string;

  constructor(
    modelName = "nomic-embed-text",
    baseUrl = "http://localhost:11434",
    dimensions = 384,
  ) {
    this.modelName = modelName;
    this.baseUrl = baseUrl;
    this.dimensions = dimensions;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;

      const data = await response.json();
      const models = data.models ?? [];
      return models.some(
        (m: { name: string }) =>
          m.name === this.modelName || m.name.startsWith(`${this.modelName}:`),
      );
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    // Ollama 无需显式初始化
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status}`);
    }

    const data = await response.json();
    let embedding = data.embeddings[0];

    if (embedding.length > this.dimensions) {
      embedding = embedding.slice(0, this.dimensions);
    }

    return this.l2Normalize(embedding);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama batch embedding failed: ${response.status}`);
    }

    const data = await response.json();
    return data.embeddings.map((emb: number[]) => {
      const truncated = emb.length > this.dimensions ? emb.slice(0, this.dimensions) : emb;
      return this.l2Normalize(truncated);
    });
  }

  private l2Normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}
