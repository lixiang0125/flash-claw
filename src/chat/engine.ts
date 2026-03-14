import OpenAI from "openai";
import { listSkills, type Skill } from "../skills";
import { type IMemoryManager } from "../memory";
import { parseTaskWithLLM, rewriteMemoryQuery } from "./llm-parser";
import { cronToHumanReadable } from "./parsers";
import type { ChatRequest, ChatResponse } from "./types";
import { ErrorSanitizer } from "../infra/error-handler";

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

class ChatEngine {
  private client: OpenAI;
  private sessions: Map<string, ChatMessage[]> = new Map();
  private sessionSkills: Map<string, Skill[]> = new Map();
  private sessionLastAccess: Map<string, number> = new Map();
  private tools: any[] = [];
  private toolExecutor: ((name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>) | null = null;
  private memoryManager: IMemoryManager | null = null;
  private taskSchedulerAPI: TaskSchedulerAPI | null = null;
  private readonly SESSION_MAX_AGE = 30 * 60 * 1000; // 30 minutes
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const baseURL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey = process.env.OPENAI_API_KEY || "";

    console.log("Using OpenAI SDK, baseURL:", baseURL);

    this.client = new OpenAI({
      baseURL,
      apiKey,
    });

    this.startSessionCleanup();
  }

  private startSessionCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, lastAccess] of this.sessionLastAccess) {
        if (now - lastAccess > this.SESSION_MAX_AGE) {
          this.sessions.delete(sessionId);
          this.sessionSkills.delete(sessionId);
          this.sessionLastAccess.delete(sessionId);
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  setMemoryManager(manager: IMemoryManager): void {
    this.memoryManager = manager;
    console.log("[ChatEngine] MemoryManager attached");
  }

  setTaskScheduler(api: TaskSchedulerAPI): void {
    this.taskSchedulerAPI = api;
    console.log("[ChatEngine] TaskScheduler attached");
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
          relevantMemories = "\n\n## 相关记忆\n" +
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
          content: `[System] 用户的消息已被识别为任务调度请求，已自动创建: ${taskResult}\n请在回复中确认任务创建成功，并告知用户任务详情。`,
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

      this.saveContext(sessionId, userId, message, lastResponse);
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: lastResponse });

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
      "## 可用工具 (请使用 Tool Calling 方式调用)",
      "",
      "- web_search(query: string): 搜索互联网并获取结果",
      "- read_file(path: string): 读取文件",
      "- write_file(path: string, content: string): 写入文件",
      "- edit_file(path: string, oldString: string, newString: string): 编辑文件",
      "- bash(command: string): 执行命令",
      "- glob(pattern: string): 搜索文件",
      "- grep(query: string, path?: string): 搜索内容",
      "",
      "重要：不要询问用户，自己决定并调用工具。",
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
    const TASK_HINT = /提醒|定时|闹钟|记得|别忘|remind|timer|alarm|schedule|每天|每周|每月|every|after|later|分钟后|小时后|天后|cron|リマインド|알림/i;
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
        return `定时任务「${task.name}」- ${minutes}分钟后执行`;
      } else if (task.type === "recurring" && task.schedule) {
        // Recurring cron task
        this.taskSchedulerAPI.createTask({
          name: task.name,
          message: task.message,
          schedule: task.schedule,
          enabled: true,
        });
        const humanSchedule = cronToHumanReadable(task.schedule);
        return `定时任务「${task.name}」- ${humanSchedule}`;
      }
    } catch (error: any) {
      console.error("[ChatEngine] Task creation failed:", error.message);
      return null;
    }

    return null;
  }

  private getHistory(sessionId: string): ChatMessage[] {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    this.sessionLastAccess.set(sessionId, Date.now());
    return this.sessions.get(sessionId)!;
  }

  private getSessionSkills(sessionId: string): Skill[] {
    if (!this.sessionSkills.has(sessionId)) {
      this.sessionSkills.set(sessionId, []);
    }
    this.sessionLastAccess.set(sessionId, Date.now());
    return this.sessionSkills.get(sessionId)!;
  }

  async clearSession(sessionId: string): Promise<void> {
    // OpenClaw trigger #3: session save on reset
    // Flush memories through agentic extraction before clearing
    if (this.memoryManager) {
      try {
        await (this.memoryManager as any).resetSession(sessionId);
      } catch (err) {
        console.error("[ChatEngine] Failed to flush session on reset:", err);
      }
    }
    this.sessions.delete(sessionId);
    this.sessionSkills.delete(sessionId);
  }

  getHistoryMessages(sessionId: string): ChatMessage[] {
    return this.getHistory(sessionId);
  }
}

export const chatEngine = new ChatEngine();
