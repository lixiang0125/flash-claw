import { createToken, type ServiceToken } from "./types";

export interface AppConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly llmApiKey: string;
  readonly llmModel: string;
  readonly env: "development" | "production" | "test";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly workspacePath: string;
}

export const CONFIG: ServiceToken<AppConfig> = createToken<AppConfig>("CONFIG");

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export const LOGGER: ServiceToken<Logger> = createToken<Logger>("LOGGER");

export interface EventMap {
  "agent:start": { sessionId: string; prompt: string };
  "agent:step": { sessionId: string; step: number; content: string };
  "agent:complete": { sessionId: string; result: string; totalSteps: number };
  "agent:error": { sessionId: string; error: Error };
  "tool:call": { sessionId: string; toolName: string; args: unknown };
  "tool:result": { sessionId: string; toolName: string; result: unknown };
  "system:ready": { timestamp: number };
  "system:shutdown": { reason: string };
  "system:error": { error: Error; context?: string };
}

export interface EventBus {
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): void;
  off<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): void;
  once<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): void;
}

export const EVENT_BUS: ServiceToken<EventBus> =
  createToken<EventBus>("EVENT_BUS");

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  execute(
    sql: string,
    params?: unknown[],
  ): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
  exec(sql: string): void;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  close(): void;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

export const DATABASE: ServiceToken<Database> =
  createToken<Database>("DATABASE");

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface LLMService {
  generateText(prompt: string, options?: LLMOptions): Promise<string>;
  streamText(prompt: string, options?: LLMOptions): AsyncIterable<string>;
  generateObject<T>(
    prompt: string,
    schema: unknown,
    options?: LLMOptions,
  ): Promise<T>;
}

export const LLM_SERVICE: ServiceToken<LLMService> =
  createToken<LLMService>("LLM_SERVICE");

export interface AgentResult {
  text: string;
  steps: number;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
}

export interface AgentCore {
  run(sessionId: string, prompt: string): Promise<AgentResult>;
  abort(sessionId: string): void;
}

export const AGENT_CORE: ServiceToken<AgentCore> =
  createToken<AgentCore>("AGENT_CORE");

export interface SandboxManager {
  initialize(): Promise<void>;
  acquire(sessionId: string): Promise<unknown>;
  release(sessionId: string): Promise<void>;
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<unknown>;
  dispose(): Promise<void>;
}

export const SANDBOX_MANAGER: ServiceToken<SandboxManager> =
  createToken<SandboxManager>("SANDBOX_MANAGER");

export interface ToolRegistry {
  getAll(): Array<{ name: string; description: string; inputSchema: unknown }>;
  get(name: string): unknown;
}

export const TOOL_REGISTRY: ServiceToken<ToolRegistry> =
  createToken<ToolRegistry>("TOOL_REGISTRY");

export interface ToolExecutor {
  execute(toolName: string, input: unknown, sessionId: string): Promise<unknown>;
}

export const TOOL_EXECUTOR: ServiceToken<ToolExecutor> =
  createToken<ToolExecutor>("TOOL_EXECUTOR");

// ===== Memory System =====

export interface IEmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly providerName: string;
  readonly isReady: boolean;
  initialize(): Promise<void>;
}

export const EMBEDDING_SERVICE: ServiceToken<IEmbeddingService> =
  createToken<IEmbeddingService>("EMBEDDING_SERVICE");

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
  ): Promise<Array<{ id: string; score: number }>>;
  searchFTS(query: string, limit: number): Promise<Array<{ id: string; score: number }>>;
  searchHybrid(
    queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
    threshold?: number,
  ): Promise<Array<{ id: string; score: number }>>;
  delete(id: string): Promise<void>;
}

export const VECTOR_STORE: ServiceToken<IVectorStore> =
  createToken<IVectorStore>("VECTOR_STORE");

export interface IWorkingMemory {
  append(sessionId: string, message: unknown): void;
  getMessages(sessionId: string): unknown[];
  getRecent(sessionId: string, count: number): unknown[];
  clear(sessionId: string): void;
}

export const WORKING_MEMORY: ServiceToken<IWorkingMemory> =
  createToken<IWorkingMemory>("WORKING_MEMORY");

export interface IShortTermMemory {
  initialize(): void;
  upsertSession(sessionId: string, userId: string, platform: string, metadata?: unknown): void;
  saveMessage(sessionId: string, message: unknown): string;
  getHistory(sessionId: string, limit?: number, beforeTimestamp?: number): unknown[];
}

export const SHORT_TERM_MEMORY: ServiceToken<IShortTermMemory> =
  createToken<IShortTermMemory>("SHORT_TERM_MEMORY");

export interface ILongTermMemory {
  store(entry: unknown): Promise<string>;
  recall(query: unknown): Promise<unknown[]>;
}

export const LONG_TERM_MEMORY: ServiceToken<ILongTermMemory> =
  createToken<ILongTermMemory>("LONG_TERM_MEMORY");

export interface IUserProfile {
  getProfile(userId: string): Promise<unknown>;
  updateProfile(userId: string, updates: unknown): Promise<void>;
}

export const USER_PROFILE: ServiceToken<IUserProfile> =
  createToken<IUserProfile>("USER_PROFILE");

export interface IMemoryManager {
  store(entry: unknown): Promise<string>;
  recall(query: unknown): Promise<unknown[]>;
  storeInteraction(msg: unknown, response: string): Promise<void>;
  resetSession(sessionId: string): Promise<void>;
  getUserProfile(userId: string): Promise<unknown>;
  updateUserProfile(userId: string, updates: unknown): Promise<void>;
}

export const MEMORY_MANAGER: ServiceToken<IMemoryManager> =
  createToken<IMemoryManager>("MEMORY_MANAGER");

export interface IContextBudget {
  getAllocations(): Record<string, number>;
  estimateTokens(text: string): number;
  truncateHistory(messages: unknown[], maxTokens: number): unknown[];
}

export const CONTEXT_BUDGET: ServiceToken<IContextBudget> =
  createToken<IContextBudget>("CONTEXT_BUDGET");

export interface IPromptBuilder {
  build(context: unknown, userMessage: string): Promise<unknown[]>;
  estimateTokens(messages: unknown[]): number;
}

export const PROMPT_BUILDER: ServiceToken<IPromptBuilder> =
  createToken<IPromptBuilder>("PROMPT_BUILDER");

export interface IChatEngine {
  chat(request: unknown): Promise<unknown>;
  setMemoryManager(manager: unknown): void;
  setTools(tools: unknown[]): void;
  setToolExecutor(executor: unknown): void;
  clearSession(sessionId: string): void | Promise<void>;
}

export const CHAT_ENGINE: ServiceToken<IChatEngine> =
  createToken<IChatEngine>("CHAT_ENGINE");

export interface IFeishuBot {
  handleEvent(body: unknown): Promise<unknown>;
  isConfigured(): boolean;
  getConfig(): unknown;
}

export const FEISHU_BOT: ServiceToken<IFeishuBot> =
  createToken<IFeishuBot>("FEISHU_BOT");

export interface ITaskScheduler {
  listTasks(): unknown[];
  createTask(task: unknown): unknown;
  getTask(id: string): unknown;
  updateTask(id: string, updates: unknown): unknown;
  deleteTask(id: string): boolean;
  runTask(id: string): Promise<unknown>;
  getTaskRuns(id: string): unknown[];
}

export const TASK_SCHEDULER: ServiceToken<ITaskScheduler> =
  createToken<ITaskScheduler>("TASK_SCHEDULER");

export interface IHeartbeatSystem {
  getStatus(): unknown;
  trigger(): Promise<unknown>;
  getHeartbeatFile(): string;
}

export const HEARTBEAT_SYSTEM: ServiceToken<IHeartbeatSystem> =
  createToken<IHeartbeatSystem>("HEARTBEAT_SYSTEM");

export interface ISubAgentSystem {
  listRuns(): unknown[];
  getRun(id: string): unknown;
  killRun(id: string): boolean;
}

export const SUB_AGENT_SYSTEM: ServiceToken<ISubAgentSystem> =
  createToken<ISubAgentSystem>("SUB_AGENT_SYSTEM");

export interface IMarkdownMemory {
  initialize(): Promise<void>;
  appendDailyLog(content: string): Promise<string>;
  writeDailySummary(date: string, summary: string): Promise<string>;
  appendToMemory(content: string, section?: string): Promise<string>;
  appendConsolidatedMemory(content: string): Promise<string>;
  readMemoryFile(): Promise<string>;
  getLastConsolidationDate(): Promise<string | null>;
  searchInFiles(query: string, limit?: number): Promise<unknown[]>;
  getMemoryContent(section?: string): Promise<string>;
  getDailyLogs(days?: number): Promise<string[]>;
}

export const MARKDOWN_MEMORY: ServiceToken<IMarkdownMemory> =
  createToken<IMarkdownMemory>("MARKDOWN_MEMORY");

export interface HonoApp {
  fetch: unknown;
}

export const HTTP_SERVER: ServiceToken<HonoApp> =
  createToken<HonoApp>("HTTP_SERVER");
