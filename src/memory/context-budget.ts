import type { ConversationMessage } from "./working-memory";

export interface ContextBudgetConfig {
  modelMaxTokens: number;
  budgetTokens: number;
  allocation: {
    systemPrompt: number;
    skills: number;
    longTermMemory: number;
    sessionHistory: number;
    currentMessage: number;
    responseReserve: number;
  };
}

const DEFAULT_BUDGET_CONFIG: ContextBudgetConfig = {
  modelMaxTokens: 128_000,
  budgetTokens: 20_000,
  allocation: {
    systemPrompt: 0.1,
    skills: 0.1,
    longTermMemory: 0.15,
    sessionHistory: 0.45,
    currentMessage: 0.1,
    responseReserve: 0.1,
  },
};

export class ContextBudget {
  private config: ContextBudgetConfig;

  constructor(config?: Partial<ContextBudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };

    const totalAllocation = Object.values(this.config.allocation).reduce(
      (sum, v) => sum + v,
      0,
    );
    if (Math.abs(totalAllocation - 1.0) > 0.01) {
      throw new Error(
        `Context budget allocation must sum to 1.0, got ${totalAllocation}`,
      );
    }
  }

  getAllocations(): Record<string, number> {
    const total = this.config.budgetTokens;
    return {
      systemPrompt: Math.floor(total * this.config.allocation.systemPrompt),
      skills: Math.floor(total * this.config.allocation.skills),
      longTermMemory: Math.floor(total * this.config.allocation.longTermMemory),
      sessionHistory: Math.floor(total * this.config.allocation.sessionHistory),
      currentMessage: Math.floor(total * this.config.allocation.currentMessage),
      responseReserve: Math.floor(total * this.config.allocation.responseReserve),
    };
  }

  rebalance(actualUsage: Record<string, number>): Record<string, number> {
    const allocations = this.getAllocations();
    let surplus = 0;

    for (const [key, budget] of Object.entries(allocations)) {
      if (key === "sessionHistory" || key === "responseReserve") continue;
      const used = actualUsage[key] ?? 0;
      if (used < budget) {
        surplus += budget - used;
        if (allocations[key] !== undefined) {
          allocations[key] = used;
        }
      }
    }

    const sessionHistory = allocations.sessionHistory ?? 0;
    allocations.sessionHistory = sessionHistory + surplus;

    return allocations;
  }

  estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  truncateToTokenBudget(text: string, maxTokens: number): string {
    let tokens = 0;
    let cutIndex = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text.charAt(i);
      if (/[\u4e00-\u9fff]/.test(char)) {
        tokens += 1 / 1.5;
      } else {
        tokens += 1 / 4;
      }
      if (Math.ceil(tokens) >= maxTokens) {
        cutIndex = i;
        break;
      }
      cutIndex = i + 1;
    }

    if (cutIndex < text.length) {
      return text.substring(0, cutIndex) + "\n[... 内容已截断以适应上下文预算]";
    }
    return text;
  }

  truncateHistory(
    messages: ConversationMessage[],
    maxTokens: number,
  ): ConversationMessage[] {
    let totalTokens = 0;
    let startIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;
      const msgTokens = this.estimateTokens(msg.content) + 4;
      if (totalTokens + msgTokens > maxTokens) break;
      totalTokens += msgTokens;
      startIndex = i;
    }

    return messages.slice(startIndex);
  }

  get totalBudget(): number {
    return this.config.budgetTokens;
  }
}
