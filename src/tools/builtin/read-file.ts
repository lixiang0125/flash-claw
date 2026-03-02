import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_OUTPUT_CHARS = 50_000;

const ReadFileInput: ZodType<{
  path: string;
  startLine?: number;
  endLine?: number;
}> = z.object({
  path: z.string().describe("文件路径，相对于工作目录"),
  startLine: z.number().int().positive().optional().describe("起始行号（可选，从 1 开始）"),
  endLine: z.number().int().positive().optional().describe("结束行号（可选，包含该行）"),
});

interface ReadFileOutput {
  path: string;
  content: string;
  totalLines: number;
  displayedLines: number;
  truncated: boolean;
}

export const readFileTool: FlashClawToolDefinition<typeof ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description:
    "读取指定路径的文件内容。支持文本文件（代码、配置、日志等）。" +
    "对于大文件会自动截断并提示。不支持二进制文件。" +
    "路径相对于工作目录。",
  inputSchema: ReadFileInput,
  permissionLevel: "read",
  category: "filesystem",
  requiresSandbox: false,
  timeoutMs: 10_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { path: "src/index.ts" } },
    { input: { path: "README.md", startLine: 1, endLine: 50 } },
  ],
  toModelOutput: (output: ReadFileOutput): string => {
    if (output.truncated) {
      return (
        `[File: ${output.path}] (${output.totalLines} lines, showing ${output.displayedLines} lines)\n` +
        `${output.content}\n` +
        `[... truncated, ${output.totalLines - output.displayedLines} more lines]`
      );
    }
    return `[File: ${output.path}] (${output.totalLines} lines)\n${output.content}`;
  },
  execute: async (input: { path: string; startLine?: number; endLine?: number }, context: ToolExecutionContext): Promise<ReadFileOutput> => {
    const { path, startLine, endLine } = input;

    const fs = await import("fs");
    const fullPath = path.startsWith("/") ? path : `${context.workingDirectory}/${path}`;

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${path}`);
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). ` +
        `Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB.`
      );
    }

    let content = fs.readFileSync(fullPath, "utf-8");
    const totalLines = content.split("\n").length;

    if (startLine && endLine) {
      const lines = content.split("\n");
      content = lines.slice(startLine - 1, endLine).join("\n");
    }

    const truncated = content.length > MAX_OUTPUT_CHARS;
    if (truncated) {
      content = content.substring(0, MAX_OUTPUT_CHARS);
    }

    return {
      path,
      content,
      totalLines,
      displayedLines: content.split("\n").length,
      truncated,
    } as ReadFileOutput;
  },
};
