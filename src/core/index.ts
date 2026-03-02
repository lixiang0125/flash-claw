import { bootstrap, CONFIG, LLM_SERVICE, EVENT_BUS } from "./container";
import { ToolRegistry } from "./agent";
import { SessionManager } from "./agent/session-manager";
import type { ToolDefinition } from "./agent/types";

export interface FlashClaw {
  run(prompt: string, sessionId?: string): Promise<string>;
  registerTool(tool: ToolDefinition, handler: (args: any) => Promise<any>): void;
}

export async function createFlashClaw(): Promise<FlashClaw> {
  const container = await bootstrap();
  const config = container.resolve(CONFIG);
  const llmService = container.resolve(LLM_SERVICE);

  const toolRegistry = new ToolRegistry();
  const sessionManager = new SessionManager();

  return {
    async run(prompt: string, sessionId = "default"): Promise<string> {
      const llmResult = await llmService.generateText(prompt);
      return llmResult;
    },

    registerTool(tool: ToolDefinition, handler: (args: any) => Promise<any>): void {
      toolRegistry.register({
        definition: tool,
        execute: async (args) => ({
          toolCallId: tool.name,
          result: await handler(args),
        }),
      });
    },
  };
}
