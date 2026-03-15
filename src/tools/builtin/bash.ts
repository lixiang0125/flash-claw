/**
 * @module bash
 * @description Shell 命令执行工具。
 *
 * 提供在沙箱环境中执行 shell 命令的能力，用于运行脚本、安装依赖、
 * 执行 git 命令、编译项目等系统级操作。命令通过 Node.js 的 child_process
 * 模块异步执行，支持超时控制和输出截断。
 */
import { z, ZodType } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/** 将 exec 函数包装为 Promise 版本，用于异步执行 shell 命令 */
const execAsync = promisify(exec);

/**
 * Bash 工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - command: 要执行的 shell 命令字符串
 * - timeout: 可选的超时时间（毫秒），默认 30000
 */
const BashInput: ZodType<{
  command: string;
  timeout?: number;
}> = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeout: z.number().int().positive().optional().describe("超时时间（毫秒），默认 30000"),
});

/**
 * Bash 工具的输出结果接口。
 *
 * @property command - 实际执行的命令
 * @property stdout - 标准输出内容（最多 100000 字符）
 * @property stderr - 标准错误输出（最多 100000 字符）
 * @property exitCode - 进程退出码，0 表示成功
 * @property timedOut - 是否因超时被终止
 * @property durationMs - 执行耗时（毫秒）
 */
interface BashOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Bash 工具定义。
 *
 * 在沙箱环境中执行 shell 命令，支持超时控制。
 * 需要用户审批（needsApproval: true）才能执行。
 *
 * @example
 * // 执行 npm install
 * { command: "npm install" }
 *
 * @example
 * // 带超时的 git 命令
 * { command: "git status", timeout: 5000 }
 */
export const bashTool: FlashClawToolDefinition<typeof BashInput, BashOutput> = {
  name: "bash",
  description:
    "执行 shell 命令。用于运行脚本、安装依赖、执行 git 命令等。",
  inputSchema: BashInput,
  permissionLevel: "execute",
  category: "shell",
  requiresSandbox: true,
  timeoutMs: 60_000,
  needsApproval: true,
  strict: false,
  inputExamples: [
    { input: { command: "npm install" } },
    { input: { command: "git status", timeout: 5000 } },
  ],
  /**
   * 执行 shell 命令。
   *
   * @param input - 输入参数，包含 command 和可选的 timeout
   * @param context - 工具执行上下文，提供工作目录等信息
   * @returns 包含命令输出、退出码、耗时等信息的结果对象
   */
  execute: async (input: { command: string; timeout?: number }, context: ToolExecutionContext): Promise<BashOutput> => {
    const timeout = input.timeout || 30_000;
    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd: context.workingDirectory,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        command: input.command,
        stdout: stdout.substring(0, 100000),
        stderr: stderr.substring(0, 100000),
        exitCode: 0,
        timedOut: false,
        durationMs: Date.now() - startTime,
      } as BashOutput;
    } catch (error: any) {
      return {
        command: input.command,
        stdout: error.stdout?.substring(0, 100000) || "",
        stderr: error.stderr?.substring(0, 100000) || error.message,
        exitCode: error.code || -1,
        timedOut: error.killed || false,
        durationMs: Date.now() - startTime,
      } as BashOutput;
    }
  },
};
