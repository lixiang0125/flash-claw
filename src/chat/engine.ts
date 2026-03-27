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
import { createOpenAICompatibleClient, normalizeOpenAICompatiblePayload, resolveOpenAICompatibleConfig } from "../infra/llm/openai-compatible";

const MAX_STEPS = 10;
const CHAT_RETRY_DELAYS_MS = [300, 900] as const;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  toolName?: string;
  name?: string;
}

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: AssistantToolCall[];
  tool_call_id?: string;
  toolName?: string;
  name?: string;
}

interface AssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: unknown;
  };
}

interface ToolExecutorResult {
  result: unknown;
  error?: string;
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

function chatToLLMMessages(msgs: ChatMessage[]): LLMMessage[] {
  return msgs.map((message) => ({
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    name: message.name,
    toolName: message.toolName,
  }));
}

/** 聊天引擎 —— 核心对话处理模块，负责 LLM 交互、工具调用、记忆检索与任务调度。 */
export class ChatEngine {
  private client: OpenAI;
  private model: string;
  private sessionSkills: Map<string, Skill[]> = new Map();
  private tools: LLMToolDefinition[] = [];
  private toolExecutor: ((name: string, args: Record<string, unknown>, sessionId: string) => Promise<ToolExecutorResult>) | null = null;
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
        const response = await this.client.chat.completions.create(request);
        return normalizeOpenAICompatiblePayload<ChatCompletion>(
          response as ChatCompletion | string,
          "Chat completion",
        );
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

  setTools(tools: LLMToolDefinition[]): void {
    this.tools = tools;
    console.log("[DEBUG] setTools called with:", tools.length, "tools");
  }

  setToolExecutor(executor: (name: string, args: Record<string, unknown>, sessionId: string) => Promise<ToolExecutorResult>): void {
    this.toolExecutor = executor;
  }

  private normalizeToolCalls(toolCalls: unknown): AssistantToolCall[] {
    if (!Array.isArray(toolCalls)) {
      return [];
    }

    const normalizedToolCalls: AssistantToolCall[] = [];

    for (const toolCall of toolCalls) {
      if (typeof toolCall !== "object" || toolCall === null) {
        continue;
      }

      const toolCallRecord = toolCall as Record<string, unknown>;
      const functionRecord = typeof toolCallRecord["function"] === "object" && toolCallRecord["function"] !== null
        ? toolCallRecord["function"] as Record<string, unknown>
        : null;
      const id = typeof toolCallRecord["id"] === "string" ? toolCallRecord["id"] : "";
      const type = toolCallRecord["type"] === "function" ? "function" : null;
      const name = typeof functionRecord?.["name"] === "string" ? functionRecord["name"] : "";
      const argumentsText = typeof functionRecord?.["arguments"] === "string"
        ? functionRecord["arguments"]
        : "";

      if (!id || !type || !name) {
        continue;
      }

      normalizedToolCalls.push({
        id,
        type,
        function: {
          name,
          arguments: argumentsText,
        },
      });
    }

    return normalizedToolCalls;
  }

  private parseToolArguments(rawArguments: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(rawArguments || "{}");
      return typeof parsed === "object" && parsed !== null
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  /**
   * 统一执行 assistant 返回的工具调用，并把结果回填到消息上下文中。
   */
  private async executeToolCalls(
    messages: LLMMessage[],
    toolCalls: AssistantToolCall[],
    sessionId: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const args = this.parseToolArguments(toolCall.function.arguments);

      console.log("[TOOL_CALL]", toolName, JSON.stringify(args).substring(0, 100));

      let toolResult: ToolExecutorResult = { result: null, error: "Tool executor not configured" };

      if (this.toolExecutor) {
        try {
          toolResult = await this.toolExecutor(toolName, args, sessionId);
        } catch (error: unknown) {
          toolResult = {
            result: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const toolOutput = typeof toolResult.result === "string"
        ? toolResult.result
        : JSON.stringify(toolResult.result) ?? "null";

      console.log("[TOOL_RESULT]", toolName, toolResult.error ? `ERROR: ${toolResult.error}` : "OK");
      console.log("[TOOL_RESULT_CONTENT]", toolName, (toolOutput || "").substring(0, 200));

      messages.push({
        role: "tool",
        content: toolResult.error || toolOutput,
        tool_call_id: toolCall.id,
        name: toolName,
      });
    }
  }

  private buildToolPromptSection(): string {
    if (this.tools.length === 0) {
      return "## 工具使用\n- 当前无可用工具。";
    }

    return [
      "## 可用工具 (请使用 Tool Calling 方式调用)",
      "",
      ...this.tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`),
      "",
      "重要：不要询问用户，自己决定并调用工具。",
    ].join("\n");
  }

  /**
   * 浏览器任务需要额外约束，避免模型只打开页面就提前结束。
   */
  private buildBrowserWorkflowSection(): string {
    const hasBrowserTool = this.tools.some((tool) => tool.function.name === "browser");
    if (!hasBrowserTool) {
      return "";
    }

    return [
      "## 浏览器任务要求",
      "- 用户明确要求使用浏览器、打开网页、点击页面或在站内搜索时，优先使用 `browser`，不要退化成 `web_search`。",
      "- 浏览器任务必须完成到用户目标为止；仅执行 `goto` 打开页面不算完成。",
      "- 如果任务是“打开搜索引擎并搜索关键词”，优先使用 `browser` 的 `search` 动作，一次性完成打开页面、输入关键词并提交搜索。",
      "- 搜索类网页任务的默认流程：优先 `search`；如果必须拆步，再按 `goto` 打开页面 -> 必要时用 `text` 或 `html` 观察页面 -> `type` 输入关键词 -> `press` Enter 或 `click` 搜索按钮 -> `wait_for` 等待结果 -> `text` 提取并整理答案。",
      "- 示例：用户说“使用浏览器打开 baidu.com，搜索美伊战争”，首选调用 `browser`，参数类似 `{\"action\":\"search\",\"url\":\"https://www.baidu.com\",\"value\":\"美伊战争\",\"newPage\":true}`。",
      "- 当需要阅读当前页整体内容时，可以直接调用 `browser` 的 `text` 或 `html`，不传 `selector` 即可读取整页。",
      "- 如果选择器不确定，先继续用 `text` 或 `html` 观察页面，再决定下一步操作。",
    ].join("\n");
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

      const messages: LLMMessage[] = [
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
          messages: messages as ChatCompletionCreateParamsNonStreaming["messages"],
          tools: (this.tools.length > 0 ? this.tools : undefined) as never,
          temperature: 0.7,
        });

        const assistantMsg = response.choices[0]?.message;
        const text = assistantMsg?.content || "";
        const toolCalls = this.normalizeToolCalls(assistantMsg?.tool_calls);
        lastResponse = text;

        console.log("[DEBUG] assistant content:", text.substring(0, 100));
        console.log("[DEBUG] tool_calls:", toolCalls.length);

        if (toolCalls.length === 0) {
          messages.push({ role: "assistant", content: text });
          break;
        }

        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls,
        });

        await this.executeToolCalls(messages, toolCalls, sessionId);

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

    prompt += `\n\n${this.buildToolPromptSection()}`;

    const browserWorkflowSection = this.buildBrowserWorkflowSection();
    if (browserWorkflowSection) {
      prompt += `\n\n${browserWorkflowSection}`;
    }

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
  private getHistory(sessionId: string): LLMMessage[] {
    if (this.workingMemory) {
      return chatToLLMMessages(wmToChat(this.workingMemory.getMessages(sessionId)));
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
   * - 支持在流式模式下继续执行工具调用循环
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
      const messages: LLMMessage[] = [
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

      // ── Phase 3: 流式 LLM 调用 + 工具循环 ──
      const tLLM = Date.now();
      let firstTokenTime = 0;
      let streamedText = "";
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
      let fullText = "";
      let iterations = 0;

      while (iterations < MAX_STEPS) {
        iterations++;

        const streamResult = await streamChat(
          this.client,
          messages,
          wrappedCallbacks,
          this.model,
          this.tools.length > 0 ? this.tools : undefined,
          streamedText,
        );
        const toolCalls = this.normalizeToolCalls(streamResult.toolCalls);

        streamedText += streamResult.content;
        console.log("[chatStream] tool_calls:", toolCalls.length);

        if (toolCalls.length === 0) {
          fullText = streamedText;
          messages.push({ role: "assistant", content: streamResult.content });
          break;
        }

        messages.push({
          role: "assistant",
          content: streamResult.content || null,
          tool_calls: toolCalls,
        });
        await this.executeToolCalls(messages, toolCalls, sessionId);

        if (iterations >= MAX_STEPS - 1) {
          fullText = streamedText;
          break;
        }
      }

      await callbacks.onDone(fullText);
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
    return wmToChat(this.workingMemory?.getMessages(sessionId) ?? []);
  }
}
