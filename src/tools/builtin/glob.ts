import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const GlobInput: ZodType<{
  pattern: string;
  path?: string;
}> = z.object({
  pattern: z.string().describe("文件匹配模式，如 *.ts, **/*.js"),
  path: z.string().optional().describe("搜索路径，默认当前目录"),
});

interface GlobOutput {
  pattern: string;
  matches: string[];
  count: number;
}

export const globTool: FlashClawToolDefinition<typeof GlobInput, GlobOutput> = {
  name: "glob",
  description:
    "使用模式匹配搜索文件。支持 glob 语法如 *.ts, **/*.js, src/**/*.ts 等。",
  inputSchema: GlobInput,
  permissionLevel: "read",
  category: "search",
  requiresSandbox: true,
  timeoutMs: 15_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { pattern: "*.ts" } },
    { input: { pattern: "**/*.js", path: "src" } },
  ],
  execute: async (input: { pattern: string; path?: string }, context: ToolExecutionContext): Promise<GlobOutput> => {
    const { glob } = await import("glob");
    const path = input.path || context.workingDirectory;
    const matches = await glob(input.pattern, {
      cwd: path,
      absolute: false,
    });

    return {
      pattern: input.pattern,
      matches: matches.slice(0, 100),
      count: matches.length,
    };
  },
};
