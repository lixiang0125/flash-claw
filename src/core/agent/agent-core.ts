import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { convertLangChainTool } from "@langchain/core/tools";
import { AgentCore, AgentResult } from "../container/tokens";
import { ToolRegistry } from "./tool-registry";
import { SessionManager } from "./session-manager";
import type { AgentConfig, ToolCall, AgentMessage } from "./types";

export class AgentCoreImpl implements AgentCore {
  private llm: ChatOpenAI;
  private toolRegistry: ToolRegistry;
  private sessionManager: SessionManager;
  private config: AgentConfig;
  private abortControllers = new Map<string, AbortController>();

  constructor(
    llm: ChatOpenAI,
    toolRegistry: ToolRegistry,
    sessionManager: SessionManager,
    config: AgentConfig = {}
  ) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.sessionManager = sessionManager;
    this.config = {
      maxSteps: config.maxSteps ?? 10,
      temperature: config.temperature ?? 0.7,
      systemPrompt: config.systemPrompt ?? "You are a helpful AI assistant.",
    };
  }

  async run(sessionId: string, prompt: string): Promise<AgentResult> {
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    try {
      // Add user message to session
      this.sessionManager.addMessage(sessionId, {
        role: "user",
        content: prompt,
      });

      const messages = this.buildMessages(sessionId);
      const langchainTools = this.toolRegistry.getAll().map((def) => {
        return {
          name: def.name,
          description: def.description,
          schema: def.parameters as any,
        };
      });

      let step = 0;
      const toolCalls: Array<{ name: string; args: unknown; result: unknown }> = [];

      while (step < (this.config.maxSteps ?? 10)) {
        step++;

        // Invoke LLM
        const response = await this.llm.invoke(messages, {
          tools: langchainTools.length > 0 ? langchainTools as any : undefined,
        });

        const content = typeof response.content === "string" 
          ? response.content 
          : JSON.stringify(response.content);

        // Add assistant message
        this.sessionManager.addMessage(sessionId, {
          role: "assistant",
          content,
          toolCalls: (response as any).tool_calls,
        });

        // Check if LLM wants to call tools
        const toolCallsFromResponse = (response as any).tool_calls;
        if (!toolCallsFromResponse || toolCallsFromResponse.length === 0) {
          // No more tool calls, return the response
          return {
            text: content,
            steps: step,
            toolCalls,
          };
        }

        // Execute tools
        for (const toolCall of toolCallsFromResponse) {
          const args = typeof toolCall.arguments === "string" 
            ? JSON.parse(toolCall.arguments) 
            : toolCall.arguments;
          
          const result = await this.toolRegistry.executeTool({
            name: toolCall.name,
            args,
          });

          toolCalls.push({
            name: toolCall.name,
            args,
            result: result.result,
          });

          // Add tool result to messages
          messages.push(
            new ToolMessage({
              toolCallId: toolCall.id || toolCall.name,
              content: result.error || JSON.stringify(result.result),
            })
          );
        }
      }

      // Max steps reached
      const finalMessages = this.sessionManager.getMessages(sessionId);
      const lastMessage = finalMessages[finalMessages.length - 1];
      return {
        text: lastMessage?.content || "Max steps reached",
        steps: step,
        toolCalls,
      };
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  private buildMessages(sessionId: string): (HumanMessage | AIMessage | SystemMessage | ToolMessage)[] {
    const messages: (HumanMessage | AIMessage | SystemMessage | ToolMessage)[] = [
      new SystemMessage(this.config.systemPrompt || ""),
    ];

    const sessionMessages = this.sessionManager.getMessages(sessionId);
    for (const msg of sessionMessages) {
      if (msg.role === "user") {
        messages.push(new HumanMessage(msg.content));
      } else if (msg.role === "assistant") {
        if (msg.toolCalls) {
          messages.push(
            new AIMessage({
              content: msg.content,
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.name,
                name: tc.name,
                args: tc.args,
              })),
            })
          );
        } else {
          messages.push(new AIMessage(msg.content));
        }
      } else if (msg.role === "tool") {
        messages.push(
          new ToolMessage({
            toolCallId: msg.toolCallId || "",
            content: msg.content,
          })
        );
      }
    }

    return messages;
  }
}
