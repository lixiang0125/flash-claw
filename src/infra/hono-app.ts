import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { ChatRequest } from "../chat/types";
import type { Logger } from "../core/container/tokens";
import { resolveOpenAICompatibleConfig } from "./llm/openai-compatible";

interface AppServices {
  chatEngine: {
    chat(request: ChatRequest): Promise<unknown>;
    clearSession(sessionId: string): void | Promise<void>;
  };
  feishuBot: {
    handleEvent(body: unknown, options?: { connectorId?: string }): Promise<unknown>;
    isConfigured(connectorId?: string): boolean;
    getConfig(connectorId?: string): unknown;
  };
  taskScheduler: {
    listTasks(): unknown[];
    createTask(task: unknown): unknown;
    createOneTimeTask(task: { name: string; message: string; executeAfter: number }): unknown;
    getTask(id: string): unknown;
    updateTask(id: string, updates: unknown): unknown;
    deleteTask(id: string): boolean;
    runTask(id: string): Promise<unknown>;
    getTaskRuns(id: string): unknown[];
  };
  heartbeatSystem: {
    getStatus(): unknown;
    trigger(): Promise<unknown>;
    getHeartbeatFile(): string;
  };
  subAgentSystem: {
    listRuns(): unknown[];
    getRun(id: string): unknown;
    killRun(id: string): boolean;
  };
  logger: Logger;
  apiToken?: string;
  requireApiToken?: boolean;
}

export function createHonoApp(services: AppServices): Hono {
  const {
    chatEngine,
    feishuBot,
    taskScheduler,
    heartbeatSystem,
    subAgentSystem,
    logger,
    apiToken = process.env["FLASH_CLAW_API_TOKEN"]?.trim() ?? "",
    requireApiToken = process.env["NODE_ENV"] === "production",
  } = services;
  const app = new Hono();

  const isFeishuWebhookPost = (method: string, path: string): boolean => {
    if (method !== "POST") return false;
    return path === "/api/webhooks/feishu" ||
      path.startsWith("/api/webhooks/feishu/") ||
      path === "/api/feishu/webhook" ||
      path.startsWith("/api/feishu/webhook/");
  };

  const isPublicRoute = (method: string, path: string): boolean => {
    if (method === "GET" && !path.startsWith("/api/")) {
      return true;
    }
    if (method === "GET" && (path === "/" || path === "/health" || path === "/api/status")) {
      return true;
    }
    return isFeishuWebhookPost(method, path);
  };

  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (isPublicRoute(c.req.method, path)) {
      return next();
    }

    if (!apiToken) {
      if (!requireApiToken) {
        return next();
      }
      return c.json({ error: "API token is required in production" }, 503);
    }

    const authHeader = c.req.header("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const headerToken = c.req.header("x-flash-claw-token")?.trim() ?? "";
    if (bearerToken !== apiToken && headerToken !== apiToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  });

  const handleFeishuWebhook = async (body: unknown, connectorId?: string): Promise<Response> => {
    if (!feishuBot.isConfigured(connectorId)) {
      return new Response(JSON.stringify({ error: "Feishu bot not configured" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await feishuBot.handleEvent(body, { connectorId });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      logger.error("Feishu webhook error", { error, connectorId });
      return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  app.use("/*", serveStatic({ root: "./dist" }));

  app.get("/", (c) => c.text("Flash Claw Chat API"));
  app.get("/health", (c) => c.json({ ok: true, status: "healthy" }));

  app.get("/api/status", (c) => {
    const llmConfig = resolveOpenAICompatibleConfig();

    // Web 端只需要可展示的健康信息，绝不能返回明文密钥。
    return c.json({
      backend: {
        connected: true,
        checkedAt: Date.now(),
      },
      llm: {
        model: llmConfig.model,
        baseURL: llmConfig.baseURL,
        apiKeyConfigured: Boolean(llmConfig.apiKey),
      },
    });
  });

  app.post("/api/chat", async (c) => {
    const body = await c.req.json<ChatRequest>();
    
    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }

    try {
      const result = await chatEngine.chat(body);
      return c.json(result);
    } catch (error) {
      logger.error("Chat error", { error });
      return c.json({ error: "Chat failed" }, 500);
    }
  });

  app.post("/api/chat/clear", async (c) => {
    const body = await c.req.json<{ sessionId: string }>();
    
    if (!body.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    await chatEngine.clearSession(body.sessionId);
    return c.json({ success: true });
  });

  app.get("/api/skills", (c) => {
    const { listSkills, searchSkills } = require("../skills");
    const query = c.req.query("q");
    if (query) {
      return c.json(searchSkills(query));
    }
    return c.json(listSkills());
  });

  app.get("/api/skills/:name", (c) => {
    const { getSkill } = require("../skills");
    const name = c.req.param("name");
    const skill = getSkill(name);
    if (!skill) {
      return c.json({ error: "Skill not found" }, 404);
    }
    return c.json(skill);
  });

  app.post("/api/skills/:name/exec", async (c) => {
    const { executeScript } = require("../skills");
    const name = c.req.param("name");
    const { script, args } = await c.req.json<{ script: string; args?: string[] }>();
    
    if (!script) {
      return c.json({ error: "script name is required" }, 400);
    }

    const result = await executeScript(name, script, args || []);
    if (!result) {
      return c.json({ error: "Script not found" }, 404);
    }
    
    return c.json(result);
  });

  app.get("/api/webhooks/feishu/status", (c) => {
    return c.json({
      configured: feishuBot.isConfigured(),
      config: feishuBot.getConfig(),
    });
  });

  app.get("/api/webhooks/feishu/:botId/status", (c) => {
    const botId = c.req.param("botId");
    if (!feishuBot.isConfigured(botId)) {
      return c.json({ error: "Feishu bot not configured" }, 404);
    }

    return c.json({
      configured: true,
      config: feishuBot.getConfig(botId),
    });
  });

  app.post("/api/webhooks/feishu/:botId", async (c) => {
    const body = await c.req.json();
    return handleFeishuWebhook(body, c.req.param("botId"));
  });

  app.post("/api/webhooks/feishu", async (c) => {
    const body = await c.req.json();
    return handleFeishuWebhook(body);
  });

  // 兼容 README 与历史外部回调地址
  app.get("/api/feishu/webhook/status", (c) => {
    return c.json({
      configured: feishuBot.isConfigured(),
      config: feishuBot.getConfig(),
    });
  });

  app.get("/api/feishu/webhook/:botId/status", (c) => {
    const botId = c.req.param("botId");
    if (!feishuBot.isConfigured(botId)) {
      return c.json({ error: "Feishu bot not configured" }, 404);
    }

    return c.json({
      configured: true,
      config: feishuBot.getConfig(botId),
    });
  });

  app.post("/api/feishu/webhook/:botId", async (c) => {
    const body = await c.req.json();
    return handleFeishuWebhook(body, c.req.param("botId"));
  });

  app.post("/api/feishu/webhook", async (c) => {
    const body = await c.req.json();
    return handleFeishuWebhook(body);
  });

  app.get("/api/tasks", (c) => {
    const tasks = taskScheduler.listTasks();
    return c.json({ tasks });
  });

  app.post("/api/tasks", async (c) => {
    const body = await c.req.json<{
      name: string;
      message: string;
      schedule?: string;
      executeAfter?: number;
      enabled?: boolean;
    }>();

    if (!body.name || !body.message) {
      return c.json({ error: "name and message are required" }, 400);
    }

    // Must provide either schedule (cron) or executeAfter (ms delay), not both
    if (!body.schedule && !body.executeAfter) {
      return c.json({ error: "Either schedule (cron) or executeAfter (ms) is required" }, 400);
    }

    try {
      if (body.executeAfter) {
        // One-time delayed task
        const task = taskScheduler.createOneTimeTask({
          name: body.name,
          message: body.message,
          executeAfter: body.executeAfter,
        });
        return c.json({ task });
      } else {
        // Recurring cron task
        const task = taskScheduler.createTask({
          name: body.name,
          message: body.message,
          schedule: body.schedule!,
          enabled: body.enabled ?? true,
        });
        return c.json({ task });
      }
    } catch (error: unknown) {
      return c.json({ error: (error as Error).message }, 400);
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
    } catch (error: unknown) {
      return c.json({ error: (error as Error).message }, 400);
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
    } catch (error: unknown) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/tasks/:id/runs", (c) => {
    const id = c.req.param("id");
    const runs = taskScheduler.getTaskRuns(id);
    return c.json({ runs });
  });

  app.get("/api/heartbeat/status", (c) => {
    return c.json(heartbeatSystem.getStatus());
  });

  app.post("/api/heartbeat/trigger", async (c) => {
    try {
      const results = await heartbeatSystem.trigger();
      return c.json({ results });
    } catch (error: unknown) {
      return c.json({ error: (error as Error).message }, 500);
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

  return app;
}
