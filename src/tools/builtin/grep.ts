/**
 * @module grep
 * @description 文本内容搜索工具。
 *
 * 使用 ripgrep (rg) 引擎在文件中搜索文本内容，支持正则表达式。
 * 返回匹配的文件名、行号和匹配内容，适合在大型代码库中
 * 快速定位特定代码片段或文本模式。
 */
import { z, ZodType } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/** 将 exec 函数包装为 Promise 版本，用于异步执行 ripgrep 命令 */
const execAsync = promisify(exec);

/**
 * Grep 工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - query: 搜索模式（支持正则表达式）
 * - path: 可选的搜索目录或文件路径
 * - filePattern: 可选的文件名过滤模式，（支持通配符）
 * - caseSensitive: 是否区分大小写，默认 false
 * - maxResults: 最大返回结果数，默认 50，最大 500
 */
const GrepInput: ZodType<{
  query: string;
  path?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}> = z.object({
  query: z.string().describe("搜索模式（支持正则表达式）"),
  path: z.string().optional().describe("搜索的目录或文件路径"),
  filePattern: z.string().optional().describe("文件名过滤，（支持通配符）"),
  caseSensitive: z.boolean().default(false).describe("是否区分大小写"),
  maxResults: z.number().int().min(1).max(500).default(50).describe("最大返回结果数"),
});

/**
 * 单个搜索匹配项的接口。
 *
 * @property file - 匹配所在的文件路径
 * @property lineNumber - 匹配所在的行号
 * @property lineContent - 匹配行的文本内容
 */
interface GrepMatch {
  file: string;
  lineNumber: number;
  lineContent: string;
}

/**
 * Grep 工具的输出结果接口。
 *
 * @property query - 执行的搜索模式
 * @property matchCount - 匹配的总数量
 * @property truncated - 结果是否被截断（达到 maxResults 上限）
 * @property matches - 匹配项列表
 */
interface GrepOutput {
  query: string;
  matchCount: number;
  truncated: boolean;
  matches: GrepMatch[];
}

/**
 * Grep 文本搜索工具定义。
 *
 * 通过 ripgrep 在文件中搜索文本，支持正则表达式和文件过滤。
 * 无需用户审批即可执行（只读操作）。
 *
 * @example
 * // 在 TypeScript 文件中搜索函数名
 * { query: "function handleRequest", filePattern: "src/*.ts" }
 *
 * @example
 * // 搜索 TODO 和 FIXME 注释
 * { query: "TODO|FIXME", maxResults: 20 }
 */
export const grepTool: FlashClawToolDefinition<typeof GrepInput, GrepOutput> = {
  name: "grep",
  description:
    "在文件中搜索文本内容。使用 ripgrep (rg) 引擎，支持正则表达式。" +
    "返回匹配的文件名、行号和匹配内容。",
  inputSchema: GrepInput,
  permissionLevel: "read",
  category: "search",
  requiresSandbox: true,
  timeoutMs: 15_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { query: "function handleRequest", filePattern: "src/*.ts" } },
    { input: { query: "TODO|FIXME", maxResults: 20 } },
  ],
  /**
   * 执行文本搜索。
   *
   * 使用 ripgrep (rg) 以 JSON 格式输出搜索结果，并解析为结构化数据。
   *
   * @param input - 输入参数，包含搜索模式、路径、文件过滤等选项
   * @param context - 工具执行上下文，提供工作目录等信息
   * @returns 包含匹配列表和统计信息的结果对象
   */
  execute: async (input: {
    query: string;
    path?: string;
    filePattern?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }, context: ToolExecutionContext): Promise<GrepOutput> => {
    const searchDir = input.path || context.workingDirectory;
    const args = ["rg", "--json", "-C", "2"];

    if (!input.caseSensitive) args.push("-i");
    if (input.filePattern) args.push("-g", input.filePattern);
    args.push("-m", String(input.maxResults || 50));
    args.push(input.query);
    args.push(searchDir);

    try {
      const { stdout } = await execAsync(args.join(" "), { timeout: 15000 });
      const matches: GrepMatch[] = [];
      let matchCount = 0;

      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === "match") {
            matches.push({
              file: data.data.path.text,
              lineNumber: data.data.line_number,
              lineContent: data.data.lines.text.trim(),
            });
            matchCount++;
          }
        } catch {
          continue;
        }
      }

      return {
        query: input.query,
        matchCount,
        truncated: matchCount >= (input.maxResults || 50),
        matches,
      };
    } catch (error) {
      return {
        query: input.query,
        matchCount: 0,
        truncated: false,
        matches: [],
      };
    }
  },
};
