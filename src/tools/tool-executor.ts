/**
 * @module tool-executor
 * @description 工具执行器模块，负责工具调用的完整生命周期管理。
 *
 * 该模块提供了工具执行的核心流程，包括输入验证、权限检查、沙箱管理、
 * 超时控制和错误处理。支持单个工具执行和批量并发执行两种模式。
 * 所有执行结果均以统一的 {@link ToolExecutionResult} 格式返回。
 */

import type {
  FlashClawToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";
import type { ISandboxManager } from "./sandbox/sandbox-manager.js";

/**
 * 日志记录器接口。
 *
 * 定义了工具执行过程中所需的日志记录方法，支持不同级别的日志输出。
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
 * 事件总线接口。
 *
 * 用于在工具执行过程中发布事件通知，实现模块间的松耦合通信。
 *
 * @interface EventBus
 * @property {Function} emit - 发布事件，传入事件名称和负载数据
 */
export interface EventBus {
  emit(event: string, payload: unknown): void;
}

/**
 * 安全层接口。
 *
 * 提供文件路径和命令执行的安全检查功能，用于在工具执行前
 * 进行权限验证，防止未授权的文件访问和危险命令执行。
 *
 * @interface SecurityLayer
 * @property {Function} checkPath - 检查文件路径的读/写权限
 * @property {Function} checkCommand - 检查命令是否允许执行
 */
export interface SecurityLayer {
  checkPath(path: string, mode: "read" | "write"): { allowed: boolean; reason?: string };
  checkCommand(command: string): { allowed: boolean; reason?: string };
}

/**
 * 工具执行器类，负责协调和执行已注册的工具调用。
 *
 * 执行流程依次为：工具查找 -> 输入验证 -> 权限检查 -> 沙箱分配（如需要）
 * -> 工具执行（带超时控制）-> 结果格式化。任何步骤失败都会返回包含
 * 错误信息的 {@link ToolExecutionResult} 对象，而非抛出异常。
 *
 * @example
 * ```typescript
 * const executor = new ToolExecutor(toolsMap, sandboxManager, securityLayer, logger);
 *
 * // 执行单个工具
 * const result = await executor.execute("read_file", { path: "./src/index.ts" }, "session-1");
 * if (result.success) {
 *   console.log(result.output);
 * }
 *
 * // 批量执行多个工具
 * const results = await executor.executeBatch([
 *   { toolName: "read_file", input: { path: "./a.ts" } },
 *   { toolName: "read_file", input: { path: "./b.ts" } },
 * ], "session-1");
 * ```
 */
export class ToolExecutor {
  /**
   * 创建 ToolExecutor 实例。
   *
   * @param {Map<string, FlashClawToolDefinition>} tools - 已注册工具的映射表
   * @param {ISandboxManager} sandboxManager - 沙箱管理器，用于分配和管理执行沙箱
   * @param {SecurityLayer} securityLayer - 安全层，用于路径和命令的权限检查
   * @param {Logger} logger - 日志记录器
   */
  constructor(
    private tools: Map<string, FlashClawToolDefinition<any, any>>,
    private sandboxManager: ISandboxManager,
    private securityLayer: SecurityLayer,
    private logger: Logger,
  ) {}

  /**
   * 执行指定的工具调用。
   *
   * 完整执行流程：
   * 1. 查找工具定义，不存在则返回错误结果
   * 2. 使用 Zod schema 验证输入参数
   * 3. 对 bash 命令和文件操作进行安全权限检查
   * 4. 如工具需要沙箱，则从沙箱管理器获取实例
   * 5. 带超时控制地执行工具逻辑
   * 6. 格式化输出结果
   *
   * @param {string} toolName - 要执行的工具名称
   * @param {unknown} rawInput - 原始输入参数，将通过工具的 inputSchema 进行验证
   * @param {string} sessionId - 会话标识符，用于沙箱分配和日志追踪
   * @returns {Promise<ToolExecutionResult>} 执行结果对象，包含成功/失败状态、输出数据和元信息
   */
  async execute(
    toolName: string,
    rawInput: unknown,
    sessionId: string,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    const toolDef = this.tools.get(toolName);
    if (!toolDef) {
      return this.buildErrorResult(
        toolName,
        rawInput,
        startTime,
        `Unknown tool: "${toolName}". Available: ${Array.from(this.tools.keys()).join(", ")}`
      );
    }

    let validatedInput: unknown;
    try {
      const result = toolDef.inputSchema.safeParse(rawInput);
      if (!result.success) {
        return this.buildErrorResult(
          toolName,
          rawInput,
          startTime,
          `Invalid input: ${result.error.message}`
        );
      }
      validatedInput = result.data;
    } catch (err) {
      return this.buildErrorResult(
        toolName,
        rawInput,
        startTime,
        `Validation error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const authResult = this.authorize(toolDef, validatedInput);
    if (!authResult.allowed) {
      return this.buildErrorResult(
        toolName,
        validatedInput,
        startTime,
        `Authorization denied: ${authResult.reason}`
      );
    }

    let sandbox = null;
    try {
      if (toolDef.requiresSandbox) {
        sandbox = await this.sandboxManager.acquire(sessionId);
      }

      const context: ToolExecutionContext = {
        sessionId,
        workingDirectory: sandbox?.workDir ?? process.cwd(),
        sandbox,
        securityPolicy: this.securityLayer,
        eventBus: { emit: () => {} },
        logger: this.logger,
      };

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Tool timed out after ${toolDef.timeoutMs}ms`)),
          toolDef.timeoutMs
        );
      });

      const rawResult = await Promise.race([
        toolDef.execute(validatedInput as never, context),
        timeoutPromise,
      ]);

      const output = toolDef.toModelOutput
        ? toolDef.toModelOutput(rawResult as never)
        : typeof rawResult === "string"
          ? rawResult
          : JSON.stringify(rawResult, null, 2);

      return {
        success: true,
        data: rawResult,
        error: null,
        durationMs: Date.now() - startTime,
        output: typeof output === "string" ? output : JSON.stringify(output),
        metadata: {
          toolName,
          inputSummary: JSON.stringify(validatedInput).substring(0, 200),
          sandboxUsed: toolDef.requiresSandbox,
          approvalRequired: typeof toolDef.needsApproval === "boolean"
            ? toolDef.needsApproval
            : false,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.buildErrorResult(toolName, validatedInput, startTime, errorMsg);
    }
  }

  /**
   * 批量并发执行多个工具调用。
   *
   * 所有工具调用将通过 Promise.all 并发执行。注意：如果其中一个工具
   * 执行失败，不会影响其他工具的执行（每个工具内部都有独立的错误处理）。
   *
   * @param {Array<{toolName: string, input: unknown}>} calls - 工具调用数组，每项包含工具名和输入参数
   * @param {string} sessionId - 会话标识符
   * @returns {Promise<ToolExecutionResult[]>} 执行结果数组，顺序与输入的调用数组一致
   */
  async executeBatch(
    calls: Array<{ toolName: string; input: unknown }>,
    sessionId: string,
  ): Promise<ToolExecutionResult[]> {
    return Promise.all(
      calls.map((call) => this.execute(call.toolName, call.input, sessionId))
    );
  }

  /**
   * 对工具调用进行安全授权检查。
   *
   * 针对不同类型的工具执行特定的安全检查：
   * - bash 工具：检查命令是否在允许列表中
   * - 文件操作工具（read_file、write_file、glob、grep）：检查文件路径的读写权限
   *
   * @param {FlashClawToolDefinition} toolDef - 工具定义
   * @param {unknown} input - 已验证的输入参数
   * @returns {{ allowed: boolean; reason?: string }} 授权结果，不允许时附带拒绝原因
   * @private
   */
  private authorize(
    toolDef: FlashClawToolDefinition<any, any>,
    input: unknown,
  ): { allowed: boolean; reason?: string } {
    if (toolDef.name === "bash" && typeof (input as { command?: string })?.command === "string") {
      const cmdCheck = this.securityLayer.checkCommand((input as { command: string }).command);
      if (!cmdCheck.allowed) return cmdCheck;
    }

    const fileTools = ["read_file", "write_file", "glob", "grep"];
    if (fileTools.includes(toolDef.name)) {
      const path = (input as { path?: string })?.path;
      if (path) {
        const mode = toolDef.permissionLevel === "read" ? "read" : "write";
        const pathCheck = this.securityLayer.checkPath(path, mode);
        if (!pathCheck.allowed) return pathCheck;
      }
    }

    return { allowed: true };
  }

  /**
   * 构建统一格式的错误结果对象。
   *
   * @param {string} toolName - 工具名称
   * @param {unknown} input - 原始输入参数
   * @param {number} startTime - 执行开始的时间戳（毫秒）
   * @param {string} error - 错误信息描述
   * @returns {ToolExecutionResult} 标记为失败的执行结果对象
   * @private
   */
  private buildErrorResult(
    toolName: string,
    input: unknown,
    startTime: number,
    error: string,
  ): ToolExecutionResult {
    return {
      success: false,
      data: null,
      error,
      durationMs: Date.now() - startTime,
      output: `Error: ${error}`,
      metadata: {
        toolName,
        inputSummary: JSON.stringify(input).substring(0, 200),
        sandboxUsed: false,
        approvalRequired: false,
      },
    };
  }
}
