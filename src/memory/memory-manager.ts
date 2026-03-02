import { WorkingMemory, type ConversationMessage } from "./working-memory";
import { ShortTermMemory } from "./short-term-memory";
import { LongTermMemory, type MemoryEntry, type MemoryQuery, type MemorySearchResult } from "./long-term-memory";
import { UserProfileService, type UserProfile } from "./user-profile";
import type { Logger } from "./embedding/embedding-service";

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
