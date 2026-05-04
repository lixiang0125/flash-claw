import type { ConversationMessage } from "../memory/working-memory";
import type { MemoryEntry } from "../memory/long-term-memory";
import type { ContextBudget } from "../memory/context-budget";
import type { Logger } from "../core/container/tokens";

export interface AgentContext {
  user: {
    userId: string;
    name: string;
    language: string;
    communicationStyle: string;
    timezone: string;
    keyFacts: string[];
  };
  history: ConversationMessage[];
  activeSkills: unknown[];
  memories: MemoryEntry[];
}

export interface IPromptBuilder {
  build(context: AgentContext, userMessage: string): Promise<ConversationMessage[]>;
  estimateTokens(messages: ConversationMessage[]): number;
}

export class PromptBuilder implements IPromptBuilder {
  private contextBudget: ContextBudget;
  private logger: Logger;

  constructor(
    contextBudget: ContextBudget,
    logger: Logger,
  ) {
    this.contextBudget = contextBudget;
    this.logger = logger;
  }

  async build(context: AgentContext, userMessage: string): Promise<ConversationMessage[]> {
    const allocations = this.contextBudget.getAllocations();
    const messages: ConversationMessage[] = [];
    const actualUsage: Record<string, number> = {};

    const systemPrompt = this.buildSystemPrompt(context);
    const systemTokens = this.contextBudget.estimateTokens(systemPrompt);
    actualUsage.systemPrompt = systemTokens;

    let systemContent = systemPrompt;

    const skillContent = this.buildSkillSection(context.activeSkills);
    const skillTokens = this.contextBudget.estimateTokens(skillContent);
    actualUsage.skills = skillTokens;
    if (skillContent) {
      systemContent += `\n\n${skillContent}`;
    }

    const memoryContent = this.buildMemorySection(
      context.memories,
      allocations.longTermMemory ?? 0,
    );
    const memoryTokens = this.contextBudget.estimateTokens(memoryContent);
    actualUsage.longTermMemory = memoryTokens;
    if (memoryContent) {
      systemContent += `\n\n${memoryContent}`;
    }

    messages.push({
      role: "system",
      content: systemContent,
      timestamp: Date.now(),
    });

    const rebalanced = this.contextBudget.rebalance(actualUsage);

    const historyMessages = this.contextBudget.truncateHistory(
      context.history,
      rebalanced.sessionHistory ?? 0,
    );
    messages.push(...historyMessages);

    messages.push({
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });

    const totalTokens = this.contextBudget.estimateTokens(
      messages.map((m) => m.content).join("\n"),
    );
    this.logger.debug(
      `PromptBuilder: ${totalTokens} tokens | ` +
        `system=${actualUsage.systemPrompt} | ` +
        `skills=${actualUsage.skills} | ` +
        `memory=${actualUsage.longTermMemory} | ` +
        `history=${historyMessages.length} msgs | ` +
        `budget=${this.contextBudget.totalBudget}`,
    );

    return messages;
  }

  estimateTokens(messages: ConversationMessage[]): number {
    return messages.reduce((sum, m) => sum + this.contextBudget.estimateTokens(m.content) + 4, 3);
  }

  private buildSystemPrompt(context: AgentContext): string {
    const { user } = context;
    return [
      `你是 FlashClaw，一个专业、高效的个人 AI 智能体。`,
      ``,
      `## 用户信息`,
      user.name ? `- 名字: ${user.name}` : null,
      `- 语言偏好: ${user.language}`,
      `- 沟通风格: ${user.communicationStyle}`,
      `- 时区: ${user.timezone}`,
      user.keyFacts.length > 0
        ? `- 关键事实:\n${user.keyFacts.map((f) => `  - ${f}`).join("\n")}`
        : null,
      ``,
      `## 行为准则`,
      `- 根据用户的沟通风格偏好调整回复`,
      `- 主动使用工具完成任务，不要假设或猜测`,
      `- 如果需要多步操作，先制定计划再执行`,
      `- 对工具执行结果进行验证和总结`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildSkillSection(skills: unknown[]): string {
    if (!skills || skills.length === 0) return "";
    return "";
  }

  private buildMemorySection(memories: MemoryEntry[], maxTokens: number): string {
    if (!memories || memories.length === 0) return "";

    let content = "## 相关历史记忆\n";
    let tokens = this.contextBudget.estimateTokens(content);

    for (const memory of memories) {
      const dateStr = new Date(memory.timestamp).toLocaleDateString("zh-CN");
      const line = `[${dateStr}] ${memory.content}\n`;
      const lineTokens = this.contextBudget.estimateTokens(line);

      if (tokens + lineTokens > maxTokens) break;

      content += line;
      tokens += lineTokens;
    }

    return content;
  }
}
