/**
 * @module WorkingMemory
 * @description 工作记忆模块 —— 四级记忆体系中的第一级。
 *
 * 工作记忆负责管理当前会话的即时上下文，是最快速的记忆层。
 * 所有数据保存在进程内存中，生命周期与会话绑定。
 * 当消息数量或 Token 预算超限时，自动裁剪旧消息。
 * 支持对话历史压缩（摘要化）和向长期记忆的刷写。
 *
 * 四级记忆体系：
 * 1. **工作记忆**（WorkingMemory）—— 当前请求的上下文窗口 ← 本模块
 * 2. **短期记忆**（ShortTermMemory）—— 会话级数据库持久化
 * 3. **Markdown 记忆**（MarkdownMemory）—— 文件系统持久化
 * 4. **长期记忆**（mem0 向量嵌入）—— 语义检索
 */
/**
 * 对话消息结构。
 *
 * 表示工作记忆和短期记忆中存储的单条对话消息，
 * 包含角色、内容、时间戳以及可选的工具调用信息。
 */
export interface ConversationMessage {
  /** 消息角色：系统、用户、助手或工具。 */
  role: "system" | "user" | "assistant" | "tool";
  /** 消息文本内容。 */
  content: string;
  /** 工具调用的唯一标识（仅工具消息需要）。 */
  toolCallId?: string;
  /** 被调用的工具名称（仅工具消息需要）。 */
  toolName?: string;
  /** 消息创建的时间戳（Unix 毫秒）。 */
  timestamp: number;
}

/**
 * 工作记忆配置选项。
 *
 * 控制消息缓冲上限、Token 预算、压缩策略和刷写行为。
 */
export interface WorkingMemoryConfig {
  /** 单个会话允许的最大消息条数。超出后自动裁剪最旧的非系统消息。 */
  maxMessages: number;
  /** 单个会话的最大 Token 预算。超出后自动裁剪。 */
  maxTokens: number;
  /** 是否启用对话历史压缩（摘要化）。 */
  enableCompression: boolean;
  /** 触发压缩的消息数量阈值。当消息数达到此值时执行压缩。 */
  compressionThreshold: number;
  /** 是否启用向长期记忆的自动刷写。 */
  memoryFlushEnabled: boolean;
  /** 触发刷写的软阈值（Token 数）。与 maxTokens 和 reserveTokensFloor 配合计算实际阈值。 */
  memoryFlushSoftThreshold: number;
  /** 保留的最低 Token 数量，用于确保刷写后仍有足够空间。 */
  reserveTokensFloor: number;
}

/**
 * 工作记忆的默认配置。
 *
 * - `maxMessages`：50 条
 * - `maxTokens`：30,000
 * - `enableCompression`：启用
 * - `compressionThreshold`：30 条触发压缩
 * - `memoryFlushEnabled`：启用刷写
 * - `memoryFlushSoftThreshold`：4,000 Token
 * - `reserveTokensFloor`：20,000 Token
 */
const DEFAULT_WORKING_MEMORY_CONFIG: WorkingMemoryConfig = {
  maxMessages: 50,
  maxTokens: 30_000,
  enableCompression: true,
  compressionThreshold: 30,
  memoryFlushEnabled: true,
  memoryFlushSoftThreshold: 4000,
  reserveTokensFloor: 20_000,
};

/**
 * 刷写回调函数类型。
 *
 * 当工作记忆需要将消息刷写到长期记忆时调用此回调。
 * 由外部（如 MarkdownMemory 或 mem0）注入具体实现。
 *
 * @param sessionId - 会话唯一标识
 * @param recentMessages - 需要刷写的最近消息列表
 * @returns 异步完成的 Promise
 */
export type FlushCallback = (sessionId: string, recentMessages: ConversationMessage[]) => Promise<void>;

/** 工作记忆 —— 管理会话级的短期消息缓冲。支持自动裁剪、token 预算、压缩和刷写到长期记忆。 */
export class WorkingMemory {
  /** 会话消息缓冲区，键为会话 ID，值为该会话的消息列表。 */
  private sessions = new Map<string, ConversationMessage[]>();
  /** 当前生效的配置。 */
  private config: WorkingMemoryConfig;
  /** 刷写回调函数，为 null 时禁用刷写功能。 */
  private flushCallback: FlushCallback | null = null;
  /** 每个会话的压缩次数计数器。 */
  private compactionCount = new Map<string, number>();
  /** 标记每个会话在当前压缩周期内是否已执行过刷写。 */
  private hasFlushedInCompaction = new Map<string, boolean>();

  /**
   * 创建工作记忆实例。
   *
   * @param config - 可选的配置项，将与默认配置合并
   */
  constructor(config?: Partial<WorkingMemoryConfig>) {
    this.config = { ...DEFAULT_WORKING_MEMORY_CONFIG, ...config };
  }

  /**
   * 设置刷写回调函数。
   *
   * 注册一个回调，在工作记忆需要将消息持久化到长期记忆时调用。
   * 通常由 bootstrap 阶段注入，连接到 MarkdownMemory 或 mem0。
   *
   * @param callback - 刷写回调函数
   */
  setFlushCallback(callback: FlushCallback): void {
    this.flushCallback = callback;
  }

  /** 判断是否应触发刷写：token 用量超过阈值且本轮压缩周期内尚未刷写 */
  shouldFlush(sessionId: string, totalTokens: number): boolean {
    if (!this.config.memoryFlushEnabled) return false;
    if (!this.flushCallback) return false;

    const currentCompaction = this.compactionCount.get(sessionId) ?? 0;
    const hasFlushed = this.hasFlushedInCompaction.get(sessionId) ?? false;

    const threshold = this.config.maxTokens - this.config.reserveTokensFloor - this.config.memoryFlushSoftThreshold;

    return totalTokens > threshold && !hasFlushed;
  }

  /**
   * 标记指定会话在当前压缩周期内已完成刷写。
   *
   * 防止同一压缩周期内重复刷写。当新的压缩周期开始时
   * （通过 incrementCompactionCount），此标记会被重置。
   *
   * @param sessionId - 会话唯一标识
   */
  markFlushed(sessionId: string): void {
    const current = this.compactionCount.get(sessionId) ?? 0;
    this.compactionCount.set(sessionId, current);
    this.hasFlushedInCompaction.set(sessionId, true);
  }

  /**
   * 递增指定会话的压缩计数，并重置刷写标记。
   *
   * 每次压缩操作完成后调用，开启新的压缩周期，
   * 允许下一周期中再次触发刷写。
   *
   * @param sessionId - 会话唯一标识
   */
  incrementCompactionCount(sessionId: string): void {
    const current = this.compactionCount.get(sessionId) ?? 0;
    this.compactionCount.set(sessionId, current + 1);
    this.hasFlushedInCompaction.set(sessionId, false);
  }

  /** 尝试将最近消息刷写到长期记忆（在 token 接近上限时自动触发） */
  async tryFlush(sessionId: string): Promise<boolean> {
    if (!this.flushCallback) return false;

    const messages = this.getMessages(sessionId);
    const tokens = this.estimateTokens(messages);

    if (this.shouldFlush(sessionId, tokens)) {
      const recentMessages = this.getRecent(sessionId, 10);
      await this.flushCallback(sessionId, recentMessages);
      this.markFlushed(sessionId);
      return true;
    }

    return false;
  }

  /** 追加一条消息到指定会话，自动裁剪超限消息（按条数和 token 数） */
  append(sessionId: string, message: ConversationMessage): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    const messages = this.sessions.get(sessionId)!;
    messages.push(message);

    if (messages.length > this.config.maxMessages) {
      const overflow = messages.length - this.config.maxMessages;
      messages.splice(0, overflow);
    }

    while (this.estimateTokens(messages) > this.config.maxTokens && messages.length > 2) {
      const firstNonSystem = messages.findIndex((m) => m.role !== "system");
      if (firstNonSystem >= 0) {
        messages.splice(firstNonSystem, 1);
      } else {
        break;
      }
    }
  }

  /**
   * 批量追加多条消息到指定会话。
   *
   * 依次调用 append 逐条追加，每条消息都会触发自动裁剪检查。
   *
   * @param sessionId - 会话唯一标识
   * @param messages - 要追加的消息数组
   */
  appendBatch(sessionId: string, messages: ConversationMessage[]): void {
    for (const msg of messages) {
      this.append(sessionId, msg);
    }
  }

  /**
   * 获取指定会话的所有消息。
   *
   * @param sessionId - 会话唯一标识
   * @returns 该会话的消息数组；若会话不存在则返回空数组
   */
  getMessages(sessionId: string): ConversationMessage[] {
    return this.sessions.get(sessionId) ?? [];
  }

  /**
   * 获取指定会话的最近 N 条消息。
   *
   * @param sessionId - 会话唯一标识
   * @param count - 要获取的消息数量
   * @returns 最近的消息数组（按时间升序）
   */
  getRecent(sessionId: string, count: number): ConversationMessage[] {
    const messages = this.getMessages(sessionId);
    return messages.slice(-count);
  }

  /**
   * 清空指定会话的所有消息。
   *
   * 仅删除消息缓冲，不触发刷写回调。若需要先刷写再清空，
   * 请使用 resetSession。
   *
   * @param sessionId - 会话唯一标识
   */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 重置会话：先将所有消息刷写到长期记忆，再清空缓冲 */
  async resetSession(sessionId: string): Promise<void> {
    if (this.flushCallback) {
      const messages = this.getMessages(sessionId);
      if (messages.length > 0) {
        const userAssistantMsgs = messages.filter(
          (m) => m.role === "user" || m.role === "assistant",
        );
        if (userAssistantMsgs.length > 0) {
          await this.flushCallback(sessionId, userAssistantMsgs);
        }
      }
    }
    this.sessions.delete(sessionId);
    this.compactionCount.delete(sessionId);
    this.hasFlushedInCompaction.delete(sessionId);
  }

  /**
   * 清空所有会话的消息缓冲及相关计数器。
   *
   * 不触发任何刷写回调。通常在应用关闭或完全重置时使用。
   */
  clearAll(): void {
    this.sessions.clear();
    this.compactionCount.clear();
    this.hasFlushedInCompaction.clear();
  }

  /** 压缩会话历史：将旧消息摘要化，保留最近 10 条和系统消息 */
  async compress(
    sessionId: string,
    summarizer: (messages: ConversationMessage[]) => Promise<string>,
  ): Promise<void> {
    const messages = this.getMessages(sessionId);
    if (messages.length < this.config.compressionThreshold) return;

    await this.tryFlush(sessionId);
    this.incrementCompactionCount(sessionId);

    const systemMsgs = messages.filter((m) => m.role === "system");
    const recentMsgs = messages.slice(-10).filter(m => m.role !== "system");
    const oldMsgs = messages.slice(systemMsgs.length, messages.length - 10);

    if (oldMsgs.length === 0) return;

    const summary = await summarizer(oldMsgs);
    const summaryMsg: ConversationMessage = {
      role: "system",
      content: `[对话历史摘要]\n${summary}`,
      timestamp: Date.now(),
    };

    this.sessions.set(sessionId, [...systemMsgs, summaryMsg, ...recentMsgs]);
  }

  /**
   * 获取指定会话的统计信息。
   *
   * @param sessionId - 会话唯一标识
   * @returns 包含消息数量和估算 Token 数的对象
   */
  getStats(sessionId: string): { messageCount: number; estimatedTokens: number } {
    const messages = this.getMessages(sessionId);
    return {
      messageCount: messages.length,
      estimatedTokens: this.estimateTokens(messages),
    };
  }

  /**
   * 获取指定会话的当前 Token 用量估算。
   *
   * @param sessionId - 会话唯一标识
   * @returns 估算的 Token 总数
   */
  getTokenUsage(sessionId: string): number {
    const messages = this.getMessages(sessionId);
    return this.estimateTokens(messages);
  }

  /**
   * 获取当前配置的只读副本。
   *
   * @returns 配置对象的浅拷贝
   */
  getConfig(): WorkingMemoryConfig {
    return { ...this.config };
  }

  /** 粗略估算消息列表的 token 数（中文按 1.5 字/token，其他按 4 字符/token） */
  private estimateTokens(messages: ConversationMessage[]): number {
    return messages.reduce((sum, m) => {
      const text = m.content;
      const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const otherChars = text.length - chineseChars;
      return sum + Math.ceil(chineseChars / 1.5 + otherChars / 4) + 4;
    }, 3);
  }

  /**
   * 获取当前活跃的会话数量。
   *
   * @returns 工作记忆中缓存的会话总数
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }
}
