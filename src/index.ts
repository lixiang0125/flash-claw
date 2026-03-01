import "dotenv/config";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { chatEngine, type ChatRequest } from "./chat";
import { listSkills, searchSkills, getSkill, executeScript } from "./skills";
import { feishuBot } from "./integrations/feishu";

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

export default {
  port: 3000,
  fetch: app.fetch,
};
