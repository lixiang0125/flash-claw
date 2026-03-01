import { Database } from "bun:sqlite";
import path from "path";

export interface UserProfile {
  id: string;
  sessionId: string;
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  bio?: string;
  preferences?: string;
  createdAt: string;
  updatedAt: string;
}

class UserProfileStore {
  private db: ReturnType<Database>;

  constructor() {
    const dbPath = path.join(process.cwd(), "data", "profiles.db");
    
    const fs = require("fs");
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        name TEXT,
        email TEXT,
        company TEXT,
        role TEXT,
        bio TEXT,
        preferences TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * 获取或创建用户画像
   */
  getOrCreate(sessionId: string): UserProfile {
    let profile = this.db.prepare(`
      SELECT id, session_id as sessionId, name, email, company, role, bio, preferences, created_at as createdAt, updated_at as updatedAt
      FROM user_profiles
      WHERE session_id = ?
    `).get(sessionId) as UserProfile | undefined;

    if (!profile) {
      const id = `profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      
      this.db.prepare(`
        INSERT INTO user_profiles (id, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(id, sessionId, now, now);

      profile = {
        id,
        sessionId,
        createdAt: now,
        updatedAt: now,
      };
    }

    return profile;
  }

  /**
   * 获取用户画像
   */
  get(sessionId: string): UserProfile | null {
    return this.db.prepare(`
      SELECT id, session_id as sessionId, name, email, company, role, bio, preferences, created_at as createdAt, updated_at as updatedAt
      FROM user_profiles
      WHERE session_id = ?
    `).get(sessionId) as UserProfile | undefined ?? null;
  }

  /**
   * 更新用户画像
   */
  update(sessionId: string, updates: Partial<Pick<UserProfile, "name" | "email" | "company" | "role" | "bio" | "preferences">>): UserProfile | null {
    const profile = this.getOrCreate(sessionId);
    const now = new Date().toISOString();

    const fields: string[] = ["updated_at = ?"];
    const values: any[] = [now];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.email !== undefined) {
      fields.push("email = ?");
      values.push(updates.email);
    }
    if (updates.company !== undefined) {
      fields.push("company = ?");
      values.push(updates.company);
    }
    if (updates.role !== undefined) {
      fields.push("role = ?");
      values.push(updates.role);
    }
    if (updates.bio !== undefined) {
      fields.push("bio = ?");
      values.push(updates.bio);
    }
    if (updates.preferences !== undefined) {
      fields.push("preferences = ?");
      values.push(updates.preferences);
    }

    values.push(sessionId);

    this.db.prepare(`
      UPDATE user_profiles SET ${fields.join(", ")} WHERE session_id = ?
    `).run(...values);

    return this.get(sessionId);
  }

  /**
   * 追加偏好设置
   */
  appendPreference(sessionId: string, key: string, value: string): UserProfile | null {
    const profile = this.getOrCreate(sessionId);
    const preferences = profile.preferences ? JSON.parse(profile.preferences) : {};
    preferences[key] = value;
    
    return this.update(sessionId, { preferences: JSON.stringify(preferences) });
  }

  /**
   * 转换为 Markdown 格式
   */
  toMarkdown(profile: UserProfile): string {
    if (!profile.name && !profile.email && !profile.company && !profile.role && !profile.bio && !profile.preferences) {
      return "暂无用户信息";
    }

    let md = "# 用户画像\n\n";

    if (profile.name) {
      md += `- **名字**: ${profile.name}\n`;
    }
    if (profile.email) {
      md += `- **邮箱**: ${profile.email}\n`;
    }
    if (profile.company) {
      md += `- **公司**: ${profile.company}\n`;
    }
    if (profile.role) {
      md += `- **职位**: ${profile.role}\n`;
    }
    if (profile.bio) {
      md += `\n## 个人简介\n${profile.bio}\n`;
    }
    if (profile.preferences) {
      try {
        const prefs = JSON.parse(profile.preferences);
        if (Object.keys(prefs).length > 0) {
          md += `\n## 偏好设置\n`;
          for (const [key, value] of Object.entries(prefs)) {
            md += `- **${key}**: ${value}\n`;
          }
        }
      } catch {
        // ignore
      }
    }

    return md;
  }
}

export const userProfileStore = new UserProfileStore();
