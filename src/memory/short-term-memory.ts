import type { ConversationMessage } from "./working-memory";

export interface DatabaseService {
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export interface ShortTermMemoryConfig {
  expirationMs: number;
  maxMessagesPerSession: number;
  cleanupIntervalMs: number;
}

const DEFAULT_STM_CONFIG: ShortTermMemoryConfig = {
  expirationMs: parseInt(process.env.SESSION_TIMEOUT || "1800000", 10),
  maxMessagesPerSession: 200,
  cleanupIntervalMs: 60 * 60 * 1000,
};

export class ShortTermMemory {
  private db: DatabaseService;
  private config: ShortTermMemoryConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: DatabaseService, config?: Partial<ShortTermMemoryConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_STM_CONFIG, ...config };
    this.ensureTables();
  }

  initialize(): void {
    this.ensureTables();
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
  }

  upsertSession(
    sessionId: string,
    userId: string,
    platform: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.db.run(
      `INSERT INTO sessions (id, user_id, platform, started_at, last_active_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_active_at = excluded.last_active_at,
         metadata = COALESCE(excluded.metadata, sessions.metadata)`,
      [
        sessionId,
        userId,
        platform,
        Date.now(),
        Date.now(),
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  saveMessage(sessionId: string, message: ConversationMessage): string {
    const id = crypto.randomUUID();
    const tokenCount = this.estimateTokens(message.content);

    this.db.run(
      `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_name, timestamp, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.timestamp,
        tokenCount,
      ],
    );

    this.db.run("UPDATE sessions SET last_active_at = ? WHERE id = ?", [Date.now(), sessionId]);

    return id;
  }

  saveMessages(sessionId: string, messages: ConversationMessage[]): void {
    const fn = () => {
      for (const msg of messages) {
        this.saveMessage(sessionId, msg);
      }
    };
    this.db.transaction(fn);
  }

  getHistory(
    sessionId: string,
    limit?: number,
    beforeTimestamp?: number,
  ): ConversationMessage[] {
    let sql = "SELECT * FROM messages WHERE session_id = ?";
    const params: unknown[] = [sessionId];

    if (beforeTimestamp) {
      sql += " AND timestamp < ?";
      params.push(beforeTimestamp);
    }

    sql += " ORDER BY timestamp ASC";

    if (limit) {
      sql = `SELECT * FROM (
        SELECT * FROM messages WHERE session_id = ?
        ${beforeTimestamp ? "AND timestamp < ?" : ""}
        ORDER BY timestamp DESC LIMIT ?
      ) ORDER BY timestamp ASC`;
      params.push(limit);
    }

    return this.db.all(sql, params).map((row) => ({
      role: row.role as ConversationMessage["role"],
      content: row.content as string,
      toolCallId: row.tool_call_id as string | undefined,
      toolName: row.tool_name as string | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  getSessionTokenCount(sessionId: string): number {
    const result = this.db.get<{ total: number }>(
      "SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE session_id = ?",
      [sessionId],
    );
    return result?.total ?? 0;
  }

  getUserSessions(
    userId: string,
  ): Array<{ sessionId: string; platform: string; messageCount: number; lastActiveAt: number }> {
    return this.db.all(
      `SELECT s.id, s.platform, s.last_active_at, COUNT(m.id) as message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.user_id = ?
       GROUP BY s.id
       ORDER BY s.last_active_at DESC`,
      [userId],
    ).map((row) => ({
      sessionId: row.id as string,
      platform: row.platform as string,
      messageCount: row.message_count as number,
      lastActiveAt: row.last_active_at as number,
    }));
  }

  cleanup(): number {
    const cutoff = Date.now() - this.config.expirationMs;

    const msgResult = this.db.run(
      "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE last_active_at < ?)",
      [cutoff],
    );

    this.db.run("DELETE FROM sessions WHERE last_active_at < ?", [cutoff]);

    return msgResult.changes;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        timestamp INTEGER NOT NULL,
        token_count INTEGER DEFAULT 0,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `);
  }

  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }
}
