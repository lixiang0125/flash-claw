/**
 * @module edit-file
 * @description 文件编辑工具。
 *
 * 通过精确字符串匹配和替换来修改文件的部分内容。
 * 与 write-file 工具不同，edit-file 只替换指定的文本片段，
 * 不会覆盖整个文件，适合对现有文件进行局部修改。
 */
import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/**
 * 文件编辑工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - path: 要编辑的文件路径
 * - oldString: 要替换的原始文本（必须精确匹配）
 * - newString: 替换后的新文本
 * - replaceAll: 是否替换所有匹配项，默认 false
 */
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

/**
 * 文件编辑工具的输出结果接口。
 *
 * @property path - 被编辑的文件路径
 * @property success - 是否编辑成功
 * @property matchCount - 实际替换的匹配数量
 * @property message - 操作结果描述信息
 */
interface EditFileOutput {
  path: string;
  success: boolean;
  matchCount: number;
  message: string;
}

/**
 * 文件编辑工具定义。
 *
 * 使用精确字符串替换方式修改文件内容，支持单次替换和全局替换。
 * 需要用户审批（needsApproval: true）才能执行写操作。
 *
 * @example
 * // 替换单个匹配
 * { path: "src/index.ts", oldString: "const a = 1;", newString: "const a = 2;" }
 */
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
  /**
   * 执行文件编辑操作。
   *
   * @param input - 输入参数，包含文件路径、原始文本、替换文本和替换模式
   * @param context - 工具执行上下文，提供工作目录等信息
   * @returns 包含替换结果的对象
   * @throws 当文件不存在或原始文本未找到时抛出错误
   */
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
      matchCount = (content.match(regex) || []).length;
      newContent = content.replace(regex, input.newString);
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

/**
 * 转义正则表达式特殊字符。
 *
 * 将字符串中的正则特殊字符进行转义，使其可以安全地用于 RegExp 构造。
 *
 * @param string - 需要转义的原始字符串
 * @returns 转义后的安全字符串
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
