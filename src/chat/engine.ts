import OpenAI from "openai";
import { listSkills, type Skill } from "../skills";
import { taskScheduler } from "../tasks";
import { userProfileStore } from "../profiles";
import { readUser, readSoul, readMemory, extractInfoToRemember } from "../memory";
import { parseTaskFromMessage, cronToHumanReadable } from "./parsers";
import { parseTaskWithLLM } from "./llm-parser";
import type { ChatRequest, ChatResponse } from "./types";

const MAX_STEPS = 10;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  toolName?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

class ChatEngine {
  private client: OpenAI;
  private sessions: Map<string, ChatMessage[]> = new Map();
  private sessionSkills: Map<string, Skill[]> = new Map();
  private tools: any[] = [];
  private toolExecutor: ((name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>) | null = null;

  constructor() {
    const baseURL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey = process.env.OPENAI_API_KEY || "";

    console.log("Using OpenAI SDK, baseURL:", baseURL);

    this.client = new OpenAI({
      baseURL,
      apiKey,
    });
  }

  setTools(tools: any[]): void {
    this.tools = tools;
    console.log("[DEBUG] setTools called with:", tools.length, "tools");
  }

  setToolExecutor(executor: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>): void {
    this.toolExecutor = executor;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { message, sessionId = "default" } = request;
    const history = this.getHistory(sessionId);
    const skills = this.getSessionSkills(sessionId);

    console.log("[DEBUG] chat called, tools available:", this.tools.length);

    try {
      const { user, soul, memory } = this.loadContext(sessionId);
      await this.parseAndScheduleTask(message, sessionId);

      const systemPrompt = this.buildSystemPrompt(user, soul, memory, skills);
      
      const messages: any[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ];

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
          const args = JSON.parse((tc as any).function.arguments || "{}");

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

      this.saveContext(sessionId, message, lastResponse);
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: lastResponse });

      return {
        response: lastResponse,
        sessionId,
      };
    } catch (error: unknown) {
      const err = error as Error;
      console.error("Chat error:", err);
      return {
        response: `处理消息时出错: ${err.message}`,
        sessionId,
      };
    }
  }

  private loadContext(sessionId: string) {
    const user = readUser(sessionId);
    const soul = readSoul();
    const memory = readMemory(sessionId);
    return { user, soul, memory };
  }

  private saveContext(sessionId: string, message: string, _response: string) {
    const info = extractInfoToRemember(message);
    if (info) {
      const profile = userProfileStore.get(sessionId);
      if (profile) {
        Object.assign(profile, info);
      }
    }
  }

  private buildSystemPrompt(user: unknown, soul: unknown, memory: unknown, skills: Skill[]): string {
    let prompt = (soul as { prompt?: string })?.prompt || "You are a helpful AI assistant.";

    if (skills.length > 0) {
      const skillDescriptions = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
      prompt += `\n\nAvailable skills:\n${skillDescriptions}`;
    }

    const toolDescriptions = [
      "## 可用工具 (请使用 Tool Calling 方式调用)",
      "",
      "当需要获取网页内容时，必须使用 web_fetch 工具：",
      "- web_fetch(url: string): 获取 URL 内容并总结",
      "",
      "其他工具：",
      "- web_search(query: string): 搜索互联网",
      "- read_file(path: string): 读取文件",
      "- write_file(path: string, content: string): 写入文件",
      "- edit_file(path: string, oldString: string, newString: string): 编辑文件",
      "- bash(command: string): 执行命令",
      "- glob(pattern: string): 搜索文件",
      "- grep(query: string, path?: string): 搜索内容",
      "",
      "重要：用户发送 URL 时，必须调用 web_fetch 工具获取内容。不要询问用户，自己决定并调用工具。",
    ].join("\n");

    prompt += `\n\n${toolDescriptions}`;

    if (user && (user as { name?: string }).name) {
      prompt += `\n\nUser's name: ${(user as { name: string }).name}`;
    }

    if (memory) {
      prompt += `\n\nUser memory: ${memory}`;
    }

    return prompt;
  }

  private async parseAndScheduleTask(message: string, sessionId: string): Promise<string | null> {
    const task = parseTaskFromMessage(message);
    if (task) {
      const schedule = task.cron || cronToHumanReadable(task.cron || "");
      await taskScheduler.createTask({
        name: task.name,
        message: task.message,
        schedule,
        enabled: true,
      });
      return `已创建任务: ${task.name} - ${schedule}`;
    }

    try {
      const result = await parseTaskWithLLM(message);
      if (result) {
        await taskScheduler.createTask({
          name: result.name,
          message: result.message,
          schedule: result.schedule,
          enabled: true,
        });
        return `已创建任务: ${result.name}`;
      }
    } catch (error) {
      console.error("Task parsing error:", error);
    }

    return null;
  }

  private getHistory(sessionId: string): ChatMessage[] {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    return this.sessions.get(sessionId)!;
  }

  private getSessionSkills(sessionId: string): Skill[] {
    if (!this.sessionSkills.has(sessionId)) {
      this.sessionSkills.set(sessionId, []);
    }
    return this.sessionSkills.get(sessionId)!;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionSkills.delete(sessionId);
  }

  getHistoryMessages(sessionId: string): ChatMessage[] {
    return this.getHistory(sessionId);
  }
}

export const chatEngine = new ChatEngine();
