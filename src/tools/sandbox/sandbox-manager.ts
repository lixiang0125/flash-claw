import type {
  SandboxConfig,
  SandboxInstance,
  ExecResult,
  PoolStats,
} from "./sandbox-types.js";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox-types.js";

export interface ISandboxManager {
  initialize(): Promise<void>;
  acquire(sessionId: string): Promise<SandboxInstance>;
  release(sessionId: string): Promise<void>;
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  readFile(sessionId: string, filePath: string): Promise<string>;
  writeFile(sessionId: string, filePath: string, content: string): Promise<void>;
  listDir(sessionId: string, dirPath: string): Promise<string[]>;
  getPoolStats(): PoolStats;
  dispose(): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class SandboxManager implements ISandboxManager {
  private config: SandboxConfig;
  private logger: Logger;
  private initialized = false;
  private pool: Map<string, SandboxInstance> = new Map();
  private sessionMap: Map<string, string> = new Map();
  private localWorkDir: string;

  constructor(
    config: Partial<SandboxConfig> = {},
    logger: Logger = console,
  ) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.logger = logger;
    this.localWorkDir = process.cwd();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.logger.info("SandboxManager initializing (local mode)");
    this.initialized = true;
  }

  async acquire(sessionId: string): Promise<SandboxInstance> {
    const existingId = this.sessionMap.get(sessionId);
    if (existingId && this.pool.has(existingId)) {
      return this.pool.get(existingId)!;
    }

    const instance: SandboxInstance = {
      containerId: `local-${sessionId}`,
      workDir: this.localWorkDir,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "busy",
      sessionId,
    };

    this.pool.set(instance.containerId, instance);
    this.sessionMap.set(sessionId, instance.containerId);
    return instance;
  }

  async release(sessionId: string): Promise<void> {
    const containerId = this.sessionMap.get(sessionId);
    if (!containerId) return;

    const instance = this.pool.get(containerId);
    if (instance) {
      instance.status = "idle";
      instance.sessionId = null;
      instance.lastUsedAt = Date.now();
    }
    this.sessionMap.delete(sessionId);
  }

  async exec(sessionId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const { execSync } = await import("child_process");
    const startTime = Date.now();

    try {
      const result = execSync(command, {
        cwd: this.localWorkDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
      });

      return {
        exitCode: 0,
        stdout: result,
        stderr: "",
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string; stdout?: string; stderr?: string };
      return {
        exitCode: err.status ?? -1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        timedOut: err.message?.includes("timeout") ?? false,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async readFile(sessionId: string, filePath: string): Promise<string> {
    const { readFileSync } = await import("fs");
    const fullPath = filePath.startsWith("/") ? filePath : `${this.localWorkDir}/${filePath}`;
    return readFileSync(fullPath, "utf-8");
  }

  async writeFile(sessionId: string, filePath: string, content: string): Promise<void> {
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    const fullPath = filePath.startsWith("/") ? filePath : `${this.localWorkDir}/${filePath}`;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  async listDir(sessionId: string, dirPath: string): Promise<string[]> {
    const { readdirSync } = await import("fs");
    const fullPath = dirPath.startsWith("/") ? dirPath : `${this.localWorkDir}/${dirPath}`;
    return readdirSync(fullPath);
  }

  getPoolStats(): PoolStats {
    let idle = 0, busy = 0;
    for (const inst of this.pool.values()) {
      if (inst.status === "idle") idle++;
      else if (inst.status === "busy") busy++;
    }
    return {
      totalContainers: this.pool.size,
      idleContainers: idle,
      busyContainers: busy,
      waitingRequests: 0,
    };
  }

  async dispose(): Promise<void> {
    this.pool.clear();
    this.sessionMap.clear();
    this.initialized = false;
    this.logger.info("SandboxManager disposed");
  }
}
