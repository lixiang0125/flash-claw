import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions/completions";
import { listSkills, type Skill } from "../skills";
import { type IMemoryManager } from "../memory";
import { parseTaskWithLLM, rewriteMemoryQuery } from "./llm-parser";
import { cronToHumanReadable } from "./parsers";
import type { ChatRequest, ChatResponse, StreamCallbacks } from "./types";
import { ErrorSanitizer } from "../infra/error-handler";
import type { WorkingMemory, ConversationMessage } from "../memory/working-memory";
import type { IEvolutionEngine } from "../core/container/tokens";
import { streamChat } from "./chatStream";
import { createOpenAICompatibleClient, resolveOpenAICompatibleConfig } from "../infra/llm/openai-compatible";

const MAX_STEPS = 10;
const CHAT_RETRY_DELAYS_MS = [300, 900] as const;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  toolName?: string;
  name?: string;
}

interface RetryableLLMError {
  status?: number;
  code?: string;
  message?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLLMError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const llmError = error as RetryableLLMError;
  const status = llmError.status;
  const code = llmError.code;
  const message = error.message.toLowerCase();

  if (typeof status === "number" && status >= 500) {
    return true;
  }

  return code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ECONNREFUSED"
    || message.includes("timeout")
    || message.includes("connection")
    || message.includes("network");
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

/** 聊天引擎 —— 核心对话处理模块，负责 LLM 交互、工具调用、记忆检索与任务调度。 */
export class ChatEngine {
  private client: OpenAI;
  private model: string;
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

  /** 自进化引擎 —— 分析对话反馈并自动优化系统行为 */
  private evolutionEngine: IEvolutionEngine | null = null;

  constructor() {
    const config = resolveOpenAICompatibleConfig();

    this.model = config.model;
    this.client = createOpenAICompatibleClient();

    console.log("Using OpenAI-compatible LLM config:", {
      baseURL: config.baseURL || "https://api.openai.com/v1",
      model: config.model,
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

  /** 注入 WorkingMemory 作为会话历史的唯一数据源 */
  setWorkingMemory(wm: WorkingMemory): void {
    this.workingMemory = wm;
    console.log("[ChatEngine] WorkingMemory attached (single source of truth)");
  }

  /** 注入自进化引擎，用于对话反馈分析和 prompt 增强 */
  setEvolutionEngine(engine: IEvolutionEngine): void {
    this.evolutionEngine = engine;
    console.log("[ChatEngine] EvolutionEngine attached");
  }

  /**
   * 对第三方 OpenAI-compatible 网关做轻量重试，降低偶发 5xx / 网络抖动导致的整轮对话失败概率。
   */
  private async createChatCompletion(
    request: ChatCompletionCreateParamsNonStreaming,
  ): Promise<ChatCompletion> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= CHAT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.client.chat.completions.create(request);
      } catch (error: unknown) {
        lastError = error;

        if (attempt === CHAT_RETRY_DELAYS_MS.length || !isRetryableLLMError(error)) {
          throw error;
        }

        const delay = CHAT_RETRY_DELAYS_MS[attempt] ?? 0;
        console.warn(`[ChatEngine] LLM request failed, retrying in ${delay}ms`, error);
        await sleep(delay);
      }
    }

    throw lastError;
  }

  setTools(tools: any[]): void {
    this.tools = tools;
    console.log("[DEBUG] setTools called with:", tools.length, "tools");
  }

  setToolExecutor(executor: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<{ result: unknown; error?: string }>): void {
    this.toolExecutor = executor;
  }

  /** 处理一次完整的对话请求：构建上下文 → LLM 推理 → 工具循环 → 持久化记忆 */
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
          content: `[System] 用户的消息已被识别为任务调度请求，已自动创建: ${taskResult}
请在回复中确认任务创建成功，并告知用户任务详情。`,
        });
      }

      let iterations = 0;
      let lastResponse = "";

      while (iterations < MAX_STEPS) {
        iterations++;

        console.log("[DEBUG] iteration:", iterations, "tools:", this.tools.length);

        const response = await this.createChatCompletion({
          model: this.model,
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

      // 自动压缩：当消息数超过压缩阈值时，触发 WorkingMemory 压缩
      if (this.workingMemory) {
        const stats = this.workingMemory.getStats(sessionId);
        const config = this.workingMemory.getConfig();
        if (config.enableCompression && stats.messageCount >= config.compressionThreshold) {
          this.workingMemory.compress(sessionId, async (msgs) => {
            const texts = msgs.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join("\n");
            try {
               const res = await this.createChatCompletion({
                 model: this.model,
                 messages: [
                   { role: "system", content: "请用简洁的中文总结以下对话历史的要点，保留关键信息。输出纯文本，不超过 500 字。" },
                  { role: "user", content: texts },
                ],
                temperature: 0.3,
                max_tokens: 600,
              });
              return res.choices[0]?.message?.content?.trim() || texts;
            } catch {
              return texts;
            }
          }).catch(err => console.error("[ChatEngine] 自动压缩失败:", err));
        }
      }

      // 异步进化分析（不阻塞主流程）
      if (this.evolutionEngine) {
        this.evolutionEngine.analyzeFeedback(message, lastResponse, sessionId)
          .catch(err => console.error("[ChatEngine] Evolution analysis failed:", err));
      }

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

  /** 追加消息到 WorkingMemory（单一数据源） */
  private appendToWorkingMemory(sessionId: string, role: "user" | "assistant" | "system" | "tool", content: string): void {
    if (!this.workingMemory) return;
    this.workingMemory.append(sessionId, {
      role,
      content,
      timestamp: Date.now(),
    });
  }

  /** 将对话写入长期记忆（MemoryManager），用于跨会话召回 */
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

    // 注入自进化策略的 prompt 增强指令
    const evolutionHints = this.evolutionEngine?.getPromptEnhancements() || "";
    if (evolutionHints) {
      prompt += `\n\n## 行为优化指令\n${evolutionHints}`;
    }

    return prompt;
  }

  /**
   * Parse user message for task scheduling intent.
   * Handles both one-time (executeAfter) and recurring (cron) tasks.
   * Returns a human-readable summary string if a task was created, null otherwise.
   */
  /** 解析用户消息中的任务调度意图，支持一次性延时任务和周期性 cron 任务 */
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

  /** 从 WorkingMemory 获取会话历史（单一数据源），不再使用本地 Map */
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


  /**
   * 流式对话 —— 通过回调实时推送 LLM 输出文本。
   *
   * 与 chat() 的区别：
   * - 使用 OpenAI stream 模式，逐 token 推送
   * - 通过 StreamCallbacks 回调通知调用方（如 FeishuBot 流式卡片）
   * - 不执行工具调用循环（流式场景优先返回文本）
   * - 持久化逻辑与 chat() 一致
   */
  async chatStream(
    request: ChatRequest,
    callbacks: StreamCallbacks,
  ): Promise<ChatResponse> {
    const { message, sessionId = "default", userId = "default" } = request;
    const history = this.getHistory(sessionId);
    const skills = this.getSessionSkills(sessionId);
    const t0 = Date.now();

    try {
      // ── Phase 0: 任务调度意图解析（与 memory 并行） ──
      const taskResult = await this.parseAndScheduleTask(message, sessionId);

      // ── Phase 1: 记忆检索 (带超时保护，不阻塞 LLM) ──
      const MEMORY_TIMEOUT_MS = 800; // 超时 800ms 则跳过记忆
      let relevantMemories = "";
      const memoryPromise = this.memoryManager
        ? (async () => {
            const tMem0 = Date.now();
            const searchText = message.length > 80
              ? await (async () => { const { rewriteMemoryQuery } = await import("./llm-parser"); return rewriteMemoryQuery(message); })()
              : message;
            const tMemRewrite = Date.now();
            const memResults = await this.memoryManager!.recall({
              text: searchText, userId, sessionId, limit: 5,
            });
            const tMemRecall = Date.now();
            console.log(`[chatStream] ⏱ memory: rewrite=${tMemRewrite - tMem0}ms, recall=${tMemRecall - tMemRewrite}ms, total=${tMemRecall - tMem0}ms, results=${memResults.length}`);
            if (memResults.length > 0) {
              return "\n\n## 相关记忆\n" + (memResults as any[]).map((m: any) => `- ${m.entry.content}`).join("\n");
            }
            return "";
          })()
        : Promise.resolve("");

      // 带超时的等待：如果 memory 检索太慢则跳过
      try {
        relevantMemories = await Promise.race([
          memoryPromise,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("memory_timeout")), MEMORY_TIMEOUT_MS)
          ),
        ]);
      } catch (e: any) {
        if (e.message === "memory_timeout") {
          console.log(`[chatStream] ⏱ memory: TIMEOUT (>${MEMORY_TIMEOUT_MS}ms), skipped`);
        } else {
          console.warn(`[chatStream] ⏱ memory error: ${e.message}, skipped`);
        }
        relevantMemories = "";
      }

      // ── Phase 2: 构建提示词 ──
      const tPrompt = Date.now();
      const systemPrompt = this.buildSystemPrompt(skills) + relevantMemories;
      const messages: any[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ];
      // If a task was created, inject it so the LLM acknowledges it
      if (taskResult) {
        messages.push({
          role: "system",
          content: `[System] 用户的消息已被识别为任务调度请求，已自动创建: ${taskResult}\n请在回复中确认任务创建成功，并告知用户任务详情。`,
        });
      }
      console.log(`[chatStream] ⏱ prompt build=${Date.now() - tPrompt}ms, context msgs=${messages.length}${taskResult ? ", task created" : ""}`);

      // ── Phase 3: 流式 LLM 调用 ──
      const tLLM = Date.now();
      let firstTokenTime = 0;
      const wrappedCallbacks: StreamCallbacks = {
        onDelta: async (delta, fullText) => {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            console.log(`[chatStream] ⏱ LLM first token=${firstTokenTime - tLLM}ms (TTFT)`);
          }
          return callbacks.onDelta(delta, fullText);
        },
        onDone: callbacks.onDone,
        onError: callbacks.onError,
      };
      const fullText = await streamChat(
        this.client,
        messages,
        wrappedCallbacks,
      );
      const tLLMDone = Date.now();
      console.log(`[chatStream] ⏱ LLM total=${tLLMDone - tLLM}ms, output=${fullText.length} chars`);

      // ── Phase 4: 持久化（同步部分） ──
      const tPersist = Date.now();
      this.appendToWorkingMemory(sessionId, "user", message);
      this.appendToWorkingMemory(sessionId, "assistant", fullText);
      this.saveContext(sessionId, userId, message, fullText);
      console.log(`[chatStream] ⏱ persist=${Date.now() - tPersist}ms`);

      // 异步进化分析（不计入总耗时）
      if (this.evolutionEngine) {
        this.evolutionEngine
          .analyzeFeedback(message, fullText, sessionId)
          .catch((err) => console.error("[ChatEngine] Evolution analysis failed:", err));
      }

      const totalMs = Date.now() - t0;
      console.log(`[chatStream] ⏱ TOTAL=${totalMs}ms | memory=${Date.now() - t0 - (tLLMDone - tLLM)}ms overhead`);

      return { response: fullText, sessionId };
    } catch (error: unknown) {
      const sanitizedMessage = ErrorSanitizer.sanitize(error, {
        sessionId,
        operation: "chatStream",
      });
      return { response: sanitizedMessage, sessionId };
    }
  }


  getHistoryMessages(sessionId: string): ChatMessage[] {
    return this.getHistory(sessionId);
  }
}
