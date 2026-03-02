import type { DatabaseService } from "./short-term-memory";
import type { Logger } from "./embedding/embedding-service";

export interface UserProfile {
  userId: string;
  name: string;
  preferredModel: string;
  language: string;
  communicationStyle: string;
  timezone: string;
  keyFacts: string[];
  frequentTools: string[];
  preferences: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export class UserProfileService {
  private db: DatabaseService;
  private cache = new Map<string, UserProfile>();
  private logger: Logger;

  constructor(db: DatabaseService, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.ensureTable();
  }

  async getProfile(userId: string): Promise<UserProfile> {
    if (this.cache.has(userId)) {
      return this.cache.get(userId)!;
    }

    const row = this.db.get<Record<string, unknown>>(
      "SELECT * FROM user_profiles WHERE user_id = ?",
      [userId],
    );

    if (row) {
      const profile = this.rowToProfile(row);
      this.cache.set(userId, profile);
      return profile;
    }

    const defaultProfile: UserProfile = {
      userId,
      name: "",
      preferredModel: "default",
      language: "zh-CN",
      communicationStyle: "detailed",
      timezone: "Asia/Shanghai",
      keyFacts: [],
      frequentTools: [],
      preferences: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.saveProfile(defaultProfile);
    this.cache.set(userId, defaultProfile);
    return defaultProfile;
  }

  async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    const current = await this.getProfile(userId);
    const updated: UserProfile = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
      keyFacts: updates.keyFacts
        ? [...new Set([...current.keyFacts, ...updates.keyFacts])]
        : current.keyFacts,
      frequentTools: updates.frequentTools
        ? [...new Set([...current.frequentTools, ...updates.frequentTools])]
        : current.frequentTools,
      preferences: updates.preferences
        ? { ...current.preferences, ...updates.preferences }
        : current.preferences,
    };

    this.saveProfile(updated);
    this.cache.set(userId, updated);

    this.logger.debug(`UserProfile updated for ${userId}`);
  }

  async updateFromInteraction(
    userId: string,
    toolName?: string,
    extractedFacts?: string[],
  ): Promise<void> {
    const updates: Partial<UserProfile> = {};

    if (toolName) {
      const profile = await this.getProfile(userId);
      const tools = [...profile.frequentTools];
      const idx = tools.indexOf(toolName);
      if (idx >= 0) tools.splice(idx, 1);
      tools.unshift(toolName);
      updates.frequentTools = tools.slice(0, 20);
    }

    if (extractedFacts && extractedFacts.length > 0) {
      updates.keyFacts = extractedFacts;
    }

    if (Object.keys(updates).length > 0) {
      await this.updateProfile(userId, updates);
    }
  }

  private saveProfile(profile: UserProfile): void {
    this.db.run(
      `INSERT OR REPLACE INTO user_profiles
        (user_id, name, preferred_model, language, communication_style,
         timezone, key_facts, frequent_tools, preferences, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.userId,
        profile.name,
        profile.preferredModel,
        profile.language,
        profile.communicationStyle,
        profile.timezone,
        JSON.stringify(profile.keyFacts),
        JSON.stringify(profile.frequentTools),
        JSON.stringify(profile.preferences),
        profile.createdAt,
        profile.updatedAt,
      ],
    );
  }

  private rowToProfile(row: Record<string, unknown>): UserProfile {
    return {
      userId: row.user_id as string,
      name: row.name as string,
      preferredModel: row.preferred_model as string,
      language: row.language as string,
      communicationStyle: row.communication_style as string,
      timezone: row.timezone as string,
      keyFacts: JSON.parse((row.key_facts as string) || "[]"),
      frequentTools: JSON.parse((row.frequent_tools as string) || "[]"),
      preferences: JSON.parse((row.preferences as string) || "{}"),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        preferred_model TEXT NOT NULL DEFAULT 'default',
        language TEXT NOT NULL DEFAULT 'zh-CN',
        communication_style TEXT NOT NULL DEFAULT 'detailed',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        key_facts TEXT NOT NULL DEFAULT '[]',
        frequent_tools TEXT NOT NULL DEFAULT '[]',
        preferences TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
}
