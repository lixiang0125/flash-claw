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
}

const DEFAULT_OPTIONS: Mem0FactoryOptions = {
  apiKey: process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || "",
  baseURL:
    process.env.MEM0_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  llmModel: process.env.MEM0_LLM_MODEL || "qwen3.5-plus",
  embeddingModel: process.env.MEM0_EMBEDDING_MODEL || "text-embedding-v3",
  embeddingDims: Number(process.env.MEM0_EMBEDDING_DIMS) || 1024,
  collectionName: process.env.MEM0_COLLECTION || "flash_claw_memories",
  historyDbPath: process.env.MEM0_HISTORY_DB || "./data/mem0_history.db",
};

export function createMem0Memory(
  logger: Logger,
  overrides?: Partial<Mem0FactoryOptions>,
): Memory {
  const opts = { ...DEFAULT_OPTIONS, ...overrides };

  logger.info(
    "Initializing mem0 Memory (OSS local mode)",
    {
      llmModel: opts.llmModel,
      embeddingModel: opts.embeddingModel,
      embeddingDims: opts.embeddingDims,
      collectionName: opts.collectionName,
    },
  );

  const memory = new Memory({
    llm: {
      provider: "openai",
      config: {
        apiKey: opts.apiKey,
        model: opts.llmModel,
        baseURL: opts.baseURL,
        modelProperties: {
          temperature: 0.1,
          max_tokens: 2000,
        },
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: opts.apiKey,
        model: opts.embeddingModel,
        embeddingDims: opts.embeddingDims,
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: opts.collectionName,
        dimension: opts.embeddingDims,
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
