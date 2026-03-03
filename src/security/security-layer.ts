import { glob } from "glob";
import type { SecurityPolicy, SecurityCheckResult, AuditEntry } from "./types.js";
import { DEFAULT_SECURITY_POLICY } from "./types.js";

const ALLOWED_EXECUTABLES = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "find", "echo",
  "node", "bun", "python", "python3", "pip", "npm", "npx",
  "git", "curl", "wget", "jq", "sed", "awk", "sort", "uniq",
  "mkdir", "rm", "cp", "mv", "touch", "chmod", "chown",
  "cd", "pwd", "whoami", "date", "true", "false",
]);

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface DatabaseService {
  execute(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

export class SecurityLayer {
  private policy: SecurityPolicy;
  private logger: Logger;
  private database: DatabaseService | null;
  private rateLimitMap: Map<string, number[]> = new Map();

  constructor(
    policy: SecurityPolicy = DEFAULT_SECURITY_POLICY,
    logger: Logger = console,
    database: DatabaseService | null = null,
  ) {
    this.policy = policy;
    this.logger = logger;
    this.database = database;
  }

  checkPath(path: string, mode: "read" | "write"): SecurityCheckResult {
    const normalizedPath = this.normalizePath(path);

    if (normalizedPath.includes("..")) {
      return {
        allowed: false,
        reason: `Path traversal detected: "${path}".`,
        riskLevel: "high",
      };
    }

    if (normalizedPath.startsWith("/etc/") || normalizedPath.startsWith("/var/")) {
      return {
        allowed: false,
        reason: `Access to system directory denied: "${path}".`,
        riskLevel: "high",
      };
    }

    const patterns = mode === "read"
      ? [...this.policy.readablePathPatterns, ...this.policy.writablePathPatterns]
      : this.policy.writablePathPatterns;

    for (const pattern of patterns) {
      if (this.matchPattern(normalizedPath, pattern)) {
        return { allowed: true, riskLevel: "none" };
      }
    }

    return {
      allowed: false,
      reason: `Path "${path}" is outside allowed ${mode} paths.`,
      riskLevel: "medium",
    };
  }

  checkCommand(command: string): SecurityCheckResult {
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

  private checkBlockedCommands(command: string): SecurityCheckResult {
    for (const blocked of this.policy.blockedCommands) {
      try {
        const regex = new RegExp(blocked, "i");
        if (regex.test(command)) {
          this.logger.warn(`Blocked dangerous command: ${command}`);
          return {
            allowed: false,
            reason: `Command matches blocked pattern: ${blocked}`,
            riskLevel: "high",
          };
        }
      } catch {
        continue;
      }
    }
    return { allowed: true, riskLevel: "none" };
  }

  private checkWhitelist(command: string): SecurityCheckResult {
    try {
      const { parse } = require("shell-quote");
      const tokens = parse(command);
      if (!tokens || tokens.length === 0) {
        return { allowed: true, riskLevel: "none" };
      }

      const executable = String(tokens[0]);
      if (!ALLOWED_EXECUTABLES.has(executable)) {
        this.logger.warn(`Command not in allowlist: ${executable}`);
        return {
          allowed: false,
          reason: `Executable not in allowlist: ${executable}`,
          riskLevel: "medium",
        };
      }

      return { allowed: true, riskLevel: "none" };
    } catch {
      return { allowed: true, riskLevel: "none" };
    }
  }

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

  sanitizeInput(input: string): { clean: string; threats: string[] } {
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

    return {
      clean: input,
      threats,
    };
  }

  audit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
    if (!this.database) return;

    try {
      this.database.execute(
        `INSERT INTO audit_log (user_id, session_id, action, target, result, reason, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.userId,
          entry.sessionId,
          entry.action,
          entry.target,
          entry.result,
          entry.reason || null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        ]
      );
    } catch (error) {
      this.logger.error("Failed to write audit log", { error });
    }
  }

  getAuditLog(filters?: {
    userId?: string;
    sessionId?: string;
    action?: string;
    limit?: number;
  }): AuditEntry[] {
    if (!this.database) return [];

    let sql = "SELECT * FROM audit_log WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.userId) {
      sql += " AND user_id = ?";
      params.push(filters.userId);
    }
    if (filters?.sessionId) {
      sql += " AND session_id = ?";
      params.push(filters.sessionId);
    }
    if (filters?.action) {
      sql += " AND action = ?";
      params.push(filters.action);
    }

    sql += " ORDER BY timestamp DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.database.query<AuditEntry>(sql, params);
  }

  private normalizePath(path: string): string {
    return path.replace(/^\.\//, "").replace(/\/+/g, "/");
  }

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
