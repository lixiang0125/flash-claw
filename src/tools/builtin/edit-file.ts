import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const EditFileInput: ZodType<{
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}> = z.object({
  path: z.string().describe("要编辑的文件路径"),
  oldString: z.string().describe("要替换的原始文本（必须精确匹配）"),
  newString: z.string().describe("替换后的文本"),
  replaceAll: z.boolean().default(false).describe("是否替换所有匹配项，默认 false"),
});

interface EditFileOutput {
  path: string;
  success: boolean;
  matchCount: number;
  message: string;
}

export const editFileTool: FlashClawToolDefinition<typeof EditFileInput, EditFileOutput> = {
  name: "edit_file",
  description:
    "编辑文件的特定部分。使用精确字符串替换修改现有文件的部分内容。" +
    "与 write_file 不同，edit_file 只会替换指定文本，不会覆盖整个文件。",
  inputSchema: EditFileInput,
  permissionLevel: "write",
  category: "filesystem",
  requiresSandbox: false,
  timeoutMs: 30_000,
  needsApproval: true,
  strict: true,
  inputExamples: [
    { input: { path: "src/index.ts", oldString: "const a = 1;", newString: "const a = 2;" } },
  ],
  execute: async (input: { path: string; oldString: string; newString: string; replaceAll?: boolean }, context: ToolExecutionContext): Promise<EditFileOutput> => {
    const fs = await import("fs");
    const path = await import("path");

    const fullPath = input.path.startsWith("/")
      ? input.path
      : `${context.workingDirectory}/${input.path}`;

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${input.path}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");

    if (!content.includes(input.oldString)) {
      throw new Error(
        `Text not found in file. The oldString must match exactly. ` +
        `File: ${input.path}`
      );
    }

    let newContent: string;
    let matchCount: number;

    if (input.replaceAll) {
      const regex = new RegExp(escapeRegExp(input.oldString), "g");
      newContent = content.replace(regex, input.newString);
      matchCount = (newContent.match(regex) || []).length;
    } else {
      newContent = content.replace(input.oldString, input.newString);
      matchCount = 1;
    }

    fs.writeFileSync(fullPath, newContent, "utf-8");

    return {
      path: input.path,
      success: true,
      matchCount,
      message: `Successfully replaced ${matchCount} occurrence(s)`,
    };
  },
};

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
