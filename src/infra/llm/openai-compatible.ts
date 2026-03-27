import OpenAI from "openai";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

function readEnvValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Resolve a single OpenAI-compatible configuration shared by chat, parser,
 * evolution and memory flows so the project no longer hardcodes a Qwen-only
 * endpoint/model pair.
 */
export function resolveOpenAICompatibleConfig(): OpenAICompatibleConfig {
  return {
    apiKey: readEnvValue(["OPENAI_API_KEY", "DASHSCOPE_API_KEY"]) || "",
    baseURL: readEnvValue(["OPENAI_BASE_URL", "DASHSCOPE_BASE_URL"]),
    model: readEnvValue(["MODEL", "OPENAI_MODEL", "MODEL_NAME"]) || "gpt-4o-mini",
  };
}

export function createOpenAICompatibleClient(): OpenAI {
  const config = resolveOpenAICompatibleConfig();

  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
}
