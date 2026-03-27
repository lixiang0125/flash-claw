import { afterEach, describe, expect, it } from "bun:test";
import { normalizeOpenAICompatiblePayload, resolveOpenAICompatibleConfig } from "../src/infra/llm/openai-compatible";

const envKeys = [
  "OPENAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "OPENAI_BASE_URL",
  "DASHSCOPE_BASE_URL",
  "MODEL",
  "OPENAI_MODEL",
  "MODEL_NAME",
] as const;

const originalEnv = new Map<string, string | undefined>(
  envKeys.map((key) => [key, process.env[key]]),
);

function resetEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

describe("resolveOpenAICompatibleConfig", () => {
  afterEach(() => {
    resetEnv();
  });

  it("prefers explicit OpenAI env vars", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.MODEL = "gpt-4o";
    process.env.DASHSCOPE_API_KEY = "dashscope-key";
    process.env.OPENAI_MODEL = "gpt-4o-mini";

    const config = resolveOpenAICompatibleConfig();

    expect(config).toEqual({
      apiKey: "openai-key",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o",
    });
  });

  it("falls back to compatibility aliases when primary vars are absent", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.MODEL;
    process.env.DASHSCOPE_API_KEY = "dashscope-key";
    process.env.DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.OPENAI_MODEL = "qwen-plus";

    const config = resolveOpenAICompatibleConfig();

    expect(config).toEqual({
      apiKey: "dashscope-key",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
    });
  });

  it("keeps OpenAI default endpoint behavior when baseURL is unset", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.DASHSCOPE_BASE_URL;
    delete process.env.MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.MODEL_NAME;

    const config = resolveOpenAICompatibleConfig();

    expect(config.apiKey).toBe("");
    expect(config.baseURL).toBeUndefined();
    expect(config.model).toBe("gpt-4o-mini");
  });
});

describe("normalizeOpenAICompatiblePayload", () => {
  it("returns objects unchanged", () => {
    const payload = { choices: [{ message: { content: "ok" } }] };

    expect(normalizeOpenAICompatiblePayload(payload, "test")).toEqual(payload);
  });

  it("parses JSON string payloads from compatibility gateways", () => {
    const payload = '{"choices":[{"message":{"content":"ok"}}]}';

    expect(normalizeOpenAICompatiblePayload<{ choices: Array<{ message: { content: string } }> }>(payload, "test")).toEqual({
      choices: [{ message: { content: "ok" } }],
    });
  });
});
