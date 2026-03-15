/**
 * @module security/security-layer
 * @description 安全层核心实现模块。
 * 提供路径访问控制、命令安全检查、输入净化、速率限制和审计日志等安全功能。
 * 该模块是整个安全子系统的入口，所有安全相关的操作都通过 {@link SecurityLayer} 类进行。
 */

import type { SecurityPolicy, SecurityCheckResult, AuditEntry, BlockedCommandEntry } from "./types.js";
import { DEFAULT_SECURITY_POLICY } from "./types.js";

/**
 * 内置的可执行文件白名单。
 * 包含常用的系统命令和开发工具，用于命令安全检查时的默认白名单。
 * 当安全策略未指定 allowedExecutables 时，将使用此白名单。
 *
 * @constant {Set<string>}
 */
const ALLOWED_EXECUTABLES = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "find", "echo",
  "node", "bun", "python", "python3", "pip", "npm", "npx",
  "git", "curl", "wget", "jq", "sed", "awk", "sort", "uniq",
  "mkdir", "rm", "cp", "mv", "touch", "chmod", "chown",
  "cd", "pwd", "whoami", "date", "true", "false",
]);

/**
 * 日志记录器接口。
 * 定义安全层所需的日志记录方法，支持不同级别的日志输出。
 * 默认实现使用 console 对象。
 *
 * @interface Logger
 * @property {Function} info - 输出信息级别日志
 * @property {Function} warn - 输出警告级别日志
 * @property {Function} debug - 输出调试级别日志
 * @property {Function} error - 输出错误级别日志
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 数据库服务接口。
 * 定义安全层持久化审计日志所需的数据库操作方法。
 *
 * @interface DatabaseService
 * @property {Function} execute - 执行写入类 SQL 语句（INSERT/UPDATE/DELETE），返回变更行数和最后插入行 ID
 * @property {Function} query - 执行查询类 SQL 语句（SELECT），返回结果数组
 */
export interface DatabaseService {
  execute(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/**
 * 安全层核心类。
 * 提供全面的安全检查和审计功能，包括路径访问控制、命令过滤、
 * 输入净化、速率限制和操作审计日志记录。
 *
 * @class SecurityLayer
 * @example
 * ```typescript
 * import { SecurityLayer } from "./security-layer";
 * import { DEFAULT_SECURITY_POLICY } from "./types";
 *
 * const security = new SecurityLayer(DEFAULT_SECURITY_POLICY);
 *
 * // 检查路径访问权限
 * const pathResult = security.checkPath("data/config.json", "read");
 * if (!pathResult.allowed) {
 *   console.error("路径访问被拒绝:", pathResult.reason);
 * }
 *
 * // 检查命令安全性
 * const cmdResult = security.checkCommand("ls -la");
 * if (cmdResult.allowed) {
 *   // 执行命令
 * }
 *
 * // 记录审计日志
 * security.audit({
 *   timestamp: Date.now(),
 *   action: "command_exec",
 *   target: "ls -la",
 *   allowed: true,
 * });
 * ```
 */
export class SecurityLayer {
  /** 当前生效的安全策略配置 */
  private policy: SecurityPolicy;
  /** 日志记录器实例 */
  private logger: Logger;
  /** 数据库服务实例，为 null 时审计日志仅存储在内存中 */
  private database: DatabaseService | null;
  /** 速率限制映射表，键为会话 ID，值为请求时间戳数组 */
  private rateLimitMap: Map<string, number[]> = new Map();
  /** 内存中的审计日志数组，用于快速查询 */
  private memoryAuditLog: AuditEntry[] = [];

  /**
   * 创建 SecurityLayer 实例。
   *
   * @constructor
   * @param {SecurityPolicy} [policy=DEFAULT_SECURITY_POLICY] - 安全策略配置，默认使用 {@link DEFAULT_SECURITY_POLICY}
   * @param {Logger} [logger=console] - 日志记录器实例，默认使用 console
   * @param {DatabaseService | null} [database=null] - 数据库服务实例，为 null 时审计日志仅存储在内存中
   */
  constructor(
    policy: SecurityPolicy = DEFAULT_SECURITY_POLICY,
    logger: Logger = console,
    database: DatabaseService | null = null,
  ) {
    this.policy = policy;
    this.logger = logger;
    this.database = database;
  }

  /**
   * 检查文件路径的访问权限。
   * 依次进行路径遍历攻击检测、策略阻止路径匹配和系统目录保护检查。
   *
   * @param {string} path - 需要检查的文件路径
   * @param {"read" | "write"} mode - 访问模式，read 表示读取，write 表示写入
   * @returns {SecurityCheckResult} 安全检查结果，包含是否允许、原因和风险等级
   */
  checkPath(path: string, mode: "read" | "write"): SecurityCheckResult {
    const normalizedPath = this.normalizePath(path);

    // Check path traversal
    if (normalizedPath.includes("..")) {
      return {
        allowed: false,
        reason: `Path traversal detected: "${path}".`,
        riskLevel: "high",
      };
    }

    // Check custom blockedPaths from policy
    if (this.policy.blockedPaths) {
      for (const blocked of this.policy.blockedPaths) {
        if (blocked.mode === "both" || blocked.mode === mode) {
          try {
            const regex = new RegExp(blocked.pattern);
            if (regex.test(normalizedPath)) {
              return {
                allowed: false,
                reason: `Path blocked by policy: ${blocked.description}`,
                riskLevel: "high",
              };
            }
          } catch {
            continue;
          }
        }
      }
    }

    // System directories: /etc/ and /var/ — only block writes, allow reads
    if (normalizedPath.startsWith("/etc/") || normalizedPath.startsWith("/var/")) {
      if (mode === "write") {
        return {
          allowed: false,
          reason: `Write access to system directory denied: "${path}".`,
          riskLevel: "high",
        };
      }
      // Read access to system directories is allowed
      return { allowed: true, riskLevel: "none" };
    }

    // For non-system-directory paths without traversal, default to allowed
    return { allowed: true, riskLevel: "none" };
  }

  /**
   * 检查命令的安全性。
   * 依次进行空命令检测、危险命令模式匹配和可执行文件白名单检查。
   *
   * @param {string} command - 需要检查的命令字符串
   * @returns {SecurityCheckResult} 安全检查结果，包含是否允许、原因和风险等级
   */
  checkCommand(command: string): SecurityCheckResult {
    // Handle empty command
    if (!command || command.trim().length === 0) {
      return {
        allowed: false,
        reason: "Empty command is not allowed.",
        riskLevel: "medium",
      };
    }

    const blockedCheck = this.checkBlockedCommands(command);
    if (!blockedCheck.allowed) {
      return blockedCheck;
    }

    const whitelistCheck = this.checkWhitelist(command);
    if (!whitelistCheck.allowed) {
      return whitelistCheck;
    }

    return { allowed: true, riskLevel: "none" };
  }

  /**
   * 检查命令是否匹配危险命令模式。
   * 遍历安全策略中的 blockedCommands 列表，逐一进行正则匹配。
   *
   * @private
   * @param {string} command - 需要检查的命令字符串
   * @returns {SecurityCheckResult} 安全检查结果
   */
  private checkBlockedCommands(command: string): SecurityCheckResult {
    for (const blocked of this.policy.blockedCommands) {
      try {
        const pattern = typeof blocked === "string" ? blocked : (blocked as BlockedCommandEntry).pattern;
        const regex = new RegExp(pattern, "i");
        if (regex.test(command)) {
          this.logger.warn(`Blocked dangerous command: ${command}`);
          return {
            allowed: false,
            reason: `Command matches blocked pattern: ${pattern}`,
            riskLevel: "high",
          };
        }
      } catch {
        continue;
      }
    }
    return { allowed: true, riskLevel: "none" };
  }

  /**
   * 检查命令中的可执行文件是否在白名单中。
   * 解析命令字符串，提取所有管道和链式命令中的可执行文件名，
   * 逐一检查是否在允许列表中。
   *
   * @private
   * @param {string} command - 需要检查的命令字符串
   * @returns {SecurityCheckResult} 安全检查结果
   */
  private checkWhitelist(command: string): SecurityCheckResult {
    // Determine the effective allowlist
    const effectiveAllowlist: Set<string> = this.policy.allowedExecutables
      ? new Set(this.policy.allowedExecutables)
      : ALLOWED_EXECUTABLES;

    try {
      const { parse } = require("shell-quote");

      // Split by && and || to handle chained commands
      const segments = command.split(/\s*(?:&&|\|\|)\s*/);

      for (const segment of segments) {
        // Split by | to handle piped commands
        const pipeParts = segment.split(/\s*\|\s*/);

        for (const part of pipeParts) {
          const trimmed = part.trim();
          if (!trimmed) continue;

          const tokens = parse(trimmed);
          if (!tokens || tokens.length === 0) continue;

          const executable = String(tokens[0]);
          if (!effectiveAllowlist.has(executable)) {
            this.logger.warn(`Command not in allowlist: ${executable}`);
            return {
              allowed: false,
              reason: `Executable not in allowlist: ${executable}`,
              riskLevel: "medium",
            };
          }
        }
      }

      return { allowed: true, riskLevel: "none" };
    } catch {
      return { allowed: true, riskLevel: "none" };
    }
  }

  /**
   * 检查指定会话的请求速率是否超限。
   * 使用滑动窗口算法（1 分钟窗口）统计请求次数。
   *
   * @param {string} sessionId - 会话唯一标识
   * @returns {SecurityCheckResult} 安全检查结果，超限时 riskLevel 为 "medium"
   */
  checkRateLimit(sessionId: string): SecurityCheckResult {
    const now = Date.now();
    const windowStart = now - 60_000;

    const timestamps = this.rateLimitMap.get(sessionId) || [];
    const recentTimestamps = timestamps.filter((t) => t > windowStart);

    if (recentTimestamps.length >= this.policy.rateLimitPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${recentTimestamps.length} requests/minute`,
        riskLevel: "medium",
      };
    }

    recentTimestamps.push(now);
    this.rateLimitMap.set(sessionId, recentTimestamps);

    return { allowed: true, riskLevel: "none" };
  }

  /**
   * 对用户输入进行安全净化检查。
   * 检测常见的提示词注入攻击模式，包括系统提示词注入、角色扮演注入和指令覆盖。
   *
   * @param {string} input - 需要净化检查的用户输入字符串
   * @returns {{ allowed: boolean; reason?: string; clean: string; threats: string[] }} 净化结果对象
   * @returns {boolean} returns.allowed - 输入是否安全
   * @returns {string} [returns.reason] - 不安全时的原因描述
   * @returns {string} returns.clean - 清理后的输入内容
   * @returns {string[]} returns.threats - 检测到的威胁类型列表
   */
  sanitizeInput(input: string): { allowed: boolean; reason?: string; clean: string; threats: string[] } {
    const threats: string[] = [];

    const systemPromptPattern = /\[SYSTEM\]/i;
    if (systemPromptPattern.test(input)) {
      threats.push("system-prompt-injection");
    }

    const rolePlayPattern = /you are now|pretend to be|act as/i;
    if (rolePlayPattern.test(input)) {
      threats.push("role-play-injection");
    }

    const ignorePattern = /ignore (previous|above|all) (instructions?|rules?|constraints?)/i;
    if (ignorePattern.test(input)) {
      threats.push("instruction-override");
    }

    const allowed = threats.length === 0;
    const reason = threats.length > 0 ? `Threat detected: ${threats[0]}` : undefined;

    return {
      allowed,
      reason,
      clean: input,
      threats,
    };
  }

  /**
   * 记录一条审计日志。
   * 将审计条目同时写入内存日志和数据库（如果数据库可用）。
   * 数据库写入失败时不会抛出异常，仅记录错误日志。
   *
   * @param {AuditEntry} entry - 审计日志条目
   * @returns {void}
   */
  audit(entry: AuditEntry): void {
    // Always store to in-memory audit log
    this.memoryAuditLog.push({ ...entry });

    // If database is available, also persist there
    if (this.database) {
      try {
        const userId = entry.userId || "";
        const sessionId = entry.sessionId || "";
        const target = entry.target || entry.detail || "";
        const result = entry.result || (entry.allowed ? "allowed" : "blocked");

        this.database.execute(
          `INSERT INTO audit_log (user_id, session_id, action, target, result, reason, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            sessionId,
            entry.action,
            target,
            result,
            entry.reason || null,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
          ]
        );
      } catch (error) {
        this.logger.error("Failed to write audit log", { error });
      }
    }
  }

  /**
   * 查询审计日志。
   * 从内存审计日志中按条件筛选并返回匹配的审计条目。
   *
   * @param {object} [filters] - 可选的筛选条件
   * @param {string} [filters.userId] - 按用户 ID 筛选
   * @param {string} [filters.sessionId] - 按会话 ID 筛选
   * @param {string} [filters.action] - 按操作类型筛选
   * @param {boolean} [filters.allowed] - 按是否允许筛选
   * @param {number} [filters.limit] - 限制返回的最大条目数
   * @returns {AuditEntry[]} 匹配筛选条件的审计日志条目数组
   */
  getAuditLog(filters?: {
    userId?: string;
    sessionId?: string;
    action?: string;
    allowed?: boolean;
    limit?: number;
  }): AuditEntry[] {
    let results = [...this.memoryAuditLog];

    if (filters) {
      if (filters.userId !== undefined) {
        results = results.filter((e) => e.userId === filters.userId);
      }
      if (filters.sessionId !== undefined) {
        results = results.filter((e) => e.sessionId === filters.sessionId);
      }
      if (filters.action !== undefined) {
        results = results.filter((e) => e.action === filters.action);
      }
      if (filters.allowed !== undefined) {
        results = results.filter((e) => e.allowed === filters.allowed);
      }
      if (filters.limit !== undefined) {
        results = results.slice(0, filters.limit);
      }
    }

    return results;
  }

  /**
   * 规范化文件路径。
   * 移除路径开头的 "./" 前缀并合并连续的斜杠。
   *
   * @private
   * @param {string} path - 需要规范化的路径
   * @returns {string} 规范化后的路径
   */
  private normalizePath(path: string): string {
    return path.replace(/^\.\//,  "").replace(/\/+/g, "/");
  }

  /**
   * 检查路径是否匹配指定的通配符模式。
   * 支持通配符全匹配、扩展名匹配和通用通配符匹配。
   *
   * @private
   * @param {string} path - 需要匹配的路径
   * @param {string} pattern - 通配符模式
   * @returns {boolean} 路径是否匹配该模式
   */
  private matchPattern(path: string, pattern: string): boolean {
    if (pattern === "**/*") return true;

    if (pattern.startsWith("*.") && path.endsWith(pattern.slice(1))) {
      return true;
    }

    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      return regex.test(path);
    }

    return path === pattern || path.startsWith(pattern + "/");
  }
}
