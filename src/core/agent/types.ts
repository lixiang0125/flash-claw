export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  error?: string;
}

export interface AgentSession {
  id: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface AgentConfig {
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}
