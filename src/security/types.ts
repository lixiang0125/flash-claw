/**
 * @module security/types
 * @description 安全模块的核心类型定义文件。
 * 定义了安全策略、检查结果、审计日志等关键接口和默认安全策略常量。
 * 该模块为整个安全层提供统一的类型约束，确保安全检查流程的类型安全。
 */

/**
 * 被阻止的路径条目接口。
 * 用于在安全策略中定义需要限制访问的文件系统路径规则。
 *
 * @interface BlockedPathEntry
 * @property {string} pattern - 路径匹配的正则表达式模式
 * @property {"read" | "write" | "both"} mode - 阻止的访问模式：read 表示阻止读取，write 表示阻止写入，both 表示读写均阻止
 * @property {string} description - 该阻止规则的人类可读描述信息
 */
export interface BlockedPathEntry {
  pattern: string;
  mode: "read" | "write" | "both";
  description: string;
}

/**
 * 被阻止的命令条目接口。
 * 用于在安全策略中定义需要拦截的危险命令模式。
 *
 * @interface BlockedCommandEntry
 * @property {string} pattern - 命令匹配的正则表达式模式
 * @property {string} description - 该阻止规则的人类可读描述信息
 */
export interface BlockedCommandEntry {
  pattern: string;
  description: string;
}

/**
 * 安全策略接口。
 * 定义了完整的安全策略配置，包括路径访问控制、命令过滤、速率限制等。
 *
 * @interface SecurityPolicy
 * @property {string[]} readablePathPatterns - 允许读取的路径通配符模式列表
 * @property {string[]} writablePathPatterns - 允许写入的路径通配符模式列表
 * @property {(string | BlockedCommandEntry)[]} blockedCommands - 被阻止的命令模式列表，可以是正则字符串或 {@link BlockedCommandEntry} 对象
 * @property {BlockedPathEntry[]} [blockedPaths] - 可选的被阻止路径条目列表，提供更细粒度的路径访问控制
 * @property {string[]} [allowedExecutables] - 可选的允许执行的可执行文件白名单，未设置时使用内置默认白名单
 * @property {number} rateLimitPerMinute - 每分钟允许的最大请求数，用于速率限制
 * @property {boolean} enforceSandbox - 是否强制启用沙箱模式
 */
export interface SecurityPolicy {
  readablePathPatterns: string[];
  writablePathPatterns: string[];
  blockedCommands: (string | BlockedCommandEntry)[];
  blockedPaths?: BlockedPathEntry[];
  allowedExecutables?: string[];
  rateLimitPerMinute: number;
  enforceSandbox: boolean;
}

/**
 * 安全检查结果接口。
 * 表示一次安全检查操作的返回结果，包含是否允许、原因和风险等级。
 *
 * @interface SecurityCheckResult
 * @property {boolean} allowed - 检查是否通过，true 表示允许，false 表示拒绝
 * @property {string} [reason] - 可选的拒绝原因说明，当 allowed 为 false 时提供
 * @property {"none" | "low" | "medium" | "high"} riskLevel - 风险等级：none 表示无风险，low 表示低风险，medium 表示中风险，high 表示高风险
 */
export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  riskLevel: "none" | "low" | "medium" | "high";
}

/**
 * 审计日志条目接口。
 * 记录安全相关操作的审计信息，用于安全事件追踪和合规审查。
 *
 * @interface AuditEntry
 * @property {number} [id] - 可选的审计条目唯一标识符（数据库自增主键）
 * @property {number} timestamp - 操作发生的时间戳（Unix 毫秒时间戳）
 * @property {string} action - 执行的操作类型（如 "command_exec"、"path_access" 等）
 * @property {string} [detail] - 可选的操作详细描述
 * @property {string} [target] - 可选的操作目标（如文件路径或命令内容）
 * @property {boolean} [allowed] - 可选的操作是否被允许的标记
 * @property {"allowed" | "blocked"} [result] - 可选的操作结果状态
 * @property {string} [userId] - 可选的执行操作的用户标识
 * @property {string} [sessionId] - 可选的操作所属的会话标识
 * @property {string} [reason] - 可选的操作被拒绝的原因
 * @property {Record<string, unknown>} [metadata] - 可选的附加元数据，用于存储额外的上下文信息
 */
export interface AuditEntry {
  id?: number;
  timestamp: number;
  action: string;
  detail?: string;
  target?: string;
  allowed?: boolean;
  result?: "allowed" | "blocked";
  userId?: string;
  sessionId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 默认安全策略常量。
 * 提供了一套开箱即用的安全策略配置，包含以下默认规则：
 *
 * - **可读路径**：允许读取 data、.flashclaw、skills 目录以及常见文本格式文件（md/txt/json/yaml/yml）
 * - **可写路径**：仅允许写入 data 目录、.flashclaw/skills 和 .flashclaw/evolution 目录
 * - **危险命令拦截**：阻止递归删除根目录、格式化磁盘、远程代码执行、提权操作等高危命令
 * - **速率限制**：每分钟最多 60 次请求
 * - **沙箱模式**：默认开启
 *
 * @constant {SecurityPolicy}
 */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  readablePathPatterns: [
    "data/**/*",
    ".flashclaw/**/*",
    "skills/**/*",
    "*.md",
    "*.txt",
    "*.json",
    "*.yaml",
    "*.yml",
  ],
  writablePathPatterns: [
    "data/**/*",
    ".flashclaw/skills/**/*",
    ".flashclaw/evolution/**/*",
  ],
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
