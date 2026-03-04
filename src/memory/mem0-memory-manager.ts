import type { Memory } from "mem0ai/oss";
import type { Logger } from "../core/container/tokens";
import type { WorkingMemory, ConversationMessage } from "./working-memory";
import type { ShortTermMemory } from "./short-term-memory";
import type { MarkdownMemory } from "./markdown-memory";
import type { UserProfileService, UserProfile } from "./user-profile";
import * as fs from "fs/promises";
import * as path from "path";

export interface MemoryEntry {
  id: string;
  content: string;
  type: "conversation" | "fact" | "preference" | "skill_usage" | "task_result";
  userId: string;
  sessionId?: string;
  timestamp: number;
  importance: number;
  accessCount: number;
  lastAccessedAt: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  text: string;
  userId: string;
  sessionId?: string;
  types?: MemoryEntry["type"][];
  timeRange?: { start?: number; end?: number };
  limit?: number;
  minRelevance?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  relevanceScore: number;
  scores: {
    semantic: number;
    recency: number;
    importance: number;
  };
}

export interface IncomingMessage {
  sender: { id: string };
  conversationId: string;
  platform: string;
  content: { text?: string };
}

export interface IMemoryManager {
  store(entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessedAt">): Promise<string>;
  recall(query: MemoryQuery): Promise<MemorySearchResult[]>;
  storeInteraction(msg: IncomingMessage, response: string): Promise<void>;
  getUserProfile(userId: string): Promise<UserProfile>;
  updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void>;
  cleanup(maxAge?: number): Promise<number>;
}

interface Mem0MemoryManagerConfig {
  candidateMultiplier: number;
  defaultLimit: number;
  decayHalfLifeHours: number;
  weights: {
    semantic: number;
    recency: number;
    importance: number;
  };
}

const DEFAULT_CONFIG: Mem0MemoryManagerConfig = {
  candidateMultiplier: 2,
  defaultLimit: 10,
  decayHalfLifeHours: 168,
  weights: { semantic: 0.6, recency: 0.3, importance: 0.1 },
};

export class Mem0MemoryManager implements IMemoryManager {
  private config: Mem0MemoryManagerConfig;
  private logger: Logger;
  private workingMemory: WorkingMemory;
  private shortTermMemory: ShortTermMemory;
  private mem0: Memory;
  private markdownMemory: MarkdownMemory | null;
  private userProfile: UserProfileService;

  constructor(
    logger: Logger,
    workingMemory: WorkingMemory,
    shortTermMemory: ShortTermMemory,
    mem0: Memory,
    markdownMemory: MarkdownMemory | null,
    userProfile: UserProfileService,
    config?: Partial<Mem0MemoryManagerConfig>,
  ) {
    this.logger = logger;
    this.workingMemory = workingMemory;
    this.shortTermMemory = shortTermMemory;
    this.mem0 = mem0;
    this.markdownMemory = markdownMemory;
    this.userProfile = userProfile;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async store(
    entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessedAt">,
  ): Promise<string> {
    if (entry.sessionId) {
      this.shortTermMemory.saveMessage(entry.sessionId, {
        role: "user",
        content: entry.content,
        timestamp: entry.timestamp,
      });
    }

    if (entry.importance >= 0.3) {
      const result = await this.mem0.add(entry.content, {
        userId: entry.userId,
        agentId: "flash-claw",
        runId: entry.sessionId || "",
        metadata: { type: entry.type, importance: entry.importance, ...entry.metadata },
      });
      const results = (result as { results?: Array<{ id: string }> })?.results || [];
      return results[0]?.id || crypto.randomUUID();
    }

    return crypto.randomUUID();
  }

  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const limit = query.limit || this.config.defaultLimit;

    if (query.sessionId) {
      const recent = this.workingMemory.getRecent(query.sessionId, 5);
      for (const msg of recent) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        results.push({
          entry: {
            id: `wm-${msg.timestamp}`,
            content: msg.content,
            type: "conversation",
            userId: query.userId,
            sessionId: query.sessionId,
            timestamp: msg.timestamp,
            importance: 0.8,
            accessCount: 0,
            lastAccessedAt: Date.now(),
          },
          relevanceScore: 0.9,
          scores: { semantic: 0.9, recency: 1.0, importance: 0.8 },
        });
      }
    }

    try {
    const mem0Results = await this.mem0.search(query.text, {
      userId: query.userId,
      agentId: "flash-claw",
      limit: limit * this.config.candidateMultiplier,
    });

    const items = (mem0Results as unknown as { results?: Array<Record<string, unknown>> })?.results || [];
      for (const item of items) {
        results.push(this.toSearchResult(item, query));
      }
    } catch (err) {
      this.logger.error("mem0 search failed", { err, query: query.text });
    }

    return this.dedupeAndSort(results, limit);
  }

  async storeInteraction(msg: IncomingMessage, response: string): Promise<void> {
    const userId = msg.sender.id;
    const sessionId = msg.conversationId;
    const userText = msg.content.text ?? "";
    const now = Date.now();

    this.workingMemory.append(sessionId, {
      role: "user",
      content: userText,
      timestamp: now,
    });
    this.workingMemory.append(sessionId, {
      role: "assistant",
      content: response,
      timestamp: now,
    });
    await this.workingMemory.tryFlush(sessionId);

    this.shortTermMemory.upsertSession(sessionId, userId, msg.platform);
    this.shortTermMemory.saveMessage(sessionId, {
      role: "user",
      content: userText,
      timestamp: now,
    });
    this.shortTermMemory.saveMessage(sessionId, {
      role: "assistant",
      content: response,
      timestamp: now,
    });

    this.storeTomem0(userText, response, userId, sessionId).catch((err) =>
      this.logger.error("mem0 store failed", { err }),
    );

    this.appendMarkdownLog(userText, sessionId).catch(() => {});
  }

  private async storeTomem0(
    userMessage: string,
    assistantResponse: string,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const messages = [
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantResponse },
    ];

    const result = await this.mem0.add(messages, {
      userId,
      agentId: "flash-claw",
      runId: sessionId,
      metadata: { source: "chat", timestamp: Date.now() },
    });

    const results = (result as unknown as { results?: Array<{ event: string }> })?.results || [];
    const stats = {
      added: results.filter((r) => r.event === "ADD").length,
      updated: results.filter((r) => r.event === "UPDATE").length,
      deleted: results.filter((r) => r.event === "DELETE").length,
      noop: results.filter((r) => r.event === "NONE").length,
    };
    this.logger.info("mem0 store completed", { userId, sessionId, ...stats });
  }

  private async appendMarkdownLog(userMessage: string, sessionId: string): Promise<void> {
    if (!this.markdownMemory) return;

    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const logLine = `- **${time}** [${sessionId.slice(0, 8)}] ${userMessage.slice(0, 120)}\n`;
    await this.markdownMemory.appendDailyLog(logLine);
  }

  private toSearchResult(
    item: Record<string, unknown>,
    query: MemoryQuery,
  ): MemorySearchResult {
    const now = Date.now();
    const createdAt = item.created_at
      ? new Date(item.created_at as string).getTime()
      : now;
    const ageMs = now - createdAt;
    const halfLifeMs = this.config.decayHalfLifeHours * 3600 * 1000;

    const semanticScore = (item.score as number) ?? 0;
    const recencyScore = Math.exp((-0.693 * ageMs) / halfLifeMs);
    const importanceScore = ((item.metadata as Record<string, unknown>)?.importance as number) ?? 0.5;

    const { weights } = this.config;
    const relevanceScore =
      semanticScore * weights.semantic +
      recencyScore * weights.recency +
      importanceScore * weights.importance;

    return {
      entry: {
        id: (item.id as string) || "",
        content: (item.memory as string) || "",
        type: ((item.metadata as Record<string, unknown>)?.type as MemoryEntry["type"]) || "fact",
        userId: (item.user_id as string) || query.userId,
        sessionId: ((item.metadata as Record<string, unknown>)?.session_id as string),
        timestamp: createdAt,
        importance: importanceScore,
        accessCount: 0,
        lastAccessedAt: now,
        metadata: item.metadata as Record<string, unknown>,
      },
      relevanceScore,
      scores: {
        semantic: semanticScore,
        recency: recencyScore,
        importance: importanceScore,
      },
    };
  }

  private dedupeAndSort(
    results: MemorySearchResult[],
    limit: number,
  ): MemorySearchResult[] {
    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      const key = r.entry.content.slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return deduped.slice(0, limit);
  }

  async saveSessionToMarkdown(sessionId: string): Promise<void> {
    if (!this.markdownMemory) return;

    const messages = this.workingMemory.getMessages(sessionId);
    if (!messages || messages.length === 0) return;

    const content = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const emoji = m.role === "user" ? "👤" : "🤖";
        return `${emoji} **${m.role}**: ${m.content.slice(0, 200)}`;
      })
      .join("\n\n");

    const header = `## ${sessionId.slice(0, 8)}\n时间: ${new Date().toLocaleString("zh-CN")}\n\n`;
    await this.markdownMemory
      .appendDailyLog(header + content + "\n\n---\n\n")
      .catch((err) =>
        this.logger.error("Failed to save session to markdown", { err }),
      );
  }

  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.userProfile.getProfile(userId);
  }

  async updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    return this.userProfile.updateProfile(userId, updates);
  }

  async cleanup(maxAge?: number): Promise<number> {
    return this.shortTermMemory.cleanup();
  }

  async getMemory(memoryId: string) {
    return this.mem0.get(memoryId);
  }

  async updateMemory(memoryId: string, content: string) {
    return this.mem0.update(memoryId, content);
  }

  async deleteMemory(memoryId: string) {
    return this.mem0.delete(memoryId);
  }

  async deleteAllMemories(userId: string) {
    return this.mem0.deleteAll({ userId, agentId: "flash-claw" });
  }

  async listMemories(userId: string, limit = 100) {
    return this.mem0.getAll({ userId, agentId: "flash-claw", limit });
  }

  async getMemoryHistory(memoryId: string) {
    return this.mem0.history(memoryId);
  }
}
