import { z, ZodType } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const execAsync = promisify(exec);

const BashInput: ZodType<{
  command: string;
  timeout?: number;
}> = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeout: z.number().int().positive().optional().describe("超时时间（毫秒），默认 30000"),
});

interface BashOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export const bashTool: FlashClawToolDefinition<typeof BashInput, BashOutput> = {
  name: "bash",
  description:
    "执行 shell 命令。用于运行脚本、安装依赖、执行 git 命令等。",
  inputSchema: BashInput,
  permissionLevel: "execute",
  category: "shell",
  requiresSandbox: false,
  timeoutMs: 60_000,
  needsApproval: true,
  strict: false,
  inputExamples: [
    { input: { command: "npm install" } },
    { input: { command: "git status", timeout: 5000 } },
  ],
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
