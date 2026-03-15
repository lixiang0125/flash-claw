/**
 * @module write-file
 * @description 文件写入工具。
 *
 * 创建新文件或覆盖已有文件的全部内容。
 * 自动创建不存在的父目录。与 edit-file 不同，
 * write-file 会覆盖整个文件，适合创建全新文件
 * 或需要完全重写的场景。
 */
import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/**
 * 文件写入工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - path: 目标文件路径，相对于工作目录或绝对路径
 * - content: 要写入的文件内容
 */
const WriteFileInput: ZodType<{
  path: string;
  content: string;
}> = z.object({
  path: z.string().describe("目标文件路径"),
  content: z.string().describe("文件内容"),
});

/**
 * 文件写入工具的输出结果接口。
 *
 * @property path - 写入的文件路径
 * @property bytesWritten - 写入的字节数
 * @property success - 是否写入成功
 */
interface WriteFileOutput {
  path: string;
  bytesWritten: number;
  success: boolean;
}

/**
 * 文件写入工具定义。
 *
 * 创建或覆盖文件，自动创建所需的父目录。
 * 需要用户审批（needsApproval: true）才能执行写操作。
 *
 * @example
 * // 创建新文件
 * { path: "src/new-file.ts", content: "console.log('hello');" }
 */
export const writeFileTool: FlashClawToolDefinition<typeof WriteFileInput, WriteFileOutput> = {
  name: "write_file",
  description:
    "写入或创建文件。如果文件已存在，会覆盖整个文件内容。" +
    "用于创建新文件或修改现有文件内容。",
  inputSchema: WriteFileInput,
  permissionLevel: "write",
  category: "filesystem",
  requiresSandbox: true,
  timeoutMs: 30_000,
  needsApproval: true,
  strict: true,
  inputExamples: [
    { input: { path: "src/new-file.ts", content: "console.log('hello');" } },
  ],
  /**
   * 执行文件写入操作。
   *
   * 将内容写入指定路径，如果父目录不存在会自动递归创建。
   *
   * @param input - 输入参数，包含文件路径和要写入的内容
   * @param context - 工具执行上下文，提供工作目录等信息
   * @returns 包含写入结果的对象
   */
  execute: async (input: { path: string; content: string }, context: ToolExecutionContext): Promise<WriteFileOutput> => {
    const fs = await import("fs/promises");
    const path = await import("path");

    const fullPath = input.path.startsWith("/")
      ? input.path
      : `${context.workingDirectory}/${input.path}`;

    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(fullPath, input.content, "utf-8");

    return {
      path: input.path,
      bytesWritten: input.content.length,
      success: true,
    } as WriteFileOutput;
  },
};
