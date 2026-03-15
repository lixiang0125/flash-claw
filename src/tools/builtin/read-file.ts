/**
 * @module read-file
 * @description 文件读取工具。
 *
 * 读取指定路径的文件内容，支持文本文件（代码、配置、日志等）。
 * 提供按行范围读取和大文件自动截断功能。
 * 不支持二进制文件，文件大小限制为 1MB，输出限制为 50000 字符。
 */
import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/** 最大允许读取的文件大小：1MB */
const MAX_FILE_SIZE = 1024 * 1024;
/** 最大输出字符数：50000 字符，超出部分将被截断 */
const MAX_OUTPUT_CHARS = 50_000;

/**
 * 文件读取工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - path: 文件路径，相对于工作目录或绝对路径
 * - startLine: 可选的起始行号（从 1 开始）
 * - endLine: 可选的结束行号（包含该行）
 */
const ReadFileInput: ZodType<{
  path: string;
  startLine?: number;
  endLine?: number;
}> = z.object({
  path: z.string().describe("文件路径，相对于工作目录"),
  startLine: z.number().int().positive().optional().describe("起始行号（可选，从 1 开始）"),
  endLine: z.number().int().positive().optional().describe("结束行号（可选，包含该行）"),
});

/**
 * 文件读取工具的输出结果接口。
 *
 * @property path - 读取的文件路径
 * @property content - 文件内容文本
 * @property totalLines - 文件的总行数
 * @property displayedLines - 实际显示的行数
 * @property truncated - 内容是否被截断
 */
interface ReadFileOutput {
  path: string;
  content: string;
  totalLines: number;
  displayedLines: number;
  truncated: boolean;
}

/**
 * 文件读取工具定义。
 *
 * 读取文本文件内容，支持全文读取和按行范围读取。
 * 无需用户审批即可执行（只读操作）。
 *
 * @example
 * // 读取整个文件
 * { path: "src/index.ts" }
 *
 * @example
 * // 读取指定行范围
 * { path: "README.md", startLine: 1, endLine: 50 }
 */
export const readFileTool: FlashClawToolDefinition<typeof ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description:
    "读取指定路径的文件内容。支持文本文件（代码、配置、日志等）。" +
    "对于大文件会自动截断并提示。不支持二进制文件。" +
    "路径相对于工作目录。",
  inputSchema: ReadFileInput,
  permissionLevel: "read",
  category: "filesystem",
  requiresSandbox: true,
  timeoutMs: 10_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { path: "src/index.ts" } },
    { input: { path: "README.md", startLine: 1, endLine: 50 } },
  ],
  /**
   * 将输出转换为模型可读的文本格式。
   *
   * 包含文件路径、行数信息，截断时显示剩余行数提示。
   *
   * @param output - 文件读取的原始输出
   * @returns 格式化后的文本字符串
   */
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
  /**
   * 执行文件读取操作。
   *
   * @param input - 输入参数，包含文件路径和可选的行范围
   * @param context - 工具执行上下文，提供工作目录等信息
   * @returns 包含文件内容和元信息的结果对象
   * @throws 当文件不存在或文件过大时抛出错误
   */
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
