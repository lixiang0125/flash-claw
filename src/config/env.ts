import { z } from "zod";

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().url().optional(),
  MODEL: z.string().default("qwen-plus"),
  PORT: z.coerce.number().default(3000),
  USE_DOCKER_SANDBOX: z.enum(["true", "false"]).default("false"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),
  FEISHU_WEBHOOK_URL: z.string().url().optional(),
  FEISHU_USE_LONG_CONNECTION: z.string().default("true"),
  TAVILY_API_KEY: z.string().optional(),
  SESSION_TIMEOUT: z.coerce.number().default(1800000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let envInstance: Env | null = null;

export function getEnv(): Env {
  if (!envInstance) {
    try {
      envInstance = EnvSchema.parse(process.env);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues;
        const messages = issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
        throw new Error(`Environment validation failed: ${messages}`);
      }
      throw error;
    }
  }
  return envInstance;
}

export function validateEnv(): Env {
  return getEnv();
}
