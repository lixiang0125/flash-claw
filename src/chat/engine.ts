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

  setTools(tools: Map<string, unknown>): void {
    this.tools = tools;
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
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ];

      let iterations = 0;
      let lastResponse = "";

      while (iterations < MAX_STEPS) {
        iterations++;

        const aiTools = this.tools.size > 0 ? Object.fromEntries(this.tools) : undefined;

        const result = await generateText({
          model: this.model.chatModel(process.env.MODEL || "qwen-plus"),
          messages: messages as any,
          tools: aiTools as any,
        });

        const text = result.text;
        lastResponse = text;

        if (!result.toolCalls || result.toolCalls.length === 0) {
          break;
        }

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
      "- web_fetch: 获取指定 URL 的网页内容。用于总结网页、公众号文章等。",
      "- web_search: 搜索互联网信息。",
      "- read_file: 读取文件内容。",
      "- write_file: 写入文件。",
      "- edit_file: 编辑文件。",
      "- bash: 执行 shell 命令。",
      "- glob: 搜索文件。",
      "- grep: 搜索文件内容。",
    ].join("\n");

    prompt += `\n\nAvailable tools:\n${toolDescriptions}`;
    prompt += `\n\n重要：当用户发送 URL 时，你应该自动使用 web_fetch 工具获取内容并总结。不需要询问用户。`;

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
