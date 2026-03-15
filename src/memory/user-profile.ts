import type { DatabaseService } from "./short-term-memory";
import type { Logger } from "../core/container/tokens";

export interface UserProfile {
  userId: string;
  name: string;
  email?: string;
  company?: string;
  role?: string;
  bio?: string;
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

  get(sessionId: string): UserProfile | null {
    return this.getProfile(sessionId) as unknown as UserProfile | null;
  }

  getOrCreate(sessionId: string): UserProfile {
    return this.getProfile(sessionId) as unknown as UserProfile;
  }

  async update(sessionId: string, updates: Partial<Pick<UserProfile, "name" | "email" | "company" | "role" | "bio" | "preferences">>): Promise<UserProfile | null> {
    const userId = sessionId;
    const updatesToApply: Partial<UserProfile> = {};
      
    if (updates.name !== undefined) updatesToApply.name = updates.name;
    if (updates.email !== undefined) updatesToApply.email = updates.email;
    if (updates.company !== undefined) updatesToApply.company = updates.company;
    if (updates.role !== undefined) updatesToApply.role = updates.role;
    if (updates.bio !== undefined) updatesToApply.bio = updates.bio;
    if (updates.preferences !== undefined) updatesToApply.preferences = updates.preferences;

    if (Object.keys(updatesToApply).length > 0) {
      await this.updateProfile(userId, updatesToApply);
    }
    
    return this.getProfile(userId);
  }

  async appendPreference(sessionId: string, key: string, value: string): Promise<UserProfile | null> {
    const profile = await this.getProfile(sessionId);
    const newPrefs = { ...profile.preferences, [key]: value };
    await this.updateProfile(sessionId, { preferences: newPrefs });
    return this.getProfile(sessionId);
  }

  toMarkdown(profile: UserProfile | null): string {
    if (!profile) {
      return "暂无用户信息";
    }

    if (!profile.name && !profile.email && !profile.company && !profile.role && !profile.bio && Object.keys(profile.preferences).length === 0) {
      return "暂无用户信息";
    }

    let md = "# 用户画像\n\n";

    if (profile.name) md += `- **名字**: ${profile.name}\n`;
    if (profile.email) md += `- **邮箱**: ${profile.email}\n`;
    if (profile.company) md += `- **公司**: ${profile.company}\n`;
    if (profile.role) md += `- **职位**: ${profile.role}\n`;
    if (profile.bio) md += `\n## 个人简介\n${profile.bio}\n`;
    if (Object.keys(profile.preferences).length > 0) md += `\n## 偏好设置\n`;
    for (const [key, value] of Object.entries(profile.preferences)) {
      md += `- **${key}**: ${value}\n`;
    }

    return md;
  }

  private saveProfile(profile: UserProfile): void {
    this.db.run(
      `INSERT OR REPLACE INTO user_profiles
        (user_id, name, email, company, role, bio, preferred_model, language, communication_style,
         timezone, key_facts, frequent_tools, preferences, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.userId,
        profile.name,
        profile.email || null,
        profile.company || null,
        profile.role || null,
        profile.bio || null,
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
      email: row.email as string | undefined,
      company: row.company as string | undefined,
      role: row.role as string | undefined,
      bio: row.bio as string | undefined,
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
        email TEXT,
        company TEXT,
        role TEXT,
        bio TEXT,
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
