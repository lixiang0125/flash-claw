import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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
  toolCallId?: string;
  toolName?: string;
}

class ChatEngine {
  private model: ReturnType<typeof createOpenAICompatible>;
  private sessions: Map<string, ChatMessage[]> = new Map();
  private sessionSkills: Map<string, Skill[]> = new Map();
  private tools: Map<string, unknown> = new Map();
  private toolExecutor: ((name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>) | null = null;

  constructor() {
    const modelName = process.env.MODEL || "qwen-plus";
    const baseURL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey = process.env.OPENAI_API_KEY || "";

    console.log("Using model:", modelName);
    console.log("Using baseURL:", baseURL);

    this.model = createOpenAICompatible({
      name: "dashscope",
      baseURL,
      apiKey,
    });
  }

  setTools(tools: unknown): void {
    this.tools = tools as any;
  }

  setToolExecutor(executor: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>): void {
    this.toolExecutor = executor;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { message, sessionId = "default" } = request;
    const history = this.getHistory(sessionId);
    const skills = this.getSessionSkills(sessionId);

    try {
      const { user, soul, memory } = this.loadContext(sessionId);
      await this.parseAndScheduleTask(message, sessionId);

      const systemPrompt = this.buildSystemPrompt(user, soul, memory, skills);
      
      const messages: any[] = [
        { role: "system", content: systemPrompt },
        ...history.map((h: any) => ({ role: h.role, content: h.content })),
        { role: "user", content: message },
      ];

      let iterations = 0;
      let lastResponse = "";

      while (iterations < MAX_STEPS) {
        iterations++;

        const aiTools = Array.isArray(this.tools) && this.tools.length > 0 ? this.tools : undefined;
        
        console.log("[DEBUG] tools:", aiTools ? `(${aiTools.length} tools)` : "none");

        const result = await generateText({
          model: this.model.chatModel(process.env.MODEL || "qwen-plus"),
          messages: messages as any,
          tools: aiTools as any,
        });

        const text = result.text;
        lastResponse = text;

        console.log("[DEBUG] toolCalls:", result.toolCalls?.length || 0);
        console.log("[DEBUG] raw tool calls:", JSON.stringify(result.toolCalls).substring(0, 500));

        messages.push({ role: "assistant", content: text });

        for (const toolCall of result.toolCalls) {
          const toolName = toolCall.toolName;
          const args = ((toolCall as any).args as Record<string, unknown>) || {};

          let toolResult = { result: null as unknown, error: "Tool executor not configured" } as { result: unknown; error: string };

          if (this.toolExecutor) {
            try {
              toolResult = await this.toolExecutor(toolName, args, sessionId);
            } catch (error) {
              toolResult = { result: null, error: String(error) };
            }
          }

          const resultContent = toolResult.error || JSON.stringify(toolResult.result);

          messages.push({
            role: "tool",
            content: resultContent,
            toolCallId: toolCall.toolCallId,
            toolName,
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
