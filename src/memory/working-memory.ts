export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}

export interface WorkingMemoryConfig {
  maxMessages: number;
  maxTokens: number;
  enableCompression: boolean;
  compressionThreshold: number;
}

const DEFAULT_WORKING_MEMORY_CONFIG: WorkingMemoryConfig = {
  maxMessages: 50,
  maxTokens: 30_000,
  enableCompression: true,
  compressionThreshold: 30,
};

export class WorkingMemory {
  private sessions = new Map<string, ConversationMessage[]>();
  private config: WorkingMemoryConfig;

  constructor(config?: Partial<WorkingMemoryConfig>) {
    this.config = { ...DEFAULT_WORKING_MEMORY_CONFIG, ...config };
  }

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

  appendBatch(sessionId: string, messages: ConversationMessage[]): void {
    for (const msg of messages) {
      this.append(sessionId, msg);
    }
  }

  getMessages(sessionId: string): ConversationMessage[] {
    return this.sessions.get(sessionId) ?? [];
  }

  getRecent(sessionId: string, count: number): ConversationMessage[] {
    const messages = this.getMessages(sessionId);
    return messages.slice(-count);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }

  async compress(
    sessionId: string,
    summarizer: (messages: ConversationMessage[]) => Promise<string>,
  ): Promise<void> {
    const messages = this.getMessages(sessionId);
    if (messages.length < this.config.compressionThreshold) return;

    const systemMsgs = messages.filter((m) => m.role === "system");
    const recentMsgs = messages.slice(-10);
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

  getStats(sessionId: string): { messageCount: number; estimatedTokens: number } {
    const messages = this.getMessages(sessionId);
    return {
      messageCount: messages.length,
      estimatedTokens: this.estimateTokens(messages),
    };
  }

  private estimateTokens(messages: ConversationMessage[]): number {
    return messages.reduce((sum, m) => {
      const text = m.content;
      const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const otherChars = text.length - chineseChars;
      return sum + Math.ceil(chineseChars / 1.5 + otherChars / 4) + 4;
    }, 3);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }
}
