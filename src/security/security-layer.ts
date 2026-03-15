import type { SecurityPolicy, SecurityCheckResult, AuditEntry, BlockedCommandEntry } from "./types.js";
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
  private memoryAuditLog: AuditEntry[] = [];

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

  private normalizePath(path: string): string {
    return path.replace(/^\.\//,  "").replace(/\/+/g, "/");
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
