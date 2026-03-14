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
  CHAT_ENGINE,
  FEISHU_BOT,
  TASK_SCHEDULER,
  HEARTBEAT_SYSTEM,
  SUB_AGENT_SYSTEM,
  HTTP_SERVER,
  WORKING_MEMORY,
  SHORT_TERM_MEMORY,
  USER_PROFILE,
  MEMORY_MANAGER,
  CONTEXT_BUDGET,
  PROMPT_BUILDER,
  MARKDOWN_MEMORY,
  type AppConfig,
  type Logger,
  type Database,
  type LLMService,
  type AgentCore,
  type EventBus,
  type SandboxManager,
  type ToolRegistry as IToolRegistry,
  type ToolExecutor as IToolExecutor,
  type IMemoryManager,
  type IPromptBuilder,
  type IContextBudget,
  type IChatEngine,
  type IFeishuBot,
  type ITaskScheduler,
  type IHeartbeatSystem,
  type ISubAgentSystem,
  type HonoApp,
} from "./tokens";
import { TypedEventBus } from "./event-bus";
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
import { chatEngine } from "../../chat/engine";
import { feishuBot } from "../../integrations/feishu";
import { taskScheduler } from "../../tasks";
import { heartbeatSystem } from "../../heartbeat";
import { subAgentSystem } from "../../subagents";
import { Hono } from "hono";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatRequest } from "../../chat/types";
import pino from "pino";
import { WorkingMemory } from "../../memory/working-memory";
import { ShortTermMemory } from "../../memory/short-term-memory";
import { UserProfileService } from "../../memory/user-profile";
import { Mem0MemoryManager } from "../../memory/mem0-memory-manager";
import { createMem0Memory } from "../../memory/mem0-factory";
import { ContextBudget } from "../../memory/context-budget";
import { MarkdownMemory } from "../../memory/markdown-memory";
import { DailySummarizer } from "../../memory/daily-summarizer";
import { SecurityLayer } from "../../security/security-layer";
import { PromptBuilder } from "../../agent/prompt-builder";
import { createHonoApp } from "../../infra/hono-app";

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
  CHAT_ENGINE,
  FEISHU_BOT,
  TASK_SCHEDULER,
  HEARTBEAT_SYSTEM,
  SUB_AGENT_SYSTEM,
  HTTP_SERVER,
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
    workspacePath: process.env["WORKSPACE_PATH"] ?? "./data/workspace",
  };
}

export function createLogger(config: AppConfig): Logger {
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

    exec(sql: string): void {
      db.exec(sql);
    },

    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
      return db.prepare(sql).get(...(params ?? [])) as T | null;
    },

    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      return db.prepare(sql).all(...(params ?? [])) as T[];
    },

    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number } {
      return db.prepare(sql).run(...(params ?? []));
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

  // 工作记忆
  container.register({
    token: WORKING_MEMORY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const config = resolver.resolve(CONFIG);
      const markdownMemory = resolver.resolve(MARKDOWN_MEMORY);

      const workingMemory = new WorkingMemory({ maxMessages: 50, maxTokens: 30000 });

      // Pre-compaction agentic flush (OpenClaw-style)
      // When context nears overflow, a silent LLM turn extracts durable memories
      const dailySummarizer = new DailySummarizer(logger);

      workingMemory.setFlushCallback(async (sessionId, recentMessages) => {
        const today = new Date().toISOString().split("T")[0]!;
        try {
          const extracted = await dailySummarizer.extractMemories(recentMessages, sessionId);
          if (extracted) {
            await markdownMemory.writeDailySummary(today, extracted);
            logger.info(`Pre-compaction agentic flush: wrote memories to ${today}.md`, {
              sessionId: sessionId.slice(0, 8),
              length: extracted.length,
            });
          } else {
            logger.debug(`Pre-compaction flush: nothing worth saving (session ${sessionId.slice(0, 8)})`);
          }
        } catch (err) {
          logger.error("Pre-compaction agentic flush failed, falling back to raw log", { err });
          // Fallback: write raw messages so we don't lose data
          const logContent = recentMessages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => `- **${m.role}**: ${m.content.slice(0, 200)}`)
            .join("\n");
          if (logContent) {
            await markdownMemory.appendDailyLog(`## ${sessionId.slice(0, 8)}\n${logContent}\n`);
          }
        }
      });

      return workingMemory;
    },
  });

  // Markdown 文件存储
  container.register({
    token: MARKDOWN_MEMORY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const config = resolver.resolve(CONFIG);
      const markdownMemory = new MarkdownMemory(logger, {
        workspacePath: config.workspacePath,
        enableDailyLogs: true,
        enableMemoryFile: true,
      });
      markdownMemory.initialize();
      return markdownMemory;
    },
  });

  // 短期记忆
  container.register({
    token: SHORT_TERM_MEMORY,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const mainDb = resolver.resolve(DATABASE);
      const stm = new ShortTermMemory(mainDb as any);
      stm.initialize();
      return stm;
    },
  });

  // 用户画像
  container.register({
    token: USER_PROFILE,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const mainDb = resolver.resolve(DATABASE);
      return new UserProfileService(mainDb as any, logger);
    },
  });

  // 记忆管理器 (mem0)
  container.register({
    token: MEMORY_MANAGER,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const workingMemory = resolver.resolve(WORKING_MEMORY);
      const shortTermMemory = resolver.resolve(SHORT_TERM_MEMORY);
      const markdownMemory = resolver.resolve(MARKDOWN_MEMORY);
      const userProfile = resolver.resolve(USER_PROFILE);
      const mem0Memory = createMem0Memory(logger);
      return new Mem0MemoryManager(
        logger,
        workingMemory as any,
        shortTermMemory as any,
        mem0Memory,
        markdownMemory as any,
        userProfile as any,
      );
    },
  });

  // 上下文预算
  container.register({
    token: CONTEXT_BUDGET,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
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
      return new PromptBuilder(
        contextBudget as any,
        memoryManager as any,
        logger,
      );
    },
  });

  // ===== Application Services =====

  // ChatEngine
  container.register({
    token: CHAT_ENGINE,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const logger = resolver.resolve(LOGGER);
      const toolRegistry = resolver.resolve(TOOL_REGISTRY);
      const toolExecutor = resolver.resolve(TOOL_EXECUTOR);
      const memoryManager = resolver.resolve(MEMORY_MANAGER);

      function toQwenTools(tools: any): any[] {
        const fromZod = (schema: any) => {
          if (!schema) return { type: "object", properties: {} };
          try {
            return zodToJsonSchema(schema) || { type: "object", properties: {} };
          } catch {
            return { type: "object", properties: {} };
          }
        };

        if (Array.isArray(tools)) {
          return tools.map((t: any) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: fromZod(t.inputSchema),
            },
          }));
        }
        return Object.values(tools).map((t: any) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: fromZod(t.inputSchema),
          },
        }));
      }

      const qwenTools = toQwenTools(toolRegistry.getAll());
      chatEngine.setTools(qwenTools as any);
      chatEngine.setToolExecutor(async (name: string, args: Record<string, unknown>, sessionId: string) => {
        logger.debug(`[TOOL_CALL] ${name}`, { args: JSON.stringify(args).substring(0, 200) });
        const execResult = await toolExecutor.execute(name, args, sessionId) as { success: boolean; output?: string; error?: string };
        logger.debug(`[TOOL_RESULT] ${name}`, { success: execResult.success, error: execResult.error });
        return { result: execResult.output, error: execResult.error || undefined };
      });
      chatEngine.setMemoryManager(memoryManager as any);

      // Wire WorkingMemory as single source of truth for session history
      const workingMemory = resolver.resolve(WORKING_MEMORY);
      chatEngine.setWorkingMemory(workingMemory as any);

      // 注入任务调度器 API，使 ChatEngine 能从用户消息中创建定时任务
      chatEngine.setTaskScheduler(taskScheduler as any);

      logger.info("ChatEngine initialized with tools", { toolCount: qwenTools.length });

      return chatEngine as any;
    },
  });

  // FeishuBot — DI wiring deferred to bootstrap() after all services resolve
  container.register({
    token: FEISHU_BOT,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
      return feishuBot as any;
    },
  });

  // TaskScheduler
  container.register({
    token: TASK_SCHEDULER,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
      return taskScheduler as any;
    },
  });

  // HeartbeatSystem
  container.register({
    token: HEARTBEAT_SYSTEM,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
      return heartbeatSystem as any;
    },
  });

  // SubAgentSystem
  container.register({
    token: SUB_AGENT_SYSTEM,
    lifecycle: Lifecycle.Singleton,
    factory: () => {
      return subAgentSystem as any;
    },
  });

  // Hono HTTP Server
  container.register({
    token: HTTP_SERVER,
    lifecycle: Lifecycle.Singleton,
    factory: (resolver) => {
      const chatEngine = resolver.resolve(CHAT_ENGINE);
      const feishuBot = resolver.resolve(FEISHU_BOT);
      const taskScheduler = resolver.resolve(TASK_SCHEDULER);
      const heartbeatSystem = resolver.resolve(HEARTBEAT_SYSTEM);
      const subAgentSystem = resolver.resolve(SUB_AGENT_SYSTEM);
      const logger = resolver.resolve(LOGGER);

      return createHonoApp({
        chatEngine: chatEngine as any,
        feishuBot: feishuBot as any,
        taskScheduler: taskScheduler as any,
        heartbeatSystem: heartbeatSystem as any,
        subAgentSystem: subAgentSystem as any,
        logger,
      }) as any;
    },
  });

  return container;
}

export async function bootstrap(): Promise<Container> {
  const container = createContainer();

  // 异步初始化所有服务
  await container.initializeAll();

  // Wire TaskScheduler executor & notifier, then start
  try {
    const ts = container.resolve(TASK_SCHEDULER) as any;
    const ce = container.resolve(CHAT_ENGINE) as any;
    const fb = container.resolve(FEISHU_BOT) as any;
    const tsLogger = container.resolve(LOGGER);

    // 注入任务执行器：每个任务通过 ChatEngine 处理并返回结果
    ts.setExecutor(async (taskMessage: string, taskId: string) => {
      tsLogger.info(`[TaskScheduler] Executing task ${taskId}`);
      const result = await ce.chat({ message: taskMessage, sessionId: `task_${taskId}` });
      return (result as any).response || String(result);
    });

    // 注入通知器：任务执行完成后通过飞书发送结果
    ts.setNotifier(async (taskName: string, result: string) => {
      if (fb.isConfigured()) {
        try {
          const lastChatId = ts.getLastChatId?.() || "";
          if (!lastChatId) {
            tsLogger.warn("[TaskScheduler] No lastChatId, skipping notification");
            return;
          }
          const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
          await fb.notify(lastChatId, `✅ 任务「${taskName}」执行完成:\n${summary}`);
        } catch (e) {
          tsLogger.error("[TaskScheduler] Notification send failed", { err: e });
        }
      }
    });

    ts.start();
    tsLogger.info("TaskScheduler wired and started");

    // 注入飞书机器人的依赖：ChatEngine + TaskScheduler，然后启动
    fb.setChatEngine(ce);
    fb.setTaskScheduler(ts);
    fb.start();
    tsLogger.info("FeishuBot DI wired and started");
  } catch (err) {
    const logger = container.resolve(LOGGER);
    logger.error("TaskScheduler wiring failed (non-fatal)", { err });
  }

  // Periodic consolidation: extract durable facts from daily logs to MEMORY.md
  // Runs once on startup if last consolidation was > 24h ago
  try {
    const markdownMemory = container.resolve(MARKDOWN_MEMORY);
    const logger = container.resolve(LOGGER);
    const lastDate = await markdownMemory.getLastConsolidationDate();
    const today = new Date().toISOString().split("T")[0]!;
    const shouldConsolidate = !lastDate || lastDate < today;
    
    if (shouldConsolidate) {
      const dailyLogs = await markdownMemory.getDailyLogs(7);
      if (dailyLogs.length > 0) {
        const existingMemory = await markdownMemory.readMemoryFile();
        const dailySummarizer = new DailySummarizer(logger);
        const newFacts = await dailySummarizer.consolidateDailyLogs(dailyLogs, existingMemory);
        if (newFacts) {
          await markdownMemory.appendConsolidatedMemory(newFacts);
          logger.info("Startup consolidation: new facts added to MEMORY.md");
        } else {
          logger.debug("Startup consolidation: nothing new to add");
        }
      }
    }
  } catch (err) {
    const logger = container.resolve(LOGGER);
    logger.error("Startup memory consolidation failed (non-fatal)", { err });
  }

  // 触发系统就绪事件
  const eventBus = container.resolve(EVENT_BUS);
  eventBus.emit("system:ready", { timestamp: Date.now() });

  return container;
}
