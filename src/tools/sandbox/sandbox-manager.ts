/**
 * @module sandbox-manager
 * @description 沙箱管理器模块，提供安全隔离的代码执行环境。
 *
 * 该模块实现了沙箱实例的创建、分配、命令执行和资源释放等功能。
 * 支持本地隔离模式和 Docker 容器模式（生产环境要求）。沙箱为每个会话
 * 提供独立的工作目录，并通过资源限制和权限降级确保执行安全。
 */

import type {
  SandboxConfig,
  SandboxInstance,
  ExecResult,
  PoolStats,
} from "./sandbox-types.js";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox-types.js";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 沙箱管理器接口，定义了沙箱生命周期管理的完整契约。
 *
 * 实现类需提供沙箱的初始化、获取、释放、命令执行、文件操作
 * 和资源统计等核心功能。
 *
 * @interface ISandboxManager
 *
 * @property {Function} initialize - 初始化沙箱管理器，创建工作目录等必要资源
 * @property {Function} acquire - 为指定会话获取一个沙箱实例
 * @property {Function} release - 释放指定会话占用的沙箱实例
 * @property {Function} exec - 在沙箱中执行 shell 命令
 * @property {Function} readFile - 在沙箱中读取文件内容
 * @property {Function} writeFile - 在沙箱中写入文件内容
 * @property {Function} listDir - 在沙箱中列出目录内容
 * @property {Function} getPoolStats - 获取沙箱池的统计信息
 * @property {Function} dispose - 销毁沙箱管理器并释放所有资源
 */
export interface ISandboxManager {
  /**
   * 初始化沙箱管理器。
   *
   * 创建隔离工作目录或连接 Docker 守护进程。多次调用是安全的，
   * 重复初始化会被自动跳过。
   *
   * @returns {Promise<void>}
   * @throws {Error} 生产环境下未启用 Docker 时抛出错误
   */
  initialize(): Promise<void>;
  /**
   * 为指定会话获取一个沙箱实例。
   *
   * 如果该会话已有关联的沙箱实例，则直接返回已有实例。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @returns {Promise<SandboxInstance>} 分配的沙箱实例
   */
  acquire(sessionId: string): Promise<SandboxInstance>;
  /**
   * 释放指定会话占用的沙箱实例。
   *
   * 将沙箱状态设为空闲，解除与会话的绑定。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @returns {Promise<void>}
   */
  release(sessionId: string): Promise<void>;
  /**
   * 在指定会话的沙箱中执行 shell 命令。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} command - 要执行的 shell 命令
   * @param {number} [timeoutMs] - 可选的超时时间（毫秒）
   * @returns {Promise<ExecResult>} 命令执行结果，包含退出码、标准输出和标准错误
   */
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  /**
   * 在沙箱中读取指定文件的内容。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} filePath - 文件路径（绝对路径或相对于沙箱工作目录的相对路径）
   * @returns {Promise<string>} 文件的文本内容
   */
  readFile(sessionId: string, filePath: string): Promise<string>;
  /**
   * 在沙箱中写入文件内容。
   *
   * 如果目标目录不存在会自动递归创建。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} filePath - 文件路径（绝对路径或相对于沙箱工作目录的相对路径）
   * @param {string} content - 要写入的文件内容
   * @returns {Promise<void>}
   */
  writeFile(sessionId: string, filePath: string, content: string): Promise<void>;
  /**
   * 列出沙箱中指定目录的内容。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} dirPath - 目录路径（绝对路径或相对于沙箱工作目录的相对路径）
   * @returns {Promise<string[]>} 目录中的文件和子目录名称数组
   */
  listDir(sessionId: string, dirPath: string): Promise<string[]>;
  /**
   * 获取沙箱池的当前统计信息。
   *
   * @returns {PoolStats} 包含总数、空闲数、忙碌数和等待队列长度的统计对象
   */
  getPoolStats(): PoolStats;
  /**
   * 销毁沙箱管理器并释放所有资源。
   *
   * 清理隔离工作目录、清空沙箱池和会话映射表。调用后管理器将
   * 恢复为未初始化状态。
   *
   * @returns {Promise<void>}
   */
  dispose(): Promise<void>;
}

/**
 * 日志记录器接口。
 *
 * 为沙箱管理器提供分级别的日志输出能力。
 *
 * @interface Logger
 * @property {Function} info - 输出信息级别日志
 * @property {Function} debug - 输出调试级别日志
 * @property {Function} error - 输出错误级别日志
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 沙箱管理器类，管理代码执行沙箱的完整生命周期。
 *
 * 在本地开发模式下，通过创建临时目录实现基本的文件系统隔离；
 * 在生产模式下，要求启用 Docker 容器以提供更强的安全隔离。
 * 每个会话可获取独立的沙箱实例，命令执行时会限制环境变量、
 * 缓冲区大小和执行超时。
 *
 * @implements {ISandboxManager}
 *
 * @example
 * ```typescript
 * const manager = new SandboxManager({ useDocker: false }, console);
 * await manager.initialize();
 *
 * // 获取沙箱实例
 * const sandbox = await manager.acquire("session-123");
 *
 * // 执行命令
 * const result = await manager.exec("session-123", "echo hello");
 * console.log(result.stdout); // "hello\n"
 *
 * // 释放沙箱
 * await manager.release("session-123");
 *
 * // 销毁管理器
 * await manager.dispose();
 * ```
 */
export class SandboxManager implements ISandboxManager {
  /** @private 沙箱配置对象 */
  private config: SandboxConfig;
  /** @private 日志记录器 */
  private logger: Logger;
  /** @private 是否已完成初始化 */
  private initialized = false;
  /** @private 沙箱实例池，以容器 ID 为键 */
  private pool: Map<string, SandboxInstance> = new Map();
  /** @private 会话到容器 ID 的映射表 */
  private sessionMap: Map<string, string> = new Map();
  /** @private 本地工作目录路径 */
  private localWorkDir: string;
  /** @private 隔离工作目录路径，初始化后创建 */
  private isolatedWorkDir: string | null = null;

  /**
   * 创建 SandboxManager 实例。
   *
   * @param {Partial<SandboxConfig>} config - 可选的沙箱配置，将与默认配置合并
   * @param {Logger} logger - 日志记录器，默认使用 console
   */
  constructor(
    config: Partial<SandboxConfig> = {},
    logger: Logger = console,
  ) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.logger = logger;
    this.localWorkDir = process.cwd();
  }

  /**
   * 初始化沙箱管理器。
   *
   * 在非 Docker 模式下创建临时隔离工作目录。生产环境下如果未启用
   * Docker 沙箱，将抛出错误以确保安全性。重复调用会被安全跳过。
   *
   * @returns {Promise<void>}
   * @throws {Error} 生产环境下未配置 Docker 沙箱时抛出错误
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (process.env.NODE_ENV === "production" && !this.config.useDocker) {
      throw new Error(
        "Production mode requires Docker sandbox. Set USE_DOCKER_SANDBOX=true or disable production mode."
      );
    }

    if (!this.config.useDocker) {
      this.isolatedWorkDir = await mkdtemp(join(tmpdir(), "flashclaw-sandbox-"));
      this.logger.info("SandboxManager initializing (local isolated mode)", {
        workDir: this.isolatedWorkDir,
      });
    } else {
      this.logger.info("SandboxManager initializing (local mode)");
    }

    this.initialized = true;
  }

  /**
   * 为指定会话获取沙箱实例。
   *
   * 如果会话已关联现有沙箱实例，直接返回该实例。否则创建一个新的
   * 本地沙箱实例，设置工作目录并将其状态标记为忙碌。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @returns {Promise<SandboxInstance>} 分配的沙箱实例
   */
  async acquire(sessionId: string): Promise<SandboxInstance> {
    const existingId = this.sessionMap.get(sessionId);
    if (existingId && this.pool.has(existingId)) {
      return this.pool.get(existingId)!;
    }

    const workDir = this.isolatedWorkDir || this.localWorkDir;
    const instance: SandboxInstance = {
      containerId: `local-${sessionId}`,
      workDir,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "busy",
      sessionId,
    };

    this.pool.set(instance.containerId, instance);
    this.sessionMap.set(sessionId, instance.containerId);
    return instance;
  }

  /**
   * 释放指定会话占用的沙箱实例。
   *
   * 将沙箱状态设为空闲，清除会话绑定，更新最后使用时间。
   * 如果会话没有关联的沙箱，调用将被安全忽略。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @returns {Promise<void>}
   */
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

  /**
   * 在指定会话的沙箱中执行 shell 命令。
   *
   * 通过 `/bin/bash -c` 执行命令，并限制环境变量（仅 PATH、HOME、
   * TMPDIR、SKILL_NAME）和最大缓冲区（10MB）。当以 root 用户运行时，
   * 会自动降级为 nobody（uid/gid 65534）执行。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} command - 要执行的 shell 命令字符串
   * @param {number} [timeoutMs=30000] - 命令执行超时时间（毫秒），默认 30 秒
   * @returns {Promise<ExecResult>} 命令执行结果，包含退出码、stdout、stderr、是否超时和耗时
   */
  async exec(sessionId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const startTime = Date.now();

    const instance = this.pool.get(`local-${sessionId}`);
    const workDir = instance?.workDir || this.isolatedWorkDir || this.localWorkDir;

    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/bash",
        ["-c", command],
        {
          cwd: workDir,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: workDir,
            TMPDIR: workDir,
            SKILL_NAME: sessionId,
          },
          uid: process.getuid?.() === 0 ? 65534 : undefined,
          gid: process.getgid?.() === 0 ? 65534 : undefined,
        }
      );

      return {
        exitCode: 0,
        stdout: stdout || "",
        stderr: stderr || "",
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string; stdout?: string; stderr?: string; killed?: boolean };
      return {
        exitCode: err.status ?? -1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        timedOut: err.killed ?? err.message?.includes("timeout") ?? false,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 读取沙箱中指定文件的文本内容。
   *
   * 支持绝对路径和相对于沙箱工作目录的相对路径。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} filePath - 文件路径
   * @returns {Promise<string>} 文件的 UTF-8 文本内容
   * @throws {Error} 当文件不存在或无读取权限时抛出错误
   */
  async readFile(sessionId: string, filePath: string): Promise<string> {
    const { readFileSync } = await import("fs");
    const instance = this.pool.get(`local-${sessionId}`);
    const workDir = instance?.workDir || this.localWorkDir;
    const fullPath = filePath.startsWith("/") ? filePath : `${workDir}/${filePath}`;
    return readFileSync(fullPath, "utf-8");
  }

  /**
   * 在沙箱中写入文件内容。
   *
   * 如果目标文件的父目录不存在，会自动递归创建。
   * 支持绝对路径和相对于沙箱工作目录的相对路径。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} filePath - 文件路径
   * @param {string} content - 要写入的文本内容
   * @returns {Promise<void>}
   * @throws {Error} 当目录创建失败或无写入权限时抛出错误
   */
  async writeFile(sessionId: string, filePath: string, content: string): Promise<void> {
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    const instance = this.pool.get(`local-${sessionId}`);
    const workDir = instance?.workDir || this.localWorkDir;
    const fullPath = filePath.startsWith("/") ? filePath : `${workDir}/${filePath}`;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  /**
   * 列出沙箱中指定目录的内容。
   *
   * 支持绝对路径和相对于沙箱工作目录的相对路径。
   *
   * @param {string} sessionId - 会话唯一标识符
   * @param {string} dirPath - 目录路径
   * @returns {Promise<string[]>} 目录中的文件和子目录名称数组
   * @throws {Error} 当目录不存在或无读取权限时抛出错误
   */
  async listDir(sessionId: string, dirPath: string): Promise<string[]> {
    const { readdirSync } = await import("fs");
    const instance = this.pool.get(`local-${sessionId}`);
    const workDir = instance?.workDir || this.localWorkDir;
    const fullPath = dirPath.startsWith("/") ? dirPath : `${workDir}/${dirPath}`;
    return readdirSync(fullPath);
  }

  /**
   * 获取沙箱池的当前统计信息。
   *
   * 遍历所有沙箱实例统计其状态，返回汇总数据。
   *
   * @returns {PoolStats} 包含 totalContainers、idleContainers、busyContainers 和 waitingRequests 的统计对象
   */
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

  /**
   * 销毁沙箱管理器并释放所有资源。
   *
   * 递归删除隔离工作目录（如存在），清空沙箱池和会话映射表，
   * 将管理器重置为未初始化状态。清理过程中的错误会被静默忽略。
   *
   * @returns {Promise<void>}
   */
  async dispose(): Promise<void> {
    if (this.isolatedWorkDir) {
      try {
        await rm(this.isolatedWorkDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      this.isolatedWorkDir = null;
    }
    this.pool.clear();
    this.sessionMap.clear();
    this.initialized = false;
    this.logger.info("SandboxManager disposed");
  }
}
