import { WorkingMemory, type ConversationMessage } from "./working-memory";
import { ShortTermMemory } from "./short-term-memory";
import { LongTermMemory, type MemoryEntry, type MemoryQuery, type MemorySearchResult } from "./long-term-memory";
import { UserProfileService, type UserProfile } from "./user-profile";
import type { Logger } from "../core/container/tokens";
import * as fs from "fs/promises";
import * as path from "path";

export interface IncomingMessage {
  sender: { id: string };
  conversationId: string;
  platform: string;
  content: { text?: string };
}

export interface IMemoryManager {
  store(entry: Omit<MemoryEntry, "id" | "embedding" | "accessCount" | "lastAccessedAt">): Promise<string>;
  recall(query: MemoryQuery): Promise<MemorySearchResult[]>;
  storeInteraction(msg: IncomingMessage, response: string): Promise<void>;
  getUserProfile(userId: string): Promise<UserProfile>;
  updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void>;
  cleanup(maxAge?: number): Promise<number>;
}

export class MemoryManager implements IMemoryManager {
  private workingMemory: WorkingMemory;
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private userProfileService: UserProfileService;
  private logger: Logger;

  constructor(
    workingMemory: WorkingMemory,
    shortTermMemory: ShortTermMemory,
    longTermMemory: LongTermMemory,
    userProfileService: UserProfileService,
    logger: Logger,
  ) {
    this.workingMemory = workingMemory;
    this.shortTermMemory = shortTermMemory;
    this.longTermMemory = longTermMemory;
    this.userProfileService = userProfileService;
    this.logger = logger;
  }

  async store(
    entry: Omit<MemoryEntry, "id" | "embedding" | "accessCount" | "lastAccessedAt">,
  ): Promise<string> {
    if (entry.sessionId) {
      this.shortTermMemory.saveMessage(entry.sessionId, {
        role: "user",
        content: entry.content,
        timestamp: entry.timestamp,
      });
    }

    if (entry.importance >= 0.3) {
      return this.longTermMemory.store(entry);
    }

    return crypto.randomUUID();
  }

  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];

    if (query.sessionId) {
      const recentMessages = this.workingMemory.getRecent(query.sessionId, 5);
      for (const msg of recentMessages) {
        if (msg.role === "user" || msg.role === "assistant") {
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
    }

    const longTermResults = await this.longTermMemory.recall(query);
    results.push(...longTermResults);

    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      const key = r.entry.content.substring(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, query.limit ?? 10);
  }

  async storeInteraction(msg: IncomingMessage, response: string): Promise<void> {
    const userId = msg.sender.id;
    const sessionId = msg.conversationId;
    const userText = msg.content.text ?? "";

    this.workingMemory.append(sessionId, {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    });
    this.workingMemory.append(sessionId, {
      role: "assistant",
      content: response,
      timestamp: Date.now(),
    });

    await this.tryFlushIfNeeded(sessionId);
    await this.saveToMarkdownIfNeeded(userText, response, sessionId);

    this.shortTermMemory.upsertSession(sessionId, userId, msg.platform);
    this.shortTermMemory.saveMessage(sessionId, {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    });
    this.shortTermMemory.saveMessage(sessionId, {
      role: "assistant",
      content: response,
      timestamp: Date.now(),
    });

    this.longTermMemory
      .extractAndStoreFacts(userText, response, userId, sessionId)
      .catch((err) => this.logger.error(`Fact extraction failed: ${err}`));
  }

  private async tryFlushIfNeeded(sessionId: string): Promise<void> {
    try {
      const flushed = await (this.workingMemory as any).tryFlush?.(sessionId);
      if (flushed) {
        this.logger.debug(`Pre-compaction flush triggered for session ${sessionId.slice(0, 8)}`);
      }
    } catch (err) {
      this.logger.warn(`Flush check failed: ${err}`);
    }
  }

  private async saveToMarkdownIfNeeded(userText: string, response: string, sessionId: string): Promise<void> {
    // OpenClaw 模式：每次对话都记录到 daily log
    // 这模仿了 OpenClaw 的 memory/YYYY-MM-DD.md 设计
    const workspacePath = process.env["WORKSPACE_PATH"] || "./data/workspace";
    if (!workspacePath) return;

    try {
      const today = new Date().toISOString().split("T")[0];
      const memoryDir = path.join(workspacePath, "memory");
      await fs.mkdir(memoryDir, { recursive: true });
      
      const logPath = path.join(memoryDir, `${today}.md`);
      const timestamp = new Date().toLocaleTimeString();
      
      const content = `\n- **${timestamp}** ${sessionId.slice(0, 4)}: ${userText.slice(0, 50)}${userText.length > 50 ? "..." : ""}\n`;
      
      const existing = await fs.readFile(logPath, "utf-8").catch(() => `# ${today}\n\n## 对话记录\n`);
      await fs.writeFile(logPath, existing + content);
    } catch (err) {
      // 静默失败，不影响主流程
    }
  }

  async saveSessionToMarkdown(sessionId: string): Promise<void> {
    const workspacePath = process.env["WORKSPACE_PATH"] || "./data/workspace";
    if (!workspacePath) return;

    try {
      const today = new Date().toISOString().split("T")[0];
      const memoryDir = path.join(workspacePath, "memory");
      await fs.mkdir(memoryDir, { recursive: true });
      
      const logPath = path.join(memoryDir, `${today}.md`);
      const messages = this.workingMemory.getMessages(sessionId);
      
      if (messages.length === 0) return;

      let content = `\n## ${sessionId.slice(0, 8)}\n`;
      content += `时间: ${new Date().toLocaleString()}\n\n`;
      
      for (const msg of messages) {
        const roleEmoji = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "📝";
        const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content;
        content += `${roleEmoji} **${msg.role}**: ${truncated}\n\n`;
      }

      const existing = await fs.readFile(logPath, "utf-8").catch(() => `# ${today}\n\n## 对话记录\n`);
      const hasSection = existing.includes("## 对话记录");
      
      if (!hasSection) {
        await fs.writeFile(logPath, existing + "## 对话记录\n" + content);
      } else {
        await fs.writeFile(logPath, existing + content);
      }
      
      this.logger.info(`Session ${sessionId.slice(0, 8)} saved to ${logPath}`);
    } catch (err) {
      this.logger.warn(`Failed to save session: ${err}`);
    }
  }

  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.userProfileService.getProfile(userId);
  }

  async updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    return this.userProfileService.updateProfile(userId, updates);
  }

  async cleanup(maxAge?: number): Promise<number> {
    return this.shortTermMemory.cleanup();
  }
}
