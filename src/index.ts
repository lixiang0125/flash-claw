import "dotenv/config";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { chatEngine, type ChatRequest } from "./chat";
import { listSkills, searchSkills, getSkill, executeScript } from "./skills";
import { feishuBot } from "./integrations/feishu";
import { taskScheduler } from "./tasks";
import { heartbeatSystem } from "./heartbeat";

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

export default {
  port: 3000,
  fetch: app.fetch,
};
