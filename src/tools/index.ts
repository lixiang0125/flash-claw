import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  tool: string;
  output: string;
  error?: string;
}

/**
 * 文件读取工具
 */
const ReadTool: Tool = {
  name: "Read",
  description: "读取文件内容。用于查看文件或了解代码。",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "要读取的文件路径",
      },
    },
    required: ["filePath"],
  },
};

/**
 * 文件写入工具
 */
const WriteTool: Tool = {
  name: "Write",
  description: "写入或创建文件。用于创建新文件或覆盖现有文件。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "文件内容",
      },
      filePath: {
        type: "string",
        description: "目标文件路径",
      },
    },
    required: ["filePath", "content"],
  },
};

/**
 * 文件编辑工具
 */
const EditTool: Tool = {
  name: "Edit",
  description: "编辑文件的特定部分。使用精确字符串替换修改现有文件。",
  parameters: {
    type: "object",
    properties: {
      newString: {
        type: "string",
        description: "替换后的文本",
      },
      oldString: {
        type: "string",
        description: "要替换的原始文本（必须精确匹配）",
      },
      filePath: {
        type: "string",
        description: "要编辑的文件路径",
      },
    },
    required: ["filePath", "oldString", "newString"],
  },
};

/**
 * Bash 命令执行工具
 */
const BashTool: Tool = {
  name: "Bash",
  description: "执行 shell 命令。用于运行脚本、安装依赖、执行 git 命令等。",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的命令",
      },
      description: {
        type: "string",
        description: "命令用途描述",
      },
    },
    required: ["command"],
  },
};

/**
 * 文件搜索工具
 */
const GlobTool: Tool = {
  name: "Glob",
  description: "搜索匹配模式的文件。用于查找特定类型的文件。",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "glob 模式，如 **/*.ts",
      },
    },
    required: ["pattern"],
  },
};

/**
 * 内容搜索工具
 */
const GrepTool: Tool = {
  name: "Grep",
  description: "在文件中搜索内容。用于查找特定代码或文本。",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "要搜索的正则表达式或文本",
      },
      path: {
        type: "string",
        description: "搜索路径，默认当前目录",
      },
    },
    required: ["pattern"],
  },
};

export const TOOLS: Tool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool];

/**
 * 执行工具
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any>
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case "Read":
        return executeRead(args.filePath);
      case "Write":
        return executeWrite(args.filePath, args.content);
      case "Edit":
        return executeEdit(args.filePath, args.oldString, args.newString);
      case "Bash":
        return executeBash(args.command);
      case "Glob":
        return executeGlob(args.pattern);
      case "Grep":
        return executeGrep(args.pattern, args.path);
      default:
        return { tool: toolName, output: "", error: `Unknown tool: ${toolName}` };
    }
  } catch (error: any) {
    return { tool: toolName, output: "", error: error.message };
  }
}

/**
 * 读取文件
 */
function executeRead(filePath: string): ToolResult {
  const fullPath = path.resolve(process.cwd(), filePath);
  
  if (!fs.existsSync(fullPath)) {
    return { tool: "Read", output: "", error: `File not found: ${filePath}` };
  }

  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath);
      return { tool: "Read", output: `Directory: ${filePath}\n\nFiles:\n${files.join("\n")}` };
    }
    
    const content = fs.readFileSync(fullPath, "utf-8");
    return { tool: "Read", output: `File: ${filePath}\n\n${content}` };
  } catch (error: any) {
    return { tool: "Read", output: "", error: error.message };
  }
}

/**
 * 写入文件
 */
function executeWrite(filePath: string, content: string): ToolResult {
  const fullPath = path.resolve(process.cwd(), filePath);
  const dir = path.dirname(fullPath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(fullPath, content, "utf-8");
    return { tool: "Write", output: `File written: ${filePath}` };
  } catch (error: any) {
    return { tool: "Write", output: "", error: error.message };
  }
}

/**
 * 编辑文件
 */
function executeEdit(filePath: string, oldString: string, newString: string): ToolResult {
  const fullPath = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(fullPath)) {
    return { tool: "Edit", output: "", error: `File not found: ${filePath}` };
  }

  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    
    if (!content.includes(oldString)) {
      return { tool: "Edit", output: "", error: "oldString not found in file" };
    }
    
    const newContent = content.replace(oldString, newString);
    fs.writeFileSync(fullPath, newContent, "utf-8");
    return { tool: "Edit", output: `File edited: ${filePath}` };
  } catch (error: any) {
    return { tool: "Edit", output: "", error: error.message };
  }
}

/**
 * 执行 Bash 命令
 */
function executeBash(command: string): ToolResult {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      cwd: process.cwd(),
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { tool: "Bash", output: output || "Command executed successfully" };
  } catch (error: any) {
    return { tool: "Bash", output: error.stdout || "", error: error.message };
  }
}

/**
 * 执行 Glob 搜索
 */
function executeGlob(pattern: string): ToolResult {
  const { glob } = require("glob");
  
  try {
    const files = glob.sync(pattern, { cwd: process.cwd() });
    return { tool: "Glob", output: files.join("\n") || "No files found" };
  } catch (error: any) {
    return { tool: "Glob", output: "", error: error.message };
  }
}

/**
 * 执行 Grep 搜索
 */
function executeGrep(pattern: string, searchPath?: string): ToolResult {
  const targetPath = searchPath || process.cwd();
  
  try {
    const output = execSync(`grep -r "${pattern}" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" --include="*.md" -l "${targetPath}"`, {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    return { tool: "Grep", output: output || "No matches found" };
  } catch (error: any) {
    return { tool: "Grep", output: "", error: "No matches found" };
  }
}

/**
 * 获取工具列表（用于 AI 选择）
 */
export function getToolsForAI(): { name: string; description: string; parameters: any }[] {
  return TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
