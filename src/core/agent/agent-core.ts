import type { AgentCore, AgentResult } from "../container/tokens";
import type { AgentConfig } from "./types";

export class AgentCoreImpl implements AgentCore {
  private config: AgentConfig;

  constructor(config: AgentConfig = {}) {
    this.config = {
      maxSteps: config.maxSteps ?? 10,
      temperature: config.temperature ?? 0.7,
      systemPrompt: config.systemPrompt ?? "You are a helpful AI assistant.",
    };
  }

  async run(_sessionId: string, _prompt: string): Promise<AgentResult> {
    return {
      text: "Agent not available",
      steps: 0,
      toolCalls: [],
    };
  }

  abort(_sessionId: string): void {
    // noop
  }
}
