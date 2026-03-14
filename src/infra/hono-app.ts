import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { ChatRequest } from "../chat/types";
import type { Logger } from "../core/container/tokens";

interface AppServices {
  chatEngine: {
    chat(request: ChatRequest): Promise<unknown>;
    clearSession(sessionId: string): void | Promise<void>;
  };
  feishuBot: {
    handleEvent(body: unknown): Promise<unknown>;
    isConfigured(): boolean;
    getConfig(): unknown;
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
}

export function createHonoApp(services: AppServices): Hono {
  const { chatEngine, feishuBot, taskScheduler, heartbeatSystem, subAgentSystem, logger } = services;
  const app = new Hono();

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

    const result = executeScript(name, script, args || []);
    if (!result) {
      return c.json({ error: "Script not found" }, 404);
    }
    
    return c.json(result);
  });

  app.post("/api/webhooks/feishu", async (c) => {
    if (!feishuBot.isConfigured()) {
      return c.json({ error: "Feishu bot not configured" }, 400);
    }

    try {
      const body = await c.req.json();
      const result = await feishuBot.handleEvent(body);
      return c.json(result);
    } catch (error) {
      logger.error("Feishu webhook error", { error });
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });

  app.get("/api/webhooks/feishu/status", (c) => {
    return c.json({
      configured: feishuBot.isConfigured(),
      config: feishuBot.getConfig(),
    });
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
