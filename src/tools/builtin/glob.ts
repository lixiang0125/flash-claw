/**
 * @module glob
 * @description 文件模式匹配搜索工具。
 *
 * 使用 glob 语法在文件系统中搜索匹配特定模式的文件。
 * 支持常见的 glob 模式语法，
 * 适合快速定位项目中的特定类型文件。
 */
import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/**
 * Glob 工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - pattern: 文件匹配模式，（支持通配符语法）
 * - path: 可选的搜索路径，默认使用当前工作目录
 */
const GlobInput: ZodType<{
  pattern: string;
  path?: string;
}> = z.object({
  pattern: z.string().describe("文件匹配模式，如 *.ts, **/*.js"),
  path: z.string().optional().describe("搜索路径，默认当前目录"),
});

/**
 * Glob 工具的输出结果接口。
 *
 * @property pattern - 使用的匹配模式
 * @property matches - 匹配到的文件路径列表（最多 100 个）
 * @property count - 匹配到的文件总数
 */
interface GlobOutput {
  pattern: string;
  matches: string[];
  count: number;
}

/**
 * Glob 文件搜索工具定义。
 *
 * 使用 glob 模式在指定目录下搜索文件。
 * 无需用户审批即可执行（只读操作）。
 *
 * @example
 * // 搜索所有 TypeScript 文件
 * globTool.execute({ pattern: "src/components/index.ts" })
 *
 * @example
 * // 在 src 目录下递归搜索文件
 * globTool.execute({ pattern: "src/lib/utils.ts", path: "src" })
 */
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
    { input: { pattern: "src/*.ts" } },
    { input: { pattern: "src/**/*.js", path: "src" } },
  ],
  /**
   * 执行 glob 文件搜索。
   *
   * @param input - 输入参数，包含匹配模式和可选的搜索路径
   * @param context - 工具执行上下文，提供工作目录等信息
   * @returns 包含匹配文件列表和计数的结果对象
   */
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
