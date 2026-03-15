/**
 * @module core/container/tokens
 * @description 依赖注入容器的服务令牌与接口定义模块。
 *
 * 本模块集中定义了 Flash-Claw 系统中所有核心服务的 TypeScript 接口和对应的
 * 依赖注入令牌（ServiceToken）。通过 createToken 工厂函数创建的令牌可用于
 * 在 IoC 容器中注册和解析服务实例，实现松耦合的模块化架构。
 *
 * 主要包含以下子系统的接口定义：
 * - 基础设施：配置、日志、事件总线、数据库
 * - AI 服务：LLM 服务、智能体核心
 * - 工具系统：工具注册表、工具执行器、沙箱管理器
 * - 记忆系统：向量存储、工作记忆、短期记忆、长期记忆
 * - 对话引擎：聊天引擎、提示词构建器
 * - 集成服务：飞书机器人、任务调度器、心跳系统
 * - 高级功能：子代理系统、Markdown 记忆
 */

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

/**
 * 应用程序全局配置接口。
 * 定义了应用运行所需的全部配置项，包括服务端口、数据库路径、LLM 配置等。
 *
 * @interface AppConfig
 * @property {number} port - 服务监听端口号
 * @property {string} dbPath - SQLite 数据库文件路径
 * @property {string} llmApiKey - LLM 服务的 API 密钥
 * @property {string} llmModel - 使用的 LLM 模型名称
 * @property {string} env - 运行环境：development、production 或 test
 * @property {string} logLevel - 日志输出级别：debug、info、warn 或 error
 * @property {string} workspacePath - 工作区根目录路径
 */
export interface AppConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly llmApiKey: string;
  readonly llmModel: string;
  readonly env: "development" | "production" | "test";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly workspacePath: string;
}

/**
 * 应用配置服务令牌。
 * 用于从依赖注入容器中获取 AppConfig 实例。
 *
 * @const {ServiceToken<AppConfig>}
 */
export const CONFIG: ServiceToken<AppConfig> = createToken<AppConfig>("CONFIG");

/**
 * 日志记录器接口。
 * 提供分级日志输出能力，支持附加结构化元数据，并可创建带上下文的子日志记录器。
 *
 * @interface Logger
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

/**
 * 日志服务令牌。
 * 用于从依赖注入容器中获取 Logger 实例。
 *
 * @const {ServiceToken<Logger>}
 */
export const LOGGER: ServiceToken<Logger> = createToken<Logger>("LOGGER");

/**
 * 系统事件映射接口。
 * 定义了系统中所有可发布/订阅的事件类型及其载荷结构。
 * 事件分为三大类：agent 生命周期事件、tool 调用事件和 system 系统事件。
 *
 * @interface EventMap
 */
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

/**
 * 事件总线接口。
 * 提供类型安全的发布/订阅（Pub/Sub）事件系统，所有事件类型由 EventMap 约束。
 *
 * @interface EventBus
 */
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

/**
 * 事件总线服务令牌。
 * 用于从依赖注入容器中获取 EventBus 实例。
 *
 * @const {ServiceToken<EventBus>}
 */
export const EVENT_BUS: ServiceToken<EventBus> =
  createToken<EventBus>("EVENT_BUS");

/**
 * 数据库服务接口。
 * 封装了 SQLite 数据库的核心操作，提供查询、执行、事务和生命周期管理功能。
 *
 * @interface Database
 */
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

/**
 * 数据库服务令牌。
 * 用于从依赖注入容器中获取 Database 实例。
 *
 * @const {ServiceToken<Database>}
 */
export const DATABASE: ServiceToken<Database> =
  createToken<Database>("DATABASE");

/**
 * LLM 调用选项接口。
 * 用于配置大语言模型生成时的参数。
 *
 * @interface LLMOptions
 * @property {number} [temperature] - 生成温度，控制输出的随机性（0-2）
 * @property {number} [maxTokens] - 最大生成 token 数
 * @property {string} [systemPrompt] - 系统提示词，用于设定 LLM 的角色和行为约束
 */
export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * 大语言模型服务接口。
 * 提供文本生成、流式输出和结构化对象生成三种调用模式。
 *
 * @interface LLMService
 */
export interface LLMService {
  generateText(prompt: string, options?: LLMOptions): Promise<string>;
  streamText(prompt: string, options?: LLMOptions): AsyncIterable<string>;
  generateObject<T>(
    prompt: string,
    schema: unknown,
    options?: LLMOptions,
  ): Promise<T>;
}

/**
 * LLM 服务令牌。
 * 用于从依赖注入容器中获取 LLMService 实例。
 *
 * @const {ServiceToken<LLMService>}
 */
export const LLM_SERVICE: ServiceToken<LLMService> =
  createToken<LLMService>("LLM_SERVICE");

/**
 * 智能体执行结果接口。
 * 包含智能体完成一次任务后的完整输出信息。
 *
 * @interface AgentResult
 * @property {string} text - 智能体的最终文本响应
 * @property {number} steps - 完成任务所用的步骤数
 * @property {Array} toolCalls - 执行过程中的工具调用记录列表
 */
export interface AgentResult {
  text: string;
  steps: number;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
}

/**
 * 智能体核心接口。
 * 定义了智能体的运行和中止操作，是智能体系统的核心抽象。
 *
 * @interface AgentCore
 */
export interface AgentCore {
  run(sessionId: string, prompt: string): Promise<AgentResult>;
  abort(sessionId: string): void;
}

/**
 * 智能体核心服务令牌。
 * 用于从依赖注入容器中获取 AgentCore 实例。
 *
 * @const {ServiceToken<AgentCore>}
 */
export const AGENT_CORE: ServiceToken<AgentCore> =
  createToken<AgentCore>("AGENT_CORE");

/**
 * 沙箱管理器接口。
 * 管理隔离执行环境的生命周期，提供沙箱的获取、释放和命令执行功能。
 *
 * @interface SandboxManager
 */
export interface SandboxManager {
  initialize(): Promise<void>;
  acquire(sessionId: string): Promise<SandboxInstance>;
  release(sessionId: string): Promise<void>;
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  dispose(): Promise<void>;
}

/**
 * 沙箱管理器服务令牌。
 * 用于从依赖注入容器中获取 SandboxManager 实例。
 *
 * @const {ServiceToken<SandboxManager>}
 */
export const SANDBOX_MANAGER: ServiceToken<SandboxManager> =
  createToken<SandboxManager>("SANDBOX_MANAGER");

// ===== Tool System =====

/**
 * 工具注册表接口。
 * 管理系统中所有可用工具的注册、注销和查询。
 *
 * @interface ToolRegistry
 * @property {number} size - 当前已注册工具的数量（只读）
 */
export interface ToolRegistry {
  register(tool: FlashClawToolDefinition<any, any>): void;
  unregister(name: string): boolean;
  get(name: string): FlashClawToolDefinition<any, any> | undefined;
  getAll(): FlashClawToolDefinition<any, any>[];
  readonly size: number;
}

/**
 * 工具注册表服务令牌。
 * 用于从依赖注入容器中获取 ToolRegistry 实例。
 *
 * @const {ServiceToken<ToolRegistry>}
 */
export const TOOL_REGISTRY: ServiceToken<ToolRegistry> =
  createToken<ToolRegistry>("TOOL_REGISTRY");

/**
 * 工具执行器接口。
 * 负责执行已注册的工具，并返回包含执行结果、耗时和元数据的完整响应。
 *
 * @interface ToolExecutor
 */
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

/**
 * 工具执行器服务令牌。
 * 用于从依赖注入容器中获取 ToolExecutor 实例。
 *
 * @const {ServiceToken<ToolExecutor>}
 */
export const TOOL_EXECUTOR: ServiceToken<ToolExecutor> =
  createToken<ToolExecutor>("TOOL_EXECUTOR");

// ===== Memory System =====

/**
 * 向量嵌入服务接口。
 * 提供文本到向量的转换能力，支持单条和批量嵌入操作。
 *
 * @interface IEmbeddingService
 * @property {number} dimensions - 嵌入向量的维度数（只读）
 * @property {string} providerName - 嵌入服务提供商名称（只读）
 * @property {boolean} isReady - 服务是否已就绪（只读）
 */
export interface IEmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly providerName: string;
  readonly isReady: boolean;
  initialize(): Promise<void>;
}

/**
 * 向量嵌入服务令牌。
 * 用于从依赖注入容器中获取 IEmbeddingService 实例。
 *
 * @const {ServiceToken<IEmbeddingService>}
 */
export const EMBEDDING_SERVICE: ServiceToken<IEmbeddingService> =
  createToken<IEmbeddingService>("EMBEDDING_SERVICE");

/**
 * 向量存储接口。
 * 提供向量索引的 CRUD 操作，支持向量检索、全文检索和混合检索三种搜索模式。
 *
 * @interface IVectorStore
 */
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

/**
 * 向量存储服务令牌。
 * 用于从依赖注入容器中获取 IVectorStore 实例。
 *
 * @const {ServiceToken<IVectorStore>}
 */
export const VECTOR_STORE: ServiceToken<IVectorStore> =
  createToken<IVectorStore>("VECTOR_STORE");

/**
 * 工作记忆接口。
 * 管理会话级别的对话上下文，提供消息追加、检索、压缩和统计功能。
 * 支持自动压缩机制以控制 token 预算，并提供内存刷新回调。
 *
 * @interface IWorkingMemory
 */
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

/**
 * 工作记忆服务令牌。
 * 用于从依赖注入容器中获取 IWorkingMemory 实例。
 *
 * @const {ServiceToken<IWorkingMemory>}
 */
export const WORKING_MEMORY: ServiceToken<IWorkingMemory> =
  createToken<IWorkingMemory>("WORKING_MEMORY");

/**
 * 短期记忆接口。
 * 基于数据库持久化的会话历史记录管理，提供消息存储、检索和定期清理功能。
 *
 * @interface IShortTermMemory
 */
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

/**
 * 短期记忆服务令牌。
 * 用于从依赖注入容器中获取 IShortTermMemory 实例。
 *
 * @const {ServiceToken<IShortTermMemory>}
 */
export const SHORT_TERM_MEMORY: ServiceToken<IShortTermMemory> =
  createToken<IShortTermMemory>("SHORT_TERM_MEMORY");

/**
 * 长期记忆接口。
 * 提供持久化的知识存储和语义检索能力，用于跨会话的记忆保持。
 *
 * @interface ILongTermMemory
 */
export interface ILongTermMemory {
  store(entry: unknown): Promise<string>;
  recall(query: unknown): Promise<unknown[]>;
}

/**
 * 长期记忆服务令牌。
 * 用于从依赖注入容器中获取 ILongTermMemory 实例。
 *
 * @const {ServiceToken<ILongTermMemory>}
 */
export const LONG_TERM_MEMORY: ServiceToken<ILongTermMemory> =
  createToken<ILongTermMemory>("LONG_TERM_MEMORY");

/**
 * 用户画像服务接口。
 * 提供用户个人资料的读取和更新功能，用于个性化交互。
 *
 * @interface IUserProfile
 */
export interface IUserProfile {
  getProfile(userId: string): Promise<UserProfile>;
  updateProfile(userId: string, updates: Partial<UserProfile>): Promise<void>;
}

/**
 * 用户画像服务令牌。
 * 用于从依赖注入容器中获取 IUserProfile 实例。
 *
 * @const {ServiceToken<IUserProfile>}
 */
export const USER_PROFILE: ServiceToken<IUserProfile> =
  createToken<IUserProfile>("USER_PROFILE");

/**
 * 记忆管理器接口。
 * 统一管理所有记忆子系统的高层接口，协调记忆的存储、检索、交互记录和清理。
 * 同时整合用户画像功能，提供完整的记忆管理能力。
 *
 * @interface IMemoryManager
 */
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

/**
 * 记忆管理器服务令牌。
 * 用于从依赖注入容器中获取 IMemoryManager 实例。
 *
 * @const {ServiceToken<IMemoryManager>}
 */
export const MEMORY_MANAGER: ServiceToken<IMemoryManager> =
  createToken<IMemoryManager>("MEMORY_MANAGER");

/**
 * 上下文预算管理器接口。
 * 管理 LLM 调用时的 token 预算分配，提供 token 估算、历史截断和动态重平衡功能。
 *
 * @interface IContextBudget
 * @property {number} totalBudget - 总 token 预算上限（只读）
 */
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

/**
 * 上下文预算管理器服务令牌。
 * 用于从依赖注入容器中获取 IContextBudget 实例。
 *
 * @const {ServiceToken<IContextBudget>}
 */
export const CONTEXT_BUDGET: ServiceToken<IContextBudget> =
  createToken<IContextBudget>("CONTEXT_BUDGET");

/**
 * 智能体上下文接口。
 * 包含智能体在处理请求时所需的全部上下文信息，包括用户资料、对话历史、
 * 活动技能和相关记忆。
 *
 * @interface AgentContext
 * @property {object} user - 用户信息摘要
 * @property {ConversationMessage[]} history - 当前会话的对话历史
 * @property {unknown[]} activeSkills - 当前激活的技能列表
 * @property {MemoryEntry[]} memories - 与当前上下文相关的记忆条目
 */
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

/**
 * 提示词构建器接口。
 * 根据智能体上下文和用户消息构建发送给 LLM 的完整提示词消息序列。
 *
 * @interface IPromptBuilder
 */
export interface IPromptBuilder {
  build(
    context: AgentContext,
    userMessage: string,
  ): Promise<ConversationMessage[]>;
  estimateTokens(messages: ConversationMessage[]): number;
}

/**
 * 提示词构建器服务令牌。
 * 用于从依赖注入容器中获取 IPromptBuilder 实例。
 *
 * @const {ServiceToken<IPromptBuilder>}
 */
export const PROMPT_BUILDER: ServiceToken<IPromptBuilder> =
  createToken<IPromptBuilder>("PROMPT_BUILDER");

/**
 * 聊天引擎接口。
 * 核心对话处理引擎，整合 LLM、记忆、工具和任务调度等子系统，
 * 提供完整的对话处理流程。支持动态设置各子系统依赖。
 *
 * @interface IChatEngine
 */
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

/**
 * 聊天引擎服务令牌。
 * 用于从依赖注入容器中获取 IChatEngine 实例。
 *
 * @const {ServiceToken<IChatEngine>}
 */
export const CHAT_ENGINE: ServiceToken<IChatEngine> =
  createToken<IChatEngine>("CHAT_ENGINE");

/**
 * 飞书机器人接口。
 * 封装飞书开放平台的机器人能力，提供事件处理、消息发送和通知推送等功能。
 *
 * @interface IFeishuBot
 */
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

/**
 * 飞书机器人服务令牌。
 * 用于从依赖注入容器中获取 IFeishuBot 实例。
 *
 * @const {ServiceToken<IFeishuBot>}
 */
export const FEISHU_BOT: ServiceToken<IFeishuBot> =
  createToken<IFeishuBot>("FEISHU_BOT");

/**
 * 任务调度器接口。
 * 提供定时任务和一次性任务的完整生命周期管理，支持 CRON 表达式调度、
 * 任务执行、结果通知和运行记录查询。
 *
 * @interface ITaskScheduler
 */
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

/**
 * 任务调度器服务令牌。
 * 用于从依赖注入容器中获取 ITaskScheduler 实例。
 *
 * @const {ServiceToken<ITaskScheduler>}
 */
export const TASK_SCHEDULER: ServiceToken<ITaskScheduler> =
  createToken<ITaskScheduler>("TASK_SCHEDULER");

/**
 * 心跳检测系统接口。
 * 提供系统健康检查和存活检测功能，可集成聊天引擎、任务调度器和飞书机器人
 * 进行全方位的健康状态监控和告警通知。
 *
 * @interface IHeartbeatSystem
 */
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

/**
 * 心跳检测系统服务令牌。
 * 用于从依赖注入容器中获取 IHeartbeatSystem 实例。
 *
 * @const {ServiceToken<IHeartbeatSystem>}
 */
export const HEARTBEAT_SYSTEM: ServiceToken<IHeartbeatSystem> =
  createToken<IHeartbeatSystem>("HEARTBEAT_SYSTEM");

/**
 * 子代理系统接口。
 * 管理子代理（Sub-Agent）的创建、运行和监控。支持在独立会话中并行执行子任务，
 * 提供运行状态查询、强制终止和生命周期管理功能。
 *
 * @interface ISubAgentSystem
 */
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

/**
 * 子代理系统服务令牌。
 * 用于从依赖注入容器中获取 ISubAgentSystem 实例。
 *
 * @const {ServiceToken<ISubAgentSystem>}
 */
export const SUB_AGENT_SYSTEM: ServiceToken<ISubAgentSystem> =
  createToken<ISubAgentSystem>("SUB_AGENT_SYSTEM");

/**
 * Markdown 记忆接口。
 * 基于 Markdown 文件的持久化记忆系统，提供每日日志、摘要、记忆检索和
 * 内容整合等功能。适用于需要人类可读格式的记忆存储场景。
 *
 * @interface IMarkdownMemory
 */
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

/**
 * Markdown 记忆服务令牌。
 * 用于从依赖注入容器中获取 IMarkdownMemory 实例。
 *
 * @const {ServiceToken<IMarkdownMemory>}
 */
export const MARKDOWN_MEMORY: ServiceToken<IMarkdownMemory> =
  createToken<IMarkdownMemory>("MARKDOWN_MEMORY");

/**
 * HTTP 服务应用接口。
 * 兼容 Hono 框架的 HTTP 请求处理接口，提供标准的 Fetch API 风格请求处理。
 *
 * @interface HonoApp
 */
export interface HonoApp {
  fetch(request: Request, Env?: {} | unknown, executionCtx?: unknown): Response | Promise<Response>;
}

/**
 * HTTP 服务器服务令牌。
 * 用于从依赖注入容器中获取 HonoApp 实例。
 *
 * @const {ServiceToken<HonoApp>}
 */
export const HTTP_SERVER: ServiceToken<HonoApp> =
  createToken<HonoApp>("HTTP_SERVER");
