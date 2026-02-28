import "dotenv/config";
import { Hono } from "hono";
import { chatEngine, type ChatRequest } from "./chat";

const app = new Hono();

app.get("/", (c) => c.text("Flash Claw Chat API"));

app.post("/chat", async (c) => {
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

app.post("/chat/clear", async (c) => {
  const body = await c.req.json<{ sessionId: string }>();
  
  if (!body.sessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  chatEngine.clearSession(body.sessionId);
  return c.json({ success: true });
});

export default {
  port: 3000,
  fetch: app.fetch,
};
