import { z, ZodType } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const execAsync = promisify(exec);

const GrepInput: ZodType<{
  query: string;
  path?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}> = z.object({
  query: z.string().describe("搜索模式（支持正则表达式）"),
  path: z.string().optional().describe("搜索的目录或文件路径"),
  filePattern: z.string().optional().describe("文件名过滤，如 *.ts"),
  caseSensitive: z.boolean().default(false).describe("是否区分大小写"),
  maxResults: z.number().int().min(1).max(500).default(50).describe("最大返回结果数"),
});

interface GrepMatch {
  file: string;
  lineNumber: number;
  lineContent: string;
}

interface GrepOutput {
  query: string;
  matchCount: number;
  truncated: boolean;
  matches: GrepMatch[];
}

export const grepTool: FlashClawToolDefinition<typeof GrepInput, GrepOutput> = {
  name: "grep",
  description:
    "在文件中搜索文本内容。使用 ripgrep (rg) 引擎，支持正则表达式。" +
    "返回匹配的文件名、行号和匹配内容。",
  inputSchema: GrepInput,
  permissionLevel: "read",
  category: "search",
  requiresSandbox: false,
  timeoutMs: 15_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { query: "function handleRequest", filePattern: "*.ts" } },
    { input: { query: "TODO|FIXME", maxResults: 20 } },
  ],
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
