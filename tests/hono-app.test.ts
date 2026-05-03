import { describe, expect, it } from "bun:test";
import { createHonoApp } from "../src/infra/hono-app";

type TestServices = Parameters<typeof createHonoApp>[0];

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(),
  };
}

function createServices(overrides: Partial<TestServices> = {}): TestServices {
  return {
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
    ...overrides,
  };
}

describe("createHonoApp", () => {
  it("returns sanitized frontend status info", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.com/v1";
    process.env.MODEL = "gpt-5.4";

    const app = createHonoApp(createServices());

    const response = await app.request("/api/status");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.backend.connected).toBe(true);
    expect(payload.llm.model).toBe("gpt-5.4");
    expect(payload.llm.baseURL).toBe("https://example.com/v1");
    expect(payload.llm.apiKeyConfigured).toBe(true);
    expect("apiKey" in payload.llm).toBe(false);
  });

  it("exposes a health endpoint without auth", async () => {
    const app = createHonoApp(createServices({ apiToken: "secret", requireApiToken: true }));

    const response = await app.request("/health");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
  });

  it("requires token for protected API routes when configured", async () => {
    const app = createHonoApp(createServices({ apiToken: "secret", requireApiToken: true }));

    const response = await app.request("/api/tasks");

    expect(response.status).toBe(401);
  });

  it("accepts bearer token for protected API routes", async () => {
    const app = createHonoApp(createServices({ apiToken: "secret", requireApiToken: true }));

    const response = await app.request("/api/tasks", {
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
  });

  it("fails closed in production when token is missing", async () => {
    const app = createHonoApp(createServices({ apiToken: "", requireApiToken: true }));

    const response = await app.request("/api/tasks");

    expect(response.status).toBe(503);
  });

  it("returns 404 for missing skill scripts instead of serializing a pending promise", async () => {
    const app = createHonoApp(createServices());

    const response = await app.request("/api/skills/missing/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: "missing.sh" }),
    });

    expect(response.status).toBe(404);
  });

  it("routes named Feishu webhook requests by botId", async () => {
    const calls: Array<{ connectorId?: string }> = [];

    const app = createHonoApp(createServices({
      apiToken: "secret",
      requireApiToken: true,
      feishuBot: {
        handleEvent: async (_body, options) => {
          calls.push({ connectorId: options?.connectorId });
          return { success: true, connectorId: options?.connectorId };
        },
        isConfigured: (connectorId?: string) => connectorId === "ops",
        getConfig: () => ({}),
      },
    }));

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
    const app = createHonoApp(createServices({
      feishuBot: {
        handleEvent: async () => ({ success: true }),
        isConfigured: () => true,
        getConfig: () => ({ bots: [] }),
      },
    }));

    const response = await app.request("/api/feishu/webhook/status");
    expect(response.status).toBe(200);
  });
});
