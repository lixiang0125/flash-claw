import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const WriteFileInput: ZodType<{
  path: string;
  content: string;
}> = z.object({
  path: z.string().describe("目标文件路径"),
  content: z.string().describe("文件内容"),
});

interface WriteFileOutput {
  path: string;
  bytesWritten: number;
  success: boolean;
}

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
