import { bootstrap, CONFIG, LLM_SERVICE, EVENT_BUS } from "./container";
import { ToolRegistry } from "./agent";
import { AgentCoreImpl } from "./agent/agent-core";
import { SessionManager } from "./agent/session-manager";
import { ToolDefinition } from "./agent/types";

export interface FlashClaw {
  run(prompt: string, sessionId?: string): Promise<string>;
  registerTool(tool: ToolDefinition, handler: (args: any) => Promise<any>): void;
}

export async function createFlashClaw(): Promise<FlashClaw> {
  const container = await bootstrap();

  const config = container.resolve(CONFIG);
  const llmService = container.resolve(LLM_SERVICE);
  const eventBus = container.resolve(EVENT_BUS);

  const toolRegistry = new ToolRegistry();
  const sessionManager = new SessionManager();

  const llm = (llmService as any).llm || await import("@langchain/openai").then(m => 
    new m.ChatOpenAI({
      model: config.llmModel,
      temperature: 0.7,
      baseURL: config.llmApiKey.includes("dashscope") ? undefined : process.env.OPENAI_BASE_URL,
      apiKey: config.llmApiKey,
    })
  ).catch(() => {
    // Fallback - use existing implementation
    return null;
  });

  const agent = llm 
    ? new AgentCoreImpl(llm as any, toolRegistry, sessionManager, {
        maxSteps: 10,
        systemPrompt: "You are FlashClaw, a helpful AI assistant.",
      })
    : null;

  return {
    async run(prompt: string, sessionId = "default"): Promise<string> {
      if (!agent) {
        const llmResult = await llmService.generateText(prompt);
        return llmResult;
      }

      const result = await agent.run(sessionId, prompt);
      return result.text;
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
