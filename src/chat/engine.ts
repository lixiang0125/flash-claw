import OpenAI from "openai";
import { listSkills, type Skill } from "../skills";
import { type IMemoryManager } from "../memory";
import { parseTaskWithLLM, rewriteMemoryQuery } from "./llm-parser";
import { cronToHumanReadable } from "./parsers";
import type { ChatRequest, ChatResponse } from "./types";
import { ErrorSanitizer } from "../infra/error-handler";
import type { WorkingMemory, ConversationMessage } from "../memory/working-memory";

const MAX_STEPS = 10;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  toolName?: string;
  name?: string;
}

/**
 * Task scheduler interface — injected via setTaskScheduler().
 * The engine no longer hard-imports taskScheduler.
 */
interface TaskSchedulerAPI {
  createTask(task: { name: string; message: string; schedule: string; enabled: boolean }): unknown;
  createOneTimeTask(task: { name: string; message: string; executeAfter: number }): unknown;
}

/**
 * Convert WorkingMemory ConversationMessage[] to ChatMessage[] for the LLM API.
 */
function wmToChat(msgs: ConversationMessage[]): ChatMessage[] {
  return msgs.map(m => ({
    role: m.role,
    content: m.content,
    tool_call_id: m.toolCallId,
    name: m.toolName,
  }));
}

class ChatEngine {
  private client: OpenAI;
  private sessionSkills: Map<string, Skill[]> = new Map();
  private tools: any[] = [];
  private toolExecutor: ((name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>) | null = null;
  private memoryManager: IMemoryManager | null = null;
  private taskSchedulerAPI: TaskSchedulerAPI | null = null;

  /**
   * WorkingMemory is the SINGLE SOURCE OF TRUTH for session prompt history.
   * No more local `sessions: Map` — everything goes through WM.
   */
  private workingMemory: WorkingMemory | null = null;

  constructor() {
    const baseURL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey = process.env.OPENAI_API_KEY || "";

    console.log("Using OpenAI SDK, baseURL:", baseURL);

    this.client = new OpenAI({
      baseURL,
      apiKey,
    });
  }

  dispose(): void {
    // Nothing to clean up now — session eviction is handled by WorkingMemory
  }

  setMemoryManager(manager: IMemoryManager): void {
    this.memoryManager = manager;
    console.log("[ChatEngine] MemoryManager attached");
  }

  setTaskScheduler(api: TaskSchedulerAPI): void {
    this.taskSchedulerAPI = api;
    console.log("[ChatEngine] TaskScheduler attached");
  }

  setWorkingMemory(wm: WorkingMemory): void {
    this.workingMemory = wm;
    console.log("[ChatEngine] WorkingMemory attached (single source of truth)");
  }

  setTools(tools: any[]): void {
    this.tools = tools;
    console.log("[DEBUG] setTools called with:", tools.length, "tools");
  }

  setToolExecutor(executor: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>): void {
    this.toolExecutor = executor;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { message, sessionId = "default", userId = "default" } = request;
    const history = this.getHistory(sessionId);
    const skills = this.getSessionSkills(sessionId);

    console.log("[DEBUG] chat called, tools available:", this.tools.length);

    try {
      // Parse and schedule task — result is injected into LLM response if non-null
      const taskResult = await this.parseAndScheduleTask(message, sessionId);

      let relevantMemories = "";
      if (this.memoryManager) {
        const searchText = await rewriteMemoryQuery(message);

        const memResults = await this.memoryManager.recall({
          text: searchText,
          userId,
          sessionId,
          limit: 5,
        });
        console.log("[DEBUG] memories found:", memResults.length, (memResults as any[]).map((m: any) => m.entry.content));
        if (memResults.length > 0) {
          relevantMemories = "\n\n## \u76f8\u5173\u8bb0\u5fc6\n" +
            (memResults as any[]).map((m: any) => `- ${m.entry.content}`).join("\n");
        }
      }

      const systemPrompt = this.buildSystemPrompt(skills) + relevantMemories;

      const messages: any[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ];

      // If a task was created, inject it as context so the LLM can acknowledge it
      if (taskResult) {
        messages.push({
          role: "system",
          content: `[System] \u7528\u6237\u7684\u6d88\u606f\u5df2\u88ab\u8bc6\u522b\u4e3a\u4efb\u52a1\u8c03\u5ea6\u8bf7\u6c42\uff0c\u5df2\u81ea\u52a8\u521b\u5efa: ${taskResult}\n\u8bf7\u5728\u56de\u590d\u4e2d\u786e\u8ba4\u4efb\u52a1\u521b\u5efa\u6210\u529f\uff0c\u5e76\u544a\u77e5\u7528\u6237\u4efb\u52a1\u8be6\u60c5\u3002`,
        });
      }

      let iterations = 0;
      let lastResponse = "";

      while (iterations < MAX_STEPS) {
        iterations++;

        console.log("[DEBUG] iteration:", iterations, "tools:", this.tools.length);

        const response = await this.client.chat.completions.create({
          model: process.env.MODEL || "qwen-plus",
          messages,
          tools: this.tools.length > 0 ? this.tools : undefined,
          temperature: 0.7,
        });

        const assistantMsg = response.choices[0]?.message;
        const text = assistantMsg?.content || "";
        lastResponse = text;

        console.log("[DEBUG] assistant content:", text.substring(0, 100));
        console.log("[DEBUG] tool_calls:", assistantMsg?.tool_calls?.length || 0);

        if (!assistantMsg?.tool_calls || assistantMsg.tool_calls.length === 0) {
          messages.push({ role: "assistant", content: text });
          break;
        }

        messages.push({
          role: "assistant",
          content: text,
          tool_calls: assistantMsg.tool_calls,
        });

        for (const tc of assistantMsg.tool_calls!) {
          const toolName = (tc as any).function.name;

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse((tc as any).function.arguments || "{}");
          } catch {
            args = {};
          }

          console.log("[TOOL_CALL]", toolName, JSON.stringify(args).substring(0, 100));

          let toolResult: any = { result: null, error: "Tool executor not configured" };

          if (this.toolExecutor) {
            try {
              toolResult = await this.toolExecutor(toolName, args, sessionId);
            } catch (error) {
              toolResult = { result: null, error: String(error) };
            }
          }

          console.log("[TOOL_RESULT]", toolName, toolResult.error ? `ERROR: ${toolResult.error}` : "OK");
          console.log("[TOOL_RESULT_CONTENT]", toolName, (toolResult.result || "").substring(0, 200));

          messages.push({
            role: "tool",
            content: toolResult.error || JSON.stringify(toolResult.result),
            tool_call_id: tc.id,
            name: toolName,
          });
        }

        if (iterations >= MAX_STEPS - 1) {
          break;
        }
      }

      // Persist to WorkingMemory (single source of truth)
      this.appendToWorkingMemory(sessionId, "user", message);
      this.appendToWorkingMemory(sessionId, "assistant", lastResponse);

      // Also persist to long-term memory via MemoryManager
      this.saveContext(sessionId, userId, message, lastResponse);

      return {
        response: lastResponse,
        sessionId,
      };
    } catch (error: unknown) {
      const sanitizedMessage = ErrorSanitizer.sanitize(error, { sessionId, operation: "chat" });
      return {
        response: sanitizedMessage,
        sessionId,
      };
    }
  }

  private appendToWorkingMemory(sessionId: string, role: "user" | "assistant" | "system" | "tool", content: string): void {
    if (!this.workingMemory) return;
    this.workingMemory.append(sessionId, {
      role,
      content,
      timestamp: Date.now(),
    });
  }

  private saveContext(sessionId: string, userId: string, message: string, _response: string) {
    if (this.memoryManager) {
      this.memoryManager.storeInteraction(
        {
          sender: { id: userId },
          conversationId: sessionId,
          platform: "web",
          content: { text: message },
        },
        _response,
      ).catch(err => console.error("[ChatEngine] Failed to store interaction:", err));
    }
  }


  private buildSystemPrompt(skills: Skill[]): string {
    let prompt = "You are a helpful AI assistant.";

    if (skills.length > 0) {
      const skillDescriptions = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
      prompt += `\n\nAvailable skills:\n${skillDescriptions}`;
    }

    const toolDescriptions = [
      "## \u53ef\u7528\u5de5\u5177 (\u8bf7\u4f7f\u7528 Tool Calling \u65b9\u5f0f\u8c03\u7528)",
      "",
      "- web_search(query: string): \u641c\u7d22\u4e92\u8054\u7f51\u5e76\u83b7\u53d6\u7ed3\u679c",
      "- read_file(path: string): \u8bfb\u53d6\u6587\u4ef6",
      "- write_file(path: string, content: string): \u5199\u5165\u6587\u4ef6",
      "- edit_file(path: string, oldString: string, newString: string): \u7f16\u8f91\u6587\u4ef6",
      "- bash(command: string): \u6267\u884c\u547d\u4ee4",
      "- glob(pattern: string): \u641c\u7d22\u6587\u4ef6",
      "- grep(query: string, path?: string): \u641c\u7d22\u5185\u5bb9",
      "",
      "\u91cd\u8981\uff1a\u4e0d\u8981\u8be2\u95ee\u7528\u6237\uff0c\u81ea\u5df1\u51b3\u5b9a\u5e76\u8c03\u7528\u5de5\u5177\u3002",
    ].join("\n");

    prompt += `\n\n${toolDescriptions}`;

    return prompt;
  }

  /**
   * Parse user message for task scheduling intent.
   * Handles both one-time (executeAfter) and recurring (cron) tasks.
   * Returns a human-readable summary string if a task was created, null otherwise.
   */
  private async parseAndScheduleTask(message: string, _sessionId: string): Promise<string | null> {
    if (!this.taskSchedulerAPI) {
      return null; // TaskScheduler not wired yet
    }

    // Quick pre-filter: skip LLM call for messages that clearly aren't tasks
    const TASK_HINT = /\u63d0\u9192|\u5b9a\u65f6|\u95f9\u949f|\u8bb0\u5f97|\u522b\u5fd8|remind|timer|alarm|schedule|\u6bcf\u5929|\u6bcf\u5468|\u6bcf\u6708|every|after|later|\u5206\u949f\u540e|\u5c0f\u65f6\u540e|\u5929\u540e|cron|\u30ea\u30de\u30a4\u30f3\u30c9|\uc54c\ub9bc/i;
    if (!TASK_HINT.test(message)) return null;

    const task = await parseTaskWithLLM(message);
    if (!task) return null;

    try {
      if (task.type === "once" && task.executeAfter) {
        // One-time delayed task
        this.taskSchedulerAPI.createOneTimeTask({
          name: task.name,
          message: task.message,
          executeAfter: task.executeAfter,
        });
        const minutes = Math.round(task.executeAfter / 60000);
        return `\u5b9a\u65f6\u4efb\u52a1\u300c${task.name}\u300d- ${minutes}\u5206\u949f\u540e\u6267\u884c`;
      } else if (task.type === "recurring" && task.schedule) {
        // Recurring cron task
        this.taskSchedulerAPI.createTask({
          name: task.name,
          message: task.message,
          schedule: task.schedule,
          enabled: true,
        });
        const humanSchedule = cronToHumanReadable(task.schedule);
        return `\u5b9a\u65f6\u4efb\u52a1\u300c${task.name}\u300d- ${humanSchedule}`;
      }
    } catch (error: any) {
      console.error("[ChatEngine] Task creation failed:", error.message);
      return null;
    }

    return null;
  }

  /**
   * Get prompt history for a session.
   * Reads from WorkingMemory (single source of truth) if available,
   * otherwise returns empty array (cold start).
   */
  private getHistory(sessionId: string): ChatMessage[] {
    if (this.workingMemory) {
      return wmToChat(this.workingMemory.getMessages(sessionId));
    }
    // Fallback: no WorkingMemory wired yet (shouldn't happen after bootstrap)
    return [];
  }

  private getSessionSkills(sessionId: string): Skill[] {
    if (!this.sessionSkills.has(sessionId)) {
      this.sessionSkills.set(sessionId, []);
    }
    return this.sessionSkills.get(sessionId)!;
  }

  async clearSession(sessionId: string): Promise<void> {
    // Flush memories through agentic extraction before clearing
    if (this.workingMemory) {
      try {
        await this.workingMemory.resetSession(sessionId);
      } catch (err) {
        console.error("[ChatEngine] Failed to flush session on reset:", err);
      }
    }
    this.sessionSkills.delete(sessionId);
  }

  getHistoryMessages(sessionId: string): ChatMessage[] {
    return this.getHistory(sessionId);
  }
}

export const chatEngine = new ChatEngine();
