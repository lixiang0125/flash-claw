import { Memory } from "mem0ai/oss";
import { patchEmbedderBaseURL } from "./mem0-embedder-patch";
import type { Logger } from "../core/container/tokens";

export interface Mem0FactoryOptions {
  apiKey: string;
  baseURL: string;
  llmModel: string;
  embeddingModel: string;
  embeddingDims: number;
  collectionName: string;
  customPrompt?: string;
  historyDbPath: string;
  vectorStoreDbPath: string;
}

const DEFAULT_OPTIONS: Mem0FactoryOptions = {
  apiKey: process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || "",
  baseURL:
    process.env.MEM0_BASE_URL ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  llmModel: process.env.MEM0_LLM_MODEL || "qwen-plus",
  embeddingModel: process.env.MEM0_EMBEDDING_MODEL || "text-embedding-v3",
  embeddingDims: Number(process.env.MEM0_EMBEDDING_DIMS) || 1024,
  collectionName: process.env.MEM0_COLLECTION || "flash_claw_memories",
  historyDbPath: process.env.MEM0_HISTORY_DB || "./data/mem0_history.db",
  vectorStoreDbPath: process.env.MEM0_VECTOR_DB || "./data/mem0_vectors.db",
};

/**
 * Create a mem0 Memory instance configured for local OSS mode.
 *
 * All database files are stored under the `data/` directory:
 * - `data/mem0_vectors.db`  — SQLite-backed vector store
 * - `data/mem0_history.db`  — memory history / changelog
 *
 * The `data/` directory is gitignored and never pushed to remote.
 * Only this factory (the initialization logic) is version-controlled.
 *
 * Runtime notes (Bun):
 * - mem0ai v2.3.0 uses `better-sqlite3` internally, which cannot load
 *   its native addon under Bun. A shim (`shims/better-sqlite3-bun.js`)
 *   transparently maps it to `bun:sqlite` via a postinstall script.
 * - OpenAIEmbedder still ignores `baseURL`, so we monkey-patch it
 *   after construction via `patchEmbedderBaseURL()`.
 */
export function createMem0Memory(
  logger: Logger,
  overrides?: Partial<Mem0FactoryOptions>,
): Memory {
  const opts = { ...DEFAULT_OPTIONS, ...overrides };

  if (!opts.apiKey) {
    throw new Error(
      "mem0 requires an API key. Set DASHSCOPE_API_KEY or OPENAI_API_KEY.",
    );
  }

  logger.info(
    "Initializing mem0 Memory (OSS local mode, v2.3.0+ bun:sqlite shim)",
    {
      llmModel: opts.llmModel,
      embeddingModel: opts.embeddingModel,
      embeddingDims: opts.embeddingDims,
      collectionName: opts.collectionName,
      historyDbPath: opts.historyDbPath,
      vectorStoreDbPath: opts.vectorStoreDbPath,
    },
  );

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
        apiKey: opts.apiKey,
        model: opts.embeddingModel,
        embeddingDims: opts.embeddingDims,
        url: opts.baseURL,
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: opts.collectionName,
        dimension: opts.embeddingDims,
        dbPath: opts.vectorStoreDbPath,
      },
    },
    historyDbPath: opts.historyDbPath,
    disableHistory: false,
    ...(opts.customPrompt ? { customPrompt: opts.customPrompt } : {}),
    version: "v1.1",
  });

  patchEmbedderBaseURL(memory, opts.baseURL, opts.apiKey);

  logger.info("mem0 Memory initialized successfully");
  return memory;
}
