import { createToken, type ServiceToken } from "./types";

export interface AppConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly llmApiKey: string;
  readonly llmModel: string;
  readonly env: "development" | "production" | "test";
  readonly logLevel: "debug" | "info" | "warn" | "error";
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
