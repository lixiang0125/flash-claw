/**
 * @module ShortTermMemory
 * @description 短期记忆模块 —— 四级记忆体系中的第二级。
 *
 * 短期记忆负责在单次会话（session）期间持久化对话消息，使用 SQLite 数据库存储。
 * 它位于工作记忆（第一级，纯内存）和 Markdown 记忆（第三级，文件系统）之间，
 * 提供跨请求但有时效性的对话历史管理能力。
 *
 * 主要职责：
 * - 会话的创建与更新（upsert 语义）
 * - 对话消息的存储与检索
 * - 会话级别的 Token 用量统计
 * - 过期会话的自动清理
 *
 * @example
 * ```typescript
 * import { ShortTermMemory } from "./short-term-memory";
 *
 * const stm = new ShortTermMemory(db, { expirationMs: 30 * 60 * 1000 });
 * stm.initialize();
 *
 * stm.upsertSession("session-1", "user-1", "wechat");
 * stm.saveMessage("session-1", { role: "user", content: "你好", timestamp: Date.now() });
 * const history = stm.getHistory("session-1");
 * ```
 */
import type { ConversationMessage } from "./working-memory";

/**
 * 数据库服务接口。
 *
 * 抽象了底层数据库操作，允许 {@link ShortTermMemory} 与具体的
 * SQLite 实现解耦。所有方法均为同步调用，与 better-sqlite3 的 API 风格一致。
 */
export interface DatabaseService {
  /**
   * 执行写操作 SQL（INSERT / UPDATE / DELETE）。
   *
   * @param sql - SQL 语句，可使用 `?` 占位符
   * @param params - 绑定参数数组
   * @returns 包含受影响行数和最后插入行 ID 的对象
   */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  /**
   * 查询单行记录。
   *
   * @typeParam T - 返回行的类型，默认为通用记录类型
   * @param sql - SQL 查询语句
   * @param params - 绑定参数数组
   * @returns 匹配的第一行记录，若无匹配则返回 `undefined`
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  /**
   * 查询多行记录。
   *
   * @typeParam T - 返回行的类型，默认为通用记录类型
   * @param sql - SQL 查询语句
   * @param params - 绑定参数数组
   * @returns 所有匹配行的数组
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /**
   * 执行原始 SQL（可包含多条语句）。
   *
   * @param sql - 要执行的 SQL 语句
   */
  exec(sql: string): void;
  /**
   * 在事务中执行回调函数。
   *
   * @typeParam T - 回调函数的返回类型
   * @param fn - 在事务内执行的回调
   * @returns 回调函数的返回值
   */
  transaction<T>(fn: () => T): T;
}

/**
 * 短期记忆配置选项。
 */
export interface ShortTermMemoryConfig {
  /** 会话过期时间（毫秒）。超过此时间未活动的会话将在清理时被删除。默认 30 分钟。 */
  expirationMs: number;
  /** 单个会话允许存储的最大消息数量。 */
  maxMessagesPerSession: number;
  /** 自动清理过期会话的定时器间隔（毫秒）。默认 1 小时。 */
  cleanupIntervalMs: number;
}

/**
 * 短期记忆的默认配置。
 *
 * - `expirationMs`：从环境变量 `SESSION_TIMEOUT` 读取，默认 1800000（30 分钟）
 * - `maxMessagesPerSession`：200 条
 * - `cleanupIntervalMs`：3600000（1 小时）
 */
const DEFAULT_STM_CONFIG: ShortTermMemoryConfig = {
  expirationMs: parseInt(process.env.SESSION_TIMEOUT || "1800000", 10),
  maxMessagesPerSession: 200,
  cleanupIntervalMs: 60 * 60 * 1000,
};

/**
 * 短期记忆管理器 —— 四级记忆体系中的第二级。
 *
 * 基于 SQLite 数据库提供会话级别的对话历史存储。与第一级工作记忆（纯内存、
 * 单次请求生命周期）不同，短期记忆可在同一会话的多次请求间持久化消息，
 * 但会在会话过期后自动清理。
 *
 * 四级记忆体系：
 * 1. **工作记忆**（WorkingMemory）—— 当前请求的上下文窗口
 * 2. **短期记忆**（ShortTermMemory）—— 会话级持久化 ← 本类
 * 3. **Markdown 记忆**（MarkdownMemory）—— 文件系统持久化
 * 4. **长期记忆**（向量嵌入）—— 语义检索
 *
 * @example
 * ```typescript
 * const stm = new ShortTermMemory(db);
 * stm.initialize();
 *
 * // 创建或更新会话
 * stm.upsertSession("s1", "u1", "wechat");
 *
 * // 保存消息
 * const msgId = stm.saveMessage("s1", {
 *   role: "user",
 *   content: "记住我喜欢喝咖啡",
 *   timestamp: Date.now(),
 * });
 *
 * // 检索历史
 * const history = stm.getHistory("s1", 50);
 * ```
 */
export class ShortTermMemory {
  /** 数据库服务实例，用于执行所有 SQL 操作。 */
  private db: DatabaseService;
  /** 当前生效的配置，由默认值与用户传入的配置合并而成。 */
  private config: ShortTermMemoryConfig;
  /** 定期清理过期会话的计时器句柄。调用 {@link dispose} 时释放。 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 创建短期记忆实例。
   *
   * 构造时会立即调用 {@link ensureTables} 创建所需的数据库表（如尚不存在）。
   * 注意：需要额外调用 {@link initialize} 来启动自动清理定时器。
   *
   * @param db - 数据库服务实例
   * @param config - 可选的配置项，将与默认配置合并
   */
  constructor(db: DatabaseService, config?: Partial<ShortTermMemoryConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_STM_CONFIG, ...config };
    this.ensureTables();
  }

  /**
   * 初始化短期记忆。
   *
   * 确保数据库表存在，并启动定期清理过期会话的后台计时器。
   * 应在构造实例后尽早调用此方法。
   */
  initialize(): void {
    this.ensureTables();
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
  }

  /**
   * 创建或更新会话记录。
   *
   * 使用 SQLite 的 `INSERT ... ON CONFLICT DO UPDATE` 语义：
   * - 若会话不存在，则创建新记录
   * - 若会话已存在，则更新 `last_active_at` 和 `metadata`
   *
   * @param sessionId - 会话唯一标识
   * @param userId - 用户标识
   * @param platform - 来源平台（如 `"wechat"`、`"api"` 等）
   * @param metadata - 可选的会话元数据（JSON 序列化存储）
   */
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

  /**
   * 保存单条对话消息到数据库。
   *
   * 为消息分配 UUID，估算 Token 数量后写入 `messages` 表，
   * 并更新所属会话的 `last_active_at` 时间戳。
   *
   * @param sessionId - 消息所属的会话 ID
   * @param message - 要保存的对话消息
   * @returns 新生成的消息 UUID
   */
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

  /**
   * 批量保存多条对话消息。
   *
   * 在单个数据库事务中执行，确保所有消息要么全部写入成功，要么全部回滚。
   *
   * @param sessionId - 消息所属的会话 ID
   * @param messages - 要保存的消息数组
   */
  saveMessages(sessionId: string, messages: ConversationMessage[]): void {
    const fn = () => {
      for (const msg of messages) {
        this.saveMessage(sessionId, msg);
      }
    };
    this.db.transaction(fn);
  }

  /**
   * 获取指定会话的对话历史。
   *
   * 消息按时间戳升序排列。当指定 `limit` 时，返回最近的 N 条消息
   *（通过子查询先按时间倒序取 N 条，再正序排列）。
   *
   * @param sessionId - 会话 ID
   * @param limit - 可选，最多返回的消息数量
   * @param beforeTimestamp - 可选，仅返回此时间戳之前的消息
   * @returns 对话消息数组，按时间升序排列
   */
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

  /**
   * 获取指定会话的总 Token 估算数量。
   *
   * 对该会话下所有消息的 `token_count` 字段求和。
   *
   * @param sessionId - 会话 ID
   * @returns Token 总数，若无消息则返回 0
   */
  getSessionTokenCount(sessionId: string): number {
    const result = this.db.get<{ total: number }>(
      "SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE session_id = ?",
      [sessionId],
    );
    return result?.total ?? 0;
  }

  /**
   * 获取指定用户的所有会话列表。
   *
   * 返回结果包含每个会话的消息数量统计，按最后活跃时间降序排列。
   *
   * @param userId - 用户标识
   * @returns 会话信息数组，包含 `sessionId`、`platform`、`messageCount`、`lastActiveAt`
   */
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

  /**
   * 清理过期的会话及其关联消息。
   *
   * 根据 {@link ShortTermMemoryConfig.expirationMs} 计算过期截止时间，
   * 先删除过期会话的消息，再删除会话记录本身。
   *
   * @returns 被删除的消息数量
   */
  cleanup(): number {
    const cutoff = Date.now() - this.config.expirationMs;

    const msgResult = this.db.run(
      "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE last_active_at < ?)",
      [cutoff],
    );

    this.db.run("DELETE FROM sessions WHERE last_active_at < ?", [cutoff]);

    return msgResult.changes;
  }

  /**
   * 释放资源。
   *
   * 停止后台清理定时器。应在应用关闭或不再需要此实例时调用。
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 确保所需的数据库表和索引存在。
   *
   * 创建 `sessions` 表（会话元信息）和 `messages` 表（对话消息），
   * 并建立用户、活跃时间、会话、时间戳等索引。使用 `IF NOT EXISTS`
   * 确保可重复调用。
   *
   * @private
   */
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

  /**
   * 估算文本的 Token 数量。
   *
   * 采用简易启发式算法：中文字符按每 1.5 个字符约 1 Token 计算，
   * 其他字符按每 4 个字符约 1 Token 计算。结果向上取整。
   *
   * @param text - 需要估算的文本内容
   * @returns 估算的 Token 数量
   * @private
   */
  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }
}
