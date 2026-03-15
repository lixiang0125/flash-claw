/**
 * legacy-adapter.ts — 将旧工具系统 (src/tools/index.ts) 适配为新 FlashClawToolDefinition 格式。
 *
 * 这是一个过渡方案：
 * - 新 builtin 系统中已有原生实现的工具（bash, read_file 等）不会被适配
 * - 仅适配新系统中缺失的工具（飞书操作、用户画像、子智能体）
 * - 后续应逐步将各工具迁移为原生 builtin 实现，届时可删除此文件
 */

import { TOOLS, executeTool } from "./index.js";
import type { FlashClawToolDefinition, ToolExecutionContext } from "./types.js";
import { z } from "zod";

/**
 * PascalCase → snake_case 转换。
 * 例: "FeishuDoc" → "feishu_doc", "GetProfile" → "get_profile", "SubAgent" → "sub_agent"
 */
function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/**
 * 新 builtin 系统中已有原生实现的工具名称（PascalCase）。
 * 这些工具不需要通过适配器注册，避免重复。
 */
const BUILTIN_TOOL_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch", // web-fetch.ts 已存在，将在 bootstrap 中单独注册
]);

/**
 * 工具分类映射：将旧工具按功能归类到 ToolCategory。
 */
const CATEGORY_MAP: Record<string, "filesystem" | "shell" | "web" | "search" | "utility" | "integration"> = {
  FeishuDoc: "integration",
  FeishuDrive: "integration",
  FeishuPerm: "integration",
  FeishuWiki: "integration",
  GetProfile: "utility",
  UpdateProfile: "utility",
  SubAgent: "integration",
};

/**
 * 工具权限级别映射。
 */
const PERMISSION_MAP: Record<string, "read" | "write" | "execute" | "admin"> = {
  FeishuDoc: "write",
  FeishuDrive: "write",
  FeishuPerm: "admin",
  FeishuWiki: "write",
  GetProfile: "read",
  UpdateProfile: "write",
  SubAgent: "execute",
};

/**
 * 将旧系统中新系统缺失的工具适配为 FlashClawToolDefinition 格式。
 *
 * 适配策略：
 * 1. 名称从 PascalCase 转为 snake_case，以符合 ToolRegistry 的命名规范
 * 2. inputSchema 使用 z.object({}).passthrough()，接受任意输入（旧系统无 Zod schema）
 * 3. execute 内部调用旧系统的 executeTool()，保持原有逻辑不变
 * 4. 通过 originalName 映射回旧系统名称进行调用
 */
export function adaptLegacyTools(): FlashClawToolDefinition<any, any>[] {
  return TOOLS
    .filter((tool) => !BUILTIN_TOOL_NAMES.has(tool.name))
    .map((tool) => {
      const snakeName = toSnakeCase(tool.name);
      const originalName = tool.name; // 闭包捕获，用于 executeTool 调用

      return {
        name: snakeName,
        description: tool.description,
        inputSchema: z.object({}).passthrough(),
        permissionLevel: PERMISSION_MAP[originalName] ?? ("execute" as const),
        category: CATEGORY_MAP[originalName] ?? ("utility" as const),
        requiresSandbox: false,
        timeoutMs: 60_000,
        needsApproval: false,
        strict: false,

        execute: async (
          input: Record<string, unknown>,
          _context: ToolExecutionContext,
        ) => {
          const result = await executeTool(originalName, input as any);
          if (result.error) {
            throw new Error(result.error);
          }
          return { output: result.output };
        },

        toModelOutput: (output: { output: string }): string => {
          return output.output;
        },
      } satisfies FlashClawToolDefinition<any, any>;
    });
}

/**
 * 获取旧系统工具的 snake_case 名称到 PascalCase 名称的映射表。
 * 可用于调试和日志。
 */
export function getLegacyNameMapping(): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const tool of TOOLS) {
    if (!BUILTIN_TOOL_NAMES.has(tool.name)) {
      mapping[toSnakeCase(tool.name)] = tool.name;
    }
  }
  return mapping;
}
