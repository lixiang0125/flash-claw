import { createToken, type ServiceToken } from "./types";
import type { ConversationMessage } from "../../memory/working-memory";
import type { ChatRequest, ChatResponse } from "../../chat/types";
import type { UserProfile } from "../../memory/user-profile";
import type {
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  IncomingMessage,
} from "../../memory/mem0-memory-manager";
import type { FlashClawToolDefinition } from "../../tools/types";
import type {
  SandboxInstance,
  ExecResult,
} from "../../tools/sandbox/sandbox-types";

// Re-export so consumers can import from tokens
export type { ConversationMessage } from "../../memory/working-memory";
export type { UserProfile } from "../../memory/user-profile";
export type { MemoryEntry, MemoryQuery, MemorySearchResult, IncomingMessage } from "../../memory/mem0-memory-manager";

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
  acquire(sessionId: string): Promise<SandboxInstance>;
  release(sessionId: string): Promise<void>;
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  dispose(): Promise<void>;
}

export const SANDBOX_MANAGER: ServiceToken<SandboxManager> =
  createToken<SandboxManager>("SANDBOX_MANAGER");

// ===== Tool System =====

export interface ToolRegistry {
  register(tool: FlashClawToolDefinition<any, any>): void;
  unregister(name: string): boolean;
  get(name: string): FlashClawToolDefinition<any, any> | undefined;
  getAll(): FlashClawToolDefinition<any, any>[];
  readonly size: number;
}

export const TOOL_REGISTRY: ServiceToken<ToolRegistry> =
  createToken<ToolRegistry>("TOOL_REGISTRY");

export interface ToolExecutor {
  execute(toolName: string, input: unknown, sessionId: string): Promise<{
    success: boolean;
    data: unknown;
    error: string | null;
    durationMs: number;
    output: string;
    metadata: {
      toolName: string;
      inputSummary: string;
      sandboxUsed: boolean;
      approvalRequired: boolean;
    };
  }>;
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
  append(sessionId: string, message: ConversationMessage): void;
  getMessages(sessionId: string): ConversationMessage[];
  getRecent(sessionId: string, count: number): ConversationMessage[];
  clear(sessionId: string): void;
  resetSession(sessionId: string): Promise<void>;
  compress(
    sessionId: string,
    summarizer: (messages: ConversationMessage[]) => Promise<string>,
  ): Promise<void>;
  getStats(sessionId: string): { messageCount: number; estimatedTokens: number };
  getConfig(): {
    maxMessages: number;
    maxTokens: number;
    enableCompression: boolean;
    compressionThreshold: number;
    memoryFlushEnabled: boolean;
    memoryFlushSoftThreshold: number;
    reserveTokensFloor: number;
  };
  setFlushCallback(
    fn: (sessionId: string, messages: ConversationMessage[]) => Promise<void>,
  ): void;
}

export const WORKING_MEMORY: ServiceToken<IWorkingMemory> =
  createToken<IWorkingMemory>("WORKING_MEMORY");

export interface IShortTermMemory {
  initialize(): void;
  upsertSession(
    sessionId: string,
    userId: string,
    platform: string,
    metadata?: Record<string, unknown>,
  ): void;
  saveMessage(sessionId: string, message: ConversationMessage): string;
  getHistory(
    sessionId: string,
    limit?: number,
    beforeTimestamp?: number,
  ): ConversationMessage[];
  cleanup(): number;
  dispose(): void;
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
  getProfile(userId: string): Promise<UserProfile>;
  updateProfile(userId: string, updates: Partial<UserProfile>): Promise<void>;
}

export const USER_PROFILE: ServiceToken<IUserProfile> =
  createToken<IUserProfile>("USER_PROFILE");

export interface IMemoryManager {
  store(
    entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessedAt">,
  ): Promise<string>;
  recall(query: MemoryQuery): Promise<MemorySearchResult[]>;
  storeInteraction(msg: IncomingMessage, response: string): Promise<void>;
  getUserProfile(userId: string): Promise<UserProfile>;
  updateUserProfile(
    userId: string,
    updates: Partial<UserProfile>,
  ): Promise<void>;
  cleanup(maxAge?: number): Promise<number>;
  resetSession?(sessionId: string): Promise<void>;
}

export const MEMORY_MANAGER: ServiceToken<IMemoryManager> =
  createToken<IMemoryManager>("MEMORY_MANAGER");

export interface IContextBudget {
  getAllocations(): Record<string, number>;
  estimateTokens(text: string): number;
  truncateHistory(
    messages: ConversationMessage[],
    maxTokens: number,
  ): ConversationMessage[];
  rebalance(actualUsage: Record<string, number>): Record<string, number>;
  readonly totalBudget: number;
}

export const CONTEXT_BUDGET: ServiceToken<IContextBudget> =
  createToken<IContextBudget>("CONTEXT_BUDGET");

export interface AgentContext {
  user: {
    userId: string;
    name: string;
    language: string;
    communicationStyle: string;
    timezone: string;
    keyFacts: string[];
  };
  history: ConversationMessage[];
  activeSkills: unknown[];
  memories: MemoryEntry[];
}

export interface IPromptBuilder {
  build(
    context: AgentContext,
    userMessage: string,
  ): Promise<ConversationMessage[]>;
  estimateTokens(messages: ConversationMessage[]): number;
}

export const PROMPT_BUILDER: ServiceToken<IPromptBuilder> =
  createToken<IPromptBuilder>("PROMPT_BUILDER");

export interface IChatEngine {
  chat(request: ChatRequest): Promise<ChatResponse>;
  setMemoryManager(manager: IMemoryManager): void;
  setWorkingMemory(wm: IWorkingMemory): void;
  setTaskScheduler(api: {
    createTask(task: {
      name: string;
      message: string;
      schedule: string;
      enabled: boolean;
    }): unknown;
    createOneTimeTask(task: {
      name: string;
      message: string;
      executeAfter: number;
    }): unknown;
  }): void;
  setTools(tools: unknown[]): void;
  setToolExecutor(
    executor: (
      name: string,
      args: Record<string, unknown>,
      sessionId: string,
    ) => Promise<{ result: unknown; error?: string }>,
  ): void;
  clearSession(sessionId: string): void | Promise<void>;
  getHistoryMessages(
    sessionId: string,
  ): Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    name?: string;
  }>;
}

export const CHAT_ENGINE: ServiceToken<IChatEngine> =
  createToken<IChatEngine>("CHAT_ENGINE");

export interface IFeishuBot {
  handleEvent(body: unknown): Promise<unknown>;
  isConfigured(): boolean;
  getConfig(): unknown;
  setChatEngine(engine: {
    chat(request: { message: string; sessionId: string }): Promise<{ response: string }>;
  }): void;
  setTaskScheduler(scheduler: {
    setLastChatId(chatId: string): void;
  }): void;
  start(): void;
  sendMessage(chatId: string, userId?: unknown, text?: string): Promise<void>;
  notify(chatId: string, text: string): Promise<void>;
}

export const FEISHU_BOT: ServiceToken<IFeishuBot> =
  createToken<IFeishuBot>("FEISHU_BOT");

export interface ITaskScheduler {
  listTasks(): Array<{
    id: string;
    name: string;
    message: string;
    schedule: string;
    enabled: boolean;
    lastRun?: string;
    nextRun?: string;
    createdAt: string;
  }>;
  createTask(task: {
    name: string;
    message: string;
    schedule: string;
    enabled: boolean;
  }): unknown;
  createOneTimeTask(task: {
    name: string;
    message: string;
    executeAfter: number;
  }): unknown;
  getTask(id: string): unknown;
  updateTask(id: string, updates: unknown): unknown;
  deleteTask(id: string): boolean;
  runTask(id: string): Promise<unknown>;
  getTaskRuns(id: string, limit?: number): unknown[];
  setExecutor(
    fn: (taskMessage: string, taskId: string) => Promise<string>,
  ): void;
  setNotifier(
    fn: (taskName: string, result: string) => Promise<void>,
  ): void;
  setLastChatId(chatId: string): void;
  getLastChatId(): string | null;
  start(): void;
  stop(): void;
}

export const TASK_SCHEDULER: ServiceToken<ITaskScheduler> =
  createToken<ITaskScheduler>("TASK_SCHEDULER");

export interface IHeartbeatSystem {
  getStatus(): { running: boolean; checks: unknown[] };
  trigger(): Promise<unknown[]>;
  getHeartbeatFile(): string;
  setChatEngine(engine: {
    chat(request: { message: string; sessionId: string }): Promise<{ response: string }>;
  }): void;
  setTaskScheduler(scheduler: {
    listTasks(): { enabled: boolean; nextRun?: string }[];
    getLastChatId(): string | null;
  }): void;
  setFeishuBot(bot: {
    getStatus?(): { connected: boolean };
    notify?(chatId: string, message: string): Promise<void>;
  }): void;
  start(): void;
}

export const HEARTBEAT_SYSTEM: ServiceToken<IHeartbeatSystem> =
  createToken<IHeartbeatSystem>("HEARTBEAT_SYSTEM");

export interface ISubAgentSystem {
  listRuns(parentSessionId?: string): Array<{
    id: string;
    label?: string;
    sessionId: string;
    parentSessionId: string;
    task: string;
    status: "running" | "completed" | "failed" | "timeout";
    result?: string;
    error?: string;
    startedAt: Date;
    finishedAt?: Date;
    runtime?: string;
  }>;
  getRun(id: string): {
    id: string;
    label?: string;
    sessionId: string;
    parentSessionId: string;
    task: string;
    status: "running" | "completed" | "failed" | "timeout";
    result?: string;
    error?: string;
    startedAt: Date;
    finishedAt?: Date;
    runtime?: string;
  } | undefined;
  killRun(id: string): boolean;
  setChatEngine(engine: {
    chat(request: { message: string; sessionId: string }): Promise<{ response: string }>;
    getHistoryMessages(sessionId: string): unknown[];
  }): void;
  spawn(config: {
    task: string;
    label?: string;
    runTimeoutSeconds?: number;
    mode?: string;
    cleanup?: string;
  }, parentSessionId: string): Promise<{ status: string; runId: string; childSessionKey: string }>;
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
  getDailyLogsSince(sinceDate: string | null, maxDays?: number): Promise<string[]>;
}

export const MARKDOWN_MEMORY: ServiceToken<IMarkdownMemory> =
  createToken<IMarkdownMemory>("MARKDOWN_MEMORY");

export interface HonoApp {
  fetch(request: Request, Env?: {} | unknown, executionCtx?: unknown): Response | Promise<Response>;
}

export const HTTP_SERVER: ServiceToken<HonoApp> =
  createToken<HonoApp>("HTTP_SERVER");
