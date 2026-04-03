import { describe, expect, it } from "bun:test";
import { createHonoApp } from "../src/infra/hono-app";

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(),
  };
}

describe("createHonoApp", () => {
  it("returns sanitized frontend status info", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.com/v1";
    process.env.MODEL = "gpt-5.4";

    const app = createHonoApp({
      chatEngine: {
        chat: async () => ({ response: "ok", sessionId: "test" }),
        clearSession: async () => undefined,
      },
      feishuBot: {
        handleEvent: async () => ({ success: true }),
        isConfigured: () => false,
        getConfig: () => ({}),
      },
      taskScheduler: {
        listTasks: () => [],
        createTask: () => ({}),
        createOneTimeTask: () => ({}),
        getTask: () => null,
        updateTask: () => null,
        deleteTask: () => false,
        runTask: async () => ({}),
        getTaskRuns: () => [],
      },
      heartbeatSystem: {
        getStatus: () => ({}),
        trigger: async () => [],
        getHeartbeatFile: () => "HEARTBEAT.md",
      },
      subAgentSystem: {
        listRuns: () => [],
        getRun: () => null,
        killRun: () => false,
      },
      logger: createLogger(),
    });

    const response = await app.request("/api/status");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.backend.connected).toBe(true);
    expect(payload.llm.model).toBe("gpt-5.4");
    expect(payload.llm.baseURL).toBe("https://example.com/v1");
    expect(payload.llm.apiKeyConfigured).toBe(true);
    expect("apiKey" in payload.llm).toBe(false);
  });

  it("routes named Feishu webhook requests by botId", async () => {
    const calls: Array<{ connectorId?: string }> = [];

    const app = createHonoApp({
      chatEngine: {
        chat: async () => ({ response: "ok", sessionId: "test" }),
        clearSession: async () => undefined,
      },
      feishuBot: {
        handleEvent: async (_body, options) => {
          calls.push({ connectorId: options?.connectorId });
          return { success: true, connectorId: options?.connectorId };
        },
        isConfigured: (connectorId?: string) => connectorId === "ops",
        getConfig: () => ({}),
      },
      taskScheduler: {
        listTasks: () => [],
        createTask: () => ({}),
        createOneTimeTask: () => ({}),
        getTask: () => null,
        updateTask: () => null,
        deleteTask: () => false,
        runTask: async () => ({}),
        getTaskRuns: () => [],
      },
      heartbeatSystem: {
        getStatus: () => ({}),
        trigger: async () => [],
        getHeartbeatFile: () => "HEARTBEAT.md",
      },
      subAgentSystem: {
        listRuns: () => [],
        getRun: () => null,
        killRun: () => false,
      },
      logger: createLogger(),
    });

    const response = await app.request("/api/webhooks/feishu/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message" }),
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.connectorId).toBe("ops");
    expect(calls).toEqual([{ connectorId: "ops" }]);
  });

  it("keeps legacy Feishu webhook alias available", async () => {
    const app = createHonoApp({
      chatEngine: {
        chat: async () => ({ response: "ok", sessionId: "test" }),
        clearSession: async () => undefined,
      },
      feishuBot: {
        handleEvent: async () => ({ success: true }),
        isConfigured: () => true,
        getConfig: () => ({ bots: [] }),
      },
      taskScheduler: {
        listTasks: () => [],
        createTask: () => ({}),
        createOneTimeTask: () => ({}),
        getTask: () => null,
        updateTask: () => null,
        deleteTask: () => false,
        runTask: async () => ({}),
        getTaskRuns: () => [],
      },
      heartbeatSystem: {
        getStatus: () => ({}),
        trigger: async () => [],
        getHeartbeatFile: () => "HEARTBEAT.md",
      },
      subAgentSystem: {
        listRuns: () => [],
        getRun: () => null,
        killRun: () => false,
      },
      logger: createLogger(),
    });

    const response = await app.request("/api/feishu/webhook/status");
    expect(response.status).toBe(200);
  });
});
