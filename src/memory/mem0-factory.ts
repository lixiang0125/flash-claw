import { Memory } from "mem0ai/oss";
import { patchEmbedderBaseURL, patchEmbedderLocal } from "./mem0-embedder-patch";
import { LocalTransformersEmbedder } from "./local-embedder";
import type { Logger } from "../core/container/tokens";

/** Known local models and their output dimensions. */
const LOCAL_MODEL_DIMS: Record<string, number> = {
  "Xenova/multilingual-e5-small": 384,
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-small-zh-v1.5": 512,
};

function resolveLocalDims(
  model: string,
  explicitDims: number | undefined,
): number {
  if (explicitDims && explicitDims > 0) return explicitDims;
  return LOCAL_MODEL_DIMS[model] ?? 384;
}

export interface Mem0FactoryOptions {
  /** LLM API key (DashScope / OpenAI-compatible) */
  apiKey: string;
  /** LLM base URL */
  baseURL: string;
  llmModel: string;

  /**
   * Embedding mode:
   *   - "local"  — use @xenova/transformers (no API key needed for embedding)
   *   - "remote" — use an OpenAI-compatible embedding API
   */
  embeddingMode: "local" | "remote";

  /** Local model id (only used when embeddingMode === "local") */
  localEmbeddingModel: string;

  /** Remote embedding API key (only used when embeddingMode === "remote") */
  embeddingApiKey: string;
  /** Remote embedding base URL */
  embeddingBaseURL: string;
  embeddingModel: string;
  embeddingDims: number;

  collectionName: string;
  customPrompt?: string;
  historyDbPath: string;
  vectorStoreDbPath: string;
}

const localModel =
  process.env.MEM0_LOCAL_MODEL || "Xenova/multilingual-e5-small";

const DEFAULT_OPTIONS: Mem0FactoryOptions = {
  // ── LLM ────────────────────────────────────────────────────────────────
  apiKey: process.env.OPENAI_API_KEY || "",
  baseURL:
    process.env.MEM0_BASE_URL ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  llmModel: process.env.MEM0_LLM_MODEL || "qwen-plus",

  // ── Embedding mode ─────────────────────────────────────────────────────
  embeddingMode:
    (process.env.MEM0_EMBEDDING_MODE as "local" | "remote") || "local",
  localEmbeddingModel: localModel,

  // ── Remote embedding (only used when embeddingMode === "remote") ───────
  embeddingApiKey:
    process.env.MEMO_API_KEY || process.env.OPENAI_API_KEY || "",
  embeddingBaseURL:
    process.env.MEM0_EMBEDDING_BASE_URL || "https://api.minimax.io/v1",
  embeddingModel: process.env.MEM0_EMBEDDING_MODEL || "embo-01",
  embeddingDims:
    Number(process.env.MEM0_EMBEDDING_DIMS) ||
    resolveLocalDims(localModel, undefined),

  // ── Storage ────────────────────────────────────────────────────────────
  collectionName: process.env.MEM0_COLLECTION || "flash_claw_memories",
  historyDbPath: process.env.MEM0_HISTORY_DB || "./data/mem0_history.db",
  vectorStoreDbPath: process.env.MEM0_VECTOR_DB || "./data/mem0_vectors.db",
};

/**
 * Create a mem0 Memory instance configured for local OSS mode.
 *
 * Architecture:
 *   - **LLM**       -> DashScope (Qwen) via OPENAI_API_KEY + MEM0_BASE_URL
 *   - **Embedding** -> Local @xenova/transformers (default) or remote API
 *
 * When `embeddingMode === "local"` (default):
 *   - Uses `Xenova/multilingual-e5-small` (384d, ~100 MB ONNX, <0.5B params)
 *   - No embedding API key required
 *   - Model is lazy-loaded on the first embed() call
 *   - The entire embedder object on the mem0 Memory instance is replaced
 *     with a LocalTransformersEmbedder via monkey-patch
 *
 * When `embeddingMode === "remote"`:
 *   - Uses the configured remote OpenAI-compatible embedding API
 *   - Requires MEMO_API_KEY and MEM0_EMBEDDING_BASE_URL
 *   - Monkey-patches the embedder's internal OpenAI client baseURL
 *
 * All database files are stored under the `data/` directory:
 *   - `data/mem0_vectors.db`  -- SQLite-backed vector store
 *   - `data/mem0_history.db`  -- memory history / changelog
 *
 * Runtime notes (Bun):
 *   - mem0ai v2.3.0 uses `better-sqlite3` internally, which cannot load
 *     its native addon under Bun. A shim (`shims/better-sqlite3-bun.js`)
 *     transparently maps it to `bun:sqlite` via a postinstall script.
 */
export function createMem0Memory(
  logger: Logger,
  overrides?: Partial<Mem0FactoryOptions>,
): Memory {
  const opts = { ...DEFAULT_OPTIONS, ...overrides };

  if (!opts.apiKey) {
    throw new Error("mem0 requires an LLM API key. Set OPENAI_API_KEY.");
  }

  const isLocal = opts.embeddingMode === "local";

  // Resolve embedding dimensions for local mode.
  const embDims = isLocal
    ? resolveLocalDims(opts.localEmbeddingModel, undefined)
    : opts.embeddingDims;

  logger.info(
    `Initializing mem0 Memory (embedding: ${isLocal ? "local " + opts.localEmbeddingModel : "remote " + opts.embeddingModel})`,
    {
      llmModel: opts.llmModel,
      llmBaseURL: opts.baseURL,
      embeddingMode: opts.embeddingMode,
      embeddingModel: isLocal ? opts.localEmbeddingModel : opts.embeddingModel,
      embeddingDims: embDims,
      collectionName: opts.collectionName,
      historyDbPath: opts.historyDbPath,
      vectorStoreDbPath: opts.vectorStoreDbPath,
    },
  );

  // Build the mem0 config. For local mode we still need to pass a placeholder
  // embedder config because mem0 constructor requires it — we replace the
  // embedder immediately after construction.
  const memory = new Memory({
    llm: {
      provider: "openai",
      config: {
        apiKey: opts.apiKey,
        model: opts.llmModel,
        baseURL: opts.baseURL,
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: isLocal ? "placeholder-local-embedding" : opts.embeddingApiKey,
        model: isLocal ? "placeholder" : opts.embeddingModel,
        embeddingDims: embDims,
        url: isLocal ? "http://localhost" : opts.embeddingBaseURL,
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: opts.collectionName,
        dimension: embDims,
        dbPath: opts.vectorStoreDbPath,
      },
    },
    historyDbPath: opts.historyDbPath,
    disableHistory: false,
    ...(opts.customPrompt ? { customPrompt: opts.customPrompt } : {}),
    version: "v1.1",
  });

  // ── Monkey-patch embedder ──────────────────────────────────────────────
  if (isLocal) {
    const localEmbedder = new LocalTransformersEmbedder(
      opts.localEmbeddingModel,
      embDims,
    );
    patchEmbedderLocal(memory, localEmbedder);
    logger.info(
      `mem0 embedder patched → ${localEmbedder.name} (${embDims}d, lazy-load)`,
    );
  } else {
    if (!opts.embeddingApiKey) {
      throw new Error(
        "mem0 remote embedding requires an API key. Set MEMO_API_KEY.",
      );
    }
    patchEmbedderBaseURL(memory, opts.embeddingBaseURL, opts.embeddingApiKey);
    logger.info(
      `mem0 embedder patched → remote ${opts.embeddingModel} @ ${opts.embeddingBaseURL}`,
    );
  }

  logger.info("mem0 Memory initialized successfully");
  return memory;
}
