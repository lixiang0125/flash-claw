import "dotenv/config";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { chatEngine, type ChatRequest } from "./chat";
import { listSkills, searchSkills, getSkill, executeScript } from "./skills";
import { feishuBot } from "./integrations/feishu";
import { taskScheduler } from "./tasks";
import { heartbeatSystem } from "./heartbeat";
import { subAgentSystem } from "./subagents";
import { ToolRegistry } from "./tools/tool-registry";
import { ToolExecutor } from "./tools/tool-executor";
import { createSandboxManager } from "./tools/sandbox";
import { SecurityLayer } from "./security/security-layer";
import { readFileTool } from "./tools/builtin/read-file";
import { writeFileTool } from "./tools/builtin/write-file";
import { editFileTool } from "./tools/builtin/edit-file";
import { bashTool } from "./tools/builtin/bash";
import { globTool } from "./tools/builtin/glob";
import { grepTool } from "./tools/builtin/grep";
import { webFetchTool } from "./tools/builtin/web-fetch";
import { webSearchTool } from "./tools/builtin/web-search";
import { Database } from "bun:sqlite";
import path from "path";
import {
  WorkingMemory,
  ShortTermMemory,
  VectorStore,
  LongTermMemory,
  UserProfileService,
  MemoryManager,
  OllamaEmbeddingProvider,
  createDatabaseAdapter,
} from "./memory";

const app = new Hono();

const logger = {
  info: (msg: string) => console.log("[info]", msg),
  debug: (msg: string) => console.log("[debug]", msg),
  error: (msg: string) => console.error("[error]", msg),
  warn: (msg: string) => console.warn("[warn]", msg),
};

const dbPath = path.join(process.cwd(), "data", "flashclaw.db");
const bunDb = new Database(dbPath);
const db = createDatabaseAdapter(bunDb);

const sandboxManager = createSandboxManager({}, logger);
const toolRegistry = new ToolRegistry(logger);
toolRegistry.register(readFileTool);
toolRegistry.register(writeFileTool);
toolRegistry.register(editFileTool);
toolRegistry.register(bashTool);
toolRegistry.register(globTool);
toolRegistry.register(grepTool);
toolRegistry.register(webFetchTool);
toolRegistry.register(webSearchTool);

const securityLayer = new SecurityLayer(undefined, logger);

const toolExecutor = new ToolExecutor(
  new Map(toolRegistry.getAll().map((t: any) => [t.name, t])),
  sandboxManager as any,
  securityLayer,
  logger,
);

// Initialize Memory System
const workingMemory = new WorkingMemory({ maxMessages: 50, maxTokens: 30000 });
const shortTermMemory = new ShortTermMemory(db as any);
shortTermMemory.initialize();

const vectorStore = new VectorStore(db as any, logger, { dimensions: 384 });
vectorStore.initialize().catch(err => logger.warn(`VectorStore init failed: ${err}`));

const embedder = new OllamaEmbeddingProvider();
embedder.initialize().catch(err => logger.warn(`Embedder init failed: ${err}`));

const longTermMemory = new LongTermMemory(
  vectorStore as any,
  embedder as any,
  db as any,
  logger,
);

const userProfileService = new UserProfileService(db as any, logger);

const memoryManager = new MemoryManager(
  workingMemory,
  shortTermMemory,
  longTermMemory,
  userProfileService,
  logger,
);

chatEngine.setMemoryManager(memoryManager as any);
logger.info("Memory system initialized");

import { zodToJsonSchema } from "zod-to-json-schema";

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
console.log("[DEBUG] Qwen tools:", JSON.stringify(qwenTools).substring(0, 500));
chatEngine.setTools(qwenTools as any);
chatEngine.setToolExecutor(async (name: string, args: Record<string, unknown>, sessionId: string) => {
  console.log(`[TOOL_CALL] ${name}`, JSON.stringify(args).substring(0, 200));
  const result = await toolExecutor.execute(name, args, sessionId);
  console.log(`[TOOL_RESULT] ${name}:`, result.success ? "OK" : result.error);
  console.log(`[TOOL_OUTPUT] ${name}:`, (result.output || "").substring(0, 200));
  return { result: result.output, error: result.error || undefined };
});

console.log(`Registered ${toolRegistry.size} tools:`);
toolRegistry.getAll().forEach((t: any) => console.log(`  - ${t.name}`));

app.use("/*", serveStatic({ root: "./dist" }));

app.get("/", (c) => c.text("Flash Claw Chat API"));

app.post("/api/chat", async (c) => {
  const body = await c.req.json<ChatRequest>();
  
  if (!body.message) {
    return c.json({ error: "Message is required" }, 400);
  }

  try {
    const result = await chatEngine.chat(body);
    return c.json(result);
  } catch (error) {
    console.error("Chat error:", error);
    return c.json({ error: "Chat failed" }, 500);
  }
});

app.post("/api/chat/clear", async (c) => {
  const body = await c.req.json<{ sessionId: string }>();
  
  if (!body.sessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  chatEngine.clearSession(body.sessionId);
  return c.json({ success: true });
});

app.get("/api/skills", (c) => {
  const query = c.req.query("q");
  if (query) {
    return c.json(searchSkills(query));
  }
  return c.json(listSkills());
});

app.get("/api/skills/:name", (c) => {
  const name = c.req.param("name");
  const skill = getSkill(name);
  if (!skill) {
    return c.json({ error: "Skill not found" }, 404);
  }
  return c.json(skill);
});

app.post("/api/skills/:name/exec", async (c) => {
  const name = c.req.param("name");
  const { script, args } = await c.req.json<{ script: string; args?: string[] }>();
  
  if (!script) {
    return c.json({ error: "script name is required" }, 400);
  }

  const result = executeScript(name, script, args || []);
  if (!result) {
    return c.json({ error: "Script not found" }, 404);
  }
  
  return c.json(result);
});

/**
 * 飞书 Webhook 端点
 * 用于接收飞书机器人消息
 */
app.post("/api/webhooks/feishu", async (c) => {
  if (!feishuBot.isConfigured()) {
    return c.json({ error: "Feishu bot not configured" }, 400);
  }

  try {
    const body = await c.req.json();
    const result = await feishuBot.handleEvent(body);
    return c.json(result);
  } catch (error) {
    console.error("Feishu webhook error:", error);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

/**
 * 飞书配置检查端点
 */
app.get("/api/webhooks/feishu/status", (c) => {
  return c.json({
    configured: feishuBot.isConfigured(),
    config: feishuBot.getConfig(),
  });
});

/**
 * 任务系统 API
 */
app.get("/api/tasks", (c) => {
  const tasks = taskScheduler.listTasks();
  return c.json({ tasks });
});

app.post("/api/tasks", async (c) => {
  const body = await c.req.json<{
    name: string;
    message: string;
    schedule: string;
    enabled?: boolean;
  }>();

  if (!body.name || !body.message || !body.schedule) {
    return c.json({ error: "name, message, and schedule are required" }, 400);
  }

  try {
    const task = taskScheduler.createTask({
      name: body.name,
      message: body.message,
      schedule: body.schedule,
      enabled: body.enabled ?? true,
    });
    return c.json({ task });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

app.get("/api/tasks/:id", (c) => {
  const id = c.req.param("id");
  const task = taskScheduler.getTask(id);

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ task });
});

app.patch("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    message?: string;
    schedule?: string;
    enabled?: boolean;
  }>();

  try {
    const task = taskScheduler.updateTask(id, body);
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }
    return c.json({ task });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

app.delete("/api/tasks/:id", (c) => {
  const id = c.req.param("id");
  const deleted = taskScheduler.deleteTask(id);

  if (!deleted) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ success: true });
});

app.post("/api/tasks/:id/run", async (c) => {
  const id = c.req.param("id");

  try {
    const result = await taskScheduler.runTask(id);
    return c.json({ run: result });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

app.get("/api/tasks/:id/runs", (c) => {
  const id = c.req.param("id");
  const runs = taskScheduler.getTaskRuns(id);
  return c.json({ runs });
});

/**
 * Heartbeat API
 */
app.get("/api/heartbeat/status", (c) => {
  return c.json(heartbeatSystem.getStatus());
});

app.post("/api/heartbeat/trigger", async (c) => {
  try {
    const results = await heartbeatSystem.trigger();
    return c.json({ results });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get("/api/heartbeat/file", (c) => {
  const fs = require("fs");
  const path = require("path");
  const heartbeatFile = path.join(process.cwd(), "HEARTBEAT.md");
  
  if (!fs.existsSync(heartbeatFile)) {
    heartbeatSystem.getHeartbeatFile();
  }
  
  const content = fs.readFileSync(heartbeatFile, "utf-8");
  return c.json({ content });
});

app.post("/api/heartbeat/file", async (c) => {
  const fs = require("fs");
  const path = require("path");
  const { content } = await c.req.json<{ content: string }>();
  
  const heartbeatFile = path.join(process.cwd(), "HEARTBEAT.md");
  fs.writeFileSync(heartbeatFile, content, "utf-8");
  
  return c.json({ success: true });
});

/**
 * 子智能体 API
 */
app.get("/api/subagents", (c) => {
  const runs = subAgentSystem.listRuns();
  return c.json({ subagents: runs, count: runs.length });
});

app.get("/api/subagents/:id", (c) => {
  const id = c.req.param("id");
  const run = subAgentSystem.getRun(id);
  
  if (!run) {
    return c.json({ error: "SubAgent not found" }, 404);
  }
  
  return c.json(run);
});

app.delete("/api/subagents/:id", (c) => {
  const id = c.req.param("id");
  const success = subAgentSystem.killRun(id);
  
  return c.json({ success });
});

export default {
  port: 3000,
  fetch: app.fetch,
};
