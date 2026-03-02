export interface SecurityPolicy {
  readablePathPatterns: string[];
  writablePathPatterns: string[];
  blockedCommands: string[];
  rateLimitPerMinute: number;
  enforceSandbox: boolean;
}

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  riskLevel: "none" | "low" | "medium" | "high";
}

export interface AuditEntry {
  id?: number;
  timestamp: number;
  userId: string;
  sessionId: string;
  action: string;
  target: string;
  result: "allowed" | "blocked";
  reason?: string;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  readablePathPatterns: ["**/*"],
  writablePathPatterns: ["**/*"],
  blockedCommands: [
    "rm\\s+(-rf?|--recursive)\\s+/",
    "mkfs\\b",
    "dd\\s+if=.*of=/dev/",
    "curl\\b.*\\|\\s*(bash|sh)",
    "wget\\b.*\\|\\s*(bash|sh)",
    "nc\\s+-[le]",
    "sudo\\b",
    "chmod\\s+[0-7]*777",
    "chown\\b",
    "cat\\s+.*/etc/(passwd|shadow)",
    "printenv\\b",
    "kill\\s+-9\\s+1\\b",
    "pkill\\s+-9\\s+",
  ],
  rateLimitPerMinute: 60,
  enforceSandbox: true,
};
