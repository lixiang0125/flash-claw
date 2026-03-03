import { Container } from "./container";
import { Lifecycle } from "./types";
import type { ServiceResolver } from "./types";
import {
  CONFIG,
  LOGGER,
  EVENT_BUS,
  DATABASE,
  LLM_SERVICE,
  AGENT_CORE,
  SANDBOX_MANAGER,
  TOOL_REGISTRY,
  TOOL_EXECUTOR,
  EMBEDDING_SERVICE,
  VECTOR_STORE,
  WORKING_MEMORY,
  SHORT_TERM_MEMORY,
  LONG_TERM_MEMORY,
  USER_PROFILE,
  MEMORY_MANAGER,
  CONTEXT_BUDGET,
  PROMPT_BUILDER,
  type AppConfig,
  type Logger,
  type Database,
  type LLMService,
  type AgentCore,
  type EventBus,
  type SandboxManager,
  type ToolRegistry as IToolRegistry,
  type ToolExecutor as IToolExecutor,
  type IEmbeddingService,
  type IVectorStore,
  type ILongTermMemory,
  type IMemoryManager,
  type IPromptBuilder,
  type IContextBudget,
} from "./tokens";
import { TypedEventBus } from "./event-bus";
import { createLLMService } from "./llm-service";
import { createSandboxManager } from "../../tools/sandbox";
import { ToolRegistry } from "../../tools/tool-registry";
import { ToolExecutor } from "../../tools/tool-executor";
import { readFileTool } from "../../tools/builtin/read-file";
import { writeFileTool } from "../../tools/builtin/write-file";
import { editFileTool } from "../../tools/builtin/edit-file";
import { bashTool } from "../../tools/builtin/bash";
import { globTool } from "../../tools/builtin/glob";
import { grepTool } from "../../tools/builtin/grep";
import { webSearchTool } from "../../tools/builtin/web-search";

export {
  CONFIG,
  LOGGER,
  EVENT_BUS,
  DATABASE,
  LLM_SERVICE,
  AGENT_CORE,
  SANDBOX_MANAGER,
  TOOL_REGISTRY,
  TOOL_EXECUTOR,
};
export type {
  AppConfig,
  Logger,
  Database,
  LLMService,
  AgentCore,
  EventBus,
  SandboxManager,
  IToolRegistry,
  IToolExecutor,
};

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env["PORT"] ?? "3000"),
    dbPath: process.env["DB_PATH"] ?? "./data/FlashClaw.db",
    llmApiKey: process.env["LLM_API_KEY"] ?? "",
    llmModel: process.env["LLM_MODEL"] ?? "gpt-4o",
    env: (process.env["NODE_ENV"] as AppConfig["env"]) ?? "development",
    logLevel: (process.env["LOG_LEVEL"] as AppConfig["logLevel"]) ?? "info",
  };
}

export function createLogger(config: AppConfig): Logger {
  const pino = require("pino");

  const logger = pino({
    level: config.logLevel,
    transport: config.env === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
    serializers: {
      err: pino.stdSerializers.err,
    },
  });

  function createLoggerInstance(context: Record<string, unknown> = {}): Logger {
    const child = logger.child(context);
    return {
      debug(message: string, meta?: Record<string, unknown>) {
        child.debug(meta, message);
      },
      info(message: string, meta?: Record<string, unknown>) {
        child.info(meta, message);
      },
      warn(message: string, meta?: Record<string, unknown>) {
        child.warn(meta, message);
      },
      error(message: string, meta?: Record<string, unknown>) {
        if (meta?.err) {
          child.error(meta, message);
        } else {
          child.error(meta, message);
        }
      },
      child(childContext: Record<string, unknown>): Logger {
        return createLoggerInstance({ ...context, ...childContext });
      },
    };
  }

  return createLoggerInstance();
}

export function createDatabase(
  config: AppConfig,
  logger: Logger,
): Database {
  let db: any = null;

  return {
    async initialize(): Promise<void> {
      logger.info("正在初始化数据库连接...", { path: config.dbPath });
      const { Database: BunSQLite } = await import("bun:sqlite");
      db = new BunSQLite(config.dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      logger.info("数据库初始化完成");
    },

    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      return db.prepare(sql).all(...(params ?? [])) as T[];
    },

    execute(
      sql: string,
      params?: unknown[],
    ): { changes: number; lastInsertRowid: number } {
      const result = db.prepare(sql).run(...(params ?? []));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    close(): void {
      if (db) {
        db.close();
        db = null;
      }
    },

    async dispose(): Promise<void> {
      this.close();
      logger.info("数据库连接已关闭");
    },
  };
}

export function createContainer(): Container {
  const container = new Container({ enableLogging: true });

  // 注册 CONFIG (无依赖)
  container.register({
    token: CONFIG,
    lifecycle: Lifecycle.Singleton,
    factory: () => loadConfig(),
  });

  // 注册 LOGGER (依赖 CONFIG)
  container.register({
    token: LOGGER,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const config = resolver.resolve(CONFIG);
      return createLogger(config);
    },
  });

  // 注册 EVENT_BUS (依赖 LOGGER)
  container.register({
    token: EVENT_BUS,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      return new TypedEventBus(logger);
    },
  });

  // 注册 DATABASE (依赖 CONFIG, LOGGER, EVENT_BUS)
  container.register({
    token: DATABASE,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const config = resolver.resolve(CONFIG);
      const logger = resolver.resolve(LOGGER);
      return createDatabase(config, logger);
    },
  });

  // 注册 LLM_SERVICE (依赖 CONFIG, LOGGER)
  container.register({
    token: LLM_SERVICE,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
      return createLLMService();
    },
  });

  // 注册 SANDBOX_MANAGER (依赖 LOGGER)
  container.register({
    token: SANDBOX_MANAGER,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const useDocker = process.env.USE_DOCKER_SANDBOX === "true";
      return createSandboxManager({ useDocker }, logger);
    },
  });

  // 注册 TOOL_REGISTRY (依赖 LOGGER)
  container.register({
    token: TOOL_REGISTRY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const registry = new ToolRegistry(logger);
      registry.register(readFileTool);
      registry.register(writeFileTool);
      registry.register(editFileTool);
      registry.register(bashTool);
      registry.register(globTool);
      registry.register(grepTool);
      registry.register(webSearchTool);
      return registry;
    },
  });

  // 注册 TOOL_EXECUTOR (依赖 SANDBOX_MANAGER, TOOL_REGISTRY, LOGGER)
  container.register({
    token: TOOL_EXECUTOR,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const sandboxManager = resolver.resolve(SANDBOX_MANAGER);
      const toolRegistry = resolver.resolve(TOOL_REGISTRY);
      const { SecurityLayer } = require("../../security/security-layer");
      const securityLayer = new SecurityLayer(undefined, logger);
      return new ToolExecutor(
        new Map(toolRegistry.getAll().map((t: any) => [t.name, t])),
        sandboxManager as any,
        securityLayer,
        logger
      );
    },
  });

  // ===== Memory System =====

  // 嵌入服务
  container.register({
    token: EMBEDDING_SERVICE,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const mainDb = resolver.resolve(DATABASE);
      const { TransformersEmbeddingProvider, OllamaEmbeddingProvider, EmbeddingService } = require("../../memory/embedding");
      const providers = [
        new TransformersEmbeddingProvider(),
        new OllamaEmbeddingProvider(),
      ];
      const service = new EmbeddingService(providers, mainDb as any, logger);
      service.initialize();
      return service;
    },
  });

  // 向量存储
  container.register({
    token: VECTOR_STORE,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const mainDb = resolver.resolve(DATABASE);
      const { VectorStore } = require("../../memory/vector-store");
      const store = new VectorStore(mainDb as any, logger, { dimensions: 384 });
      store.initialize();
      return store;
    },
  });

  // 工作记忆
  container.register({
    token: WORKING_MEMORY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const { WorkingMemory } = require("../../memory/working-memory");
      return new WorkingMemory({ maxMessages: 50, maxTokens: 30000 });
    },
  });

  // 短期记忆
  container.register({
    token: SHORT_TERM_MEMORY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const mainDb = resolver.resolve(DATABASE);
      const { ShortTermMemory } = require("../../memory/short-term-memory");
      const stm = new ShortTermMemory(mainDb as any);
      stm.initialize();
      return stm;
    },
  });

  // 长期记忆
  container.register({
    token: LONG_TERM_MEMORY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const mainDb = resolver.resolve(DATABASE);
      const vectorStore = resolver.resolve(VECTOR_STORE);
      const embeddingService = resolver.resolve(EMBEDDING_SERVICE);
      const { LongTermMemory } = require("../../memory/long-term-memory");
      return new LongTermMemory(
        vectorStore as any,
        embeddingService as any,
        mainDb as any,
        logger,
      );
    },
  });

  // 用户画像
  container.register({
    token: USER_PROFILE,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const mainDb = resolver.resolve(DATABASE);
      const { UserProfileService } = require("../../memory/user-profile");
      return new UserProfileService(mainDb as any, logger);
    },
  });

  // 记忆管理器
  container.register({
    token: MEMORY_MANAGER,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const workingMemory = resolver.resolve(WORKING_MEMORY);
      const shortTermMemory = resolver.resolve(SHORT_TERM_MEMORY);
      const longTermMemory = resolver.resolve(LONG_TERM_MEMORY);
      const userProfile = resolver.resolve(USER_PROFILE);
      const { MemoryManager } = require("../../memory/memory-manager");
      return new MemoryManager(
        workingMemory as any,
        shortTermMemory as any,
        longTermMemory as any,
        userProfile as any,
        logger,
      );
    },
  });

  // 上下文预算
  container.register({
    token: CONTEXT_BUDGET,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
      const { ContextBudget } = require("../../memory/context-budget");
      return new ContextBudget();
    },
  });

  // PromptBuilder
  container.register({
    token: PROMPT_BUILDER,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const contextBudget = resolver.resolve(CONTEXT_BUDGET);
      const memoryManager = resolver.resolve(MEMORY_MANAGER);
      const { PromptBuilder } = require("../../agent/prompt-builder");
      return new PromptBuilder(
        contextBudget as any,
        memoryManager as any,
        logger,
      );
    },
  });

  return container;
}

export async function bootstrap(): Promise<Container> {
  const container = createContainer();

  // 异步初始化所有服务
  await container.initializeAll();

  // 触发系统就绪事件
  const eventBus = container.resolve(EVENT_BUS);
  eventBus.emit("system:ready", { timestamp: Date.now() });

  return container;
}
