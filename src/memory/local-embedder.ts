/**
 * Local embedding provider for mem0 — runs ONNX-converted HuggingFace models
 * via @xenova/transformers directly in the Bun/Node process.
 *
 * Default model: Xenova/multilingual-e5-small (384 dimensions, ~100MB ONNX, <0.5B params)
 *
 * The model is lazy-loaded on first embed() call to keep startup instant.
 * After loading, the ONNX pipeline is cached for the lifetime of the process.
 *
 * This class exposes the same `embed(text)` interface that mem0 OpenAIEmbedder
 * uses, so it can be monkey-patched directly onto `memory.embedder`.
 */

interface FeatureExtractionPipeline {
  (text: string | string[], opts?: Record<string, unknown>): Promise<{ data: Float32Array }>;
}

export class LocalTransformersEmbedder {
  /** Human-readable name shown in logs */
  readonly name: string;
  /** Vector dimensionality (must match the model output) */
  readonly dimensions: number;

  private pipeline: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;
  private modelId: string;

  constructor(
    modelId = "Xenova/multilingual-e5-small",
    dimensions = 384,
  ) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    this.name = `local:${modelId.split("/").pop()}`;
  }

  /**
   * Embed a single text string into a normalised float vector.
   * Compatible with mem0 OpenAIEmbedder.embed() signature.
   */
  async embed(text: string): Promise<number[]> {
    await this.ensureReady();
    const output = await this.pipeline!(text, {
      pooling: "mean",
      normalize: true,
    });
    return this.toNormalised(output.data);
  }

  /**
   * Embed a batch of texts. Processes sequentially to limit memory usage
   * on small-param local models.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await this.embed(t));
    }
    return results;
  }

  /**
   * Ensure the ONNX pipeline is loaded. Safe to call multiple times —
   * only the first call triggers actual loading.
   */
  async ensureReady(): Promise<void> {
    if (this.pipeline) return;
    if (!this.initPromise) {
      this.initPromise = this.loadPipeline();
    }
    await this.initPromise;
  }

  /**
   * Check whether @xenova/transformers is importable in the current runtime.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await import("@xenova/transformers");
      return true;
    } catch {
      return false;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async loadPipeline(): Promise<void> {
    const mod = await import("@xenova/transformers");
    const pipelineFn = mod.pipeline as (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<FeatureExtractionPipeline>;
    this.pipeline = await pipelineFn("feature-extraction", this.modelId, {
      quantized: true,
    });
  }

  private toNormalised(raw: Float32Array): number[] {
    const vec = Array.from(raw);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}
