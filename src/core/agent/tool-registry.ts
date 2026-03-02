import type { ToolDefinition, ToolCall, ToolResult } from "./types";

export interface Tool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool "${tool.definition.name}" already registered`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.name,
        result: null,
        error: `Tool "${call.name}" not found`,
      };
    }

    try {
      const result = await tool.execute(call.args);
      return result;
    } catch (error: any) {
      return {
        toolCallId: call.name,
        result: null,
        error: error.message || "Tool execution failed",
      };
    }
  }
}
