export { WorkingMemory, type ConversationMessage, type WorkingMemoryConfig } from "./working-memory";
export { ShortTermMemory, type ShortTermMemoryConfig, type DatabaseService } from "./short-term-memory";
export { EmbeddingService } from "./embedding/embedding-service";
export type { IEmbeddingService, EmbeddingProvider } from "./embedding/types";
export { TransformersEmbeddingProvider } from "./embedding/transformers-provider";
export { OllamaEmbeddingProvider } from "./embedding/ollama-provider";
export { VectorStore, type VectorStoreConfig, type VectorSearchResult, type IVectorStore } from "./vector-store";
export {
  LongTermMemory,
  type MemoryEntry,
  type MemoryQuery,
  type MemorySearchResult,
  type LongTermMemoryConfig,
} from "./long-term-memory";
export { MemoryManager, type IMemoryManager, type IncomingMessage } from "./memory-manager";
export { ContextBudget, type ContextBudgetConfig } from "./context-budget";
export { UserProfileService, type UserProfile } from "./user-profile";
export { createDatabaseAdapter } from "./db-adapter";

import * as Legacy from "./legacy";
export const readUser = Legacy.readUser;
export const updateUser = Legacy.updateUser;
export const readSoul = Legacy.readSoul;
export const readMemory = Legacy.readMemory;
export const updateMemory = Legacy.updateMemory;
export const extractInfoToRemember = Legacy.extractInfoToRemember;
