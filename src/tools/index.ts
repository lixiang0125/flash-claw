import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { userProfileStore } from "../profiles";

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

/**
 * 网页抓取工具
 */
const WebFetchTool: Tool = {
  name: "WebFetch",
  description: "获取网页内容。用于获取URL的HTML或Markdown内容。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要获取的网页URL",
      },
      format: {
        type: "string",
        description: "返回格式: markdown (默认) 或 text 或 html",
      },
    },
    required: ["url"],
  },
};

/**
 * 互联网搜索工具
 */
const WebSearchTool: Tool = {
  name: "WebSearch",
  description: "搜索互联网获取信息。用于查询最新资讯、百科知识、新闻等不知道的信息。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词",
      },
      numResults: {
        type: "number",
        description: "返回结果数量，默认5",
      },
    },
    required: ["query"],
  },
};

/**
 * 获取用户画像工具
 */
const GetProfileTool: Tool = {
  name: "GetProfile",
  description: "获取当前用户的画像信息，包括名字、邮箱、公司、职位、偏好等。",
  parameters: {
    type: "object",
    properties: {},
  },
};

/**
 * 更新用户画像工具
 */
const UpdateProfileTool: Tool = {
  name: "UpdateProfile",
  description: "更新用户画像信息。当用户告诉你他们的信息时（如名字、公司、偏好等），使用此工具保存。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "用户名字" },
      email: { type: "string", description: "邮箱" },
      company: { type: "string", description: "公司" },
      role: { type: "string", description: "职位" },
      bio: { type: "string", description: "个人简介" },
      preference: { type: "string", description: "偏好设置，格式: key:value" },
    },
  },
};

/**
 * 子智能体工具
 */
const SubAgentTool: Tool = {
  name: "SubAgent",
  description: "启动子智能体执行后台任务。子智能体在独立会话中运行，完成后向主会话报告结果。用于并行化耗时任务。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "子智能体需要完成的任务描述" },
      label: { type: "string", description: "可选的标签，用于识别子任务" },
      runTimeoutSeconds: { type: "number", description: "超时时间（秒），默认无超时" },
    },
    required: ["task"],
  },
};

export const TOOLS: Tool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, GetProfileTool, UpdateProfileTool, SubAgentTool];

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
      case "WebFetch":
        return executeWebFetch(args.url, args.format);
      case "WebSearch":
        return executeWebSearch(args.query, args.numResults);
      case "GetProfile":
        return executeGetProfile(args.sessionId);
      case "UpdateProfile":
        return executeUpdateProfile(args.sessionId, args);
      case "SubAgent":
        return executeSubAgent(args.task, args.label, args.runTimeoutSeconds);
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
 * 执行网页抓取
 */
async function executeWebFetch(url: string, format?: string): Promise<ToolResult> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    
    const response = await fetch(jinaUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/markdown, text/plain, */*",
      },
      signal: AbortSignal.timeout(60000),
    });
    
    if (!response.ok) {
      return { tool: "WebFetch", output: "", error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    let content = await response.text();
    
    if (content.includes("404") || content.includes("Not Found") || content.includes("blocked")) {
      return { 
        tool: "WebFetch", 
        output: "", 
        error: "无法获取该网页内容。可能原因：1. 网页需要登录权限 2. 网页禁止访问 3. URL无效" 
      };
    }
    
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : undefined;
    
    if (title && content.startsWith(`# ${title}`)) {
      content = content.replace(/^#\s+.+$/m, "").trim();
    }
    
    const maxChars = 30000;
    const truncated = content.length > maxChars 
      ? content.substring(0, maxChars) + "\n\n[内容过长，已截断...]" 
      : content;
    
    const result = title 
      ? `标题: ${title}\n\n${truncated}`
      : truncated;
    
    return { tool: "WebFetch", output: `URL: ${url}\n\n${result}` };
  } catch (error: any) {
    if (error.name === "AbortError") {
      return { tool: "WebFetch", output: "", error: "获取页面超时，请稍后重试" };
    }
    return { tool: "WebFetch", output: "", error: error.message };
  }
}

/**
 * 执行互联网搜索 (使用 Tavily)
 */
async function executeWebSearch(query: string, numResults?: number): Promise<ToolResult> {
  const limit = numResults || 5;
  const apiKey = process.env.TAVILY_API_KEY;
  
  if (!apiKey) {
    return { 
      tool: "WebSearch", 
      output: "", 
      error: "Tavily API key 未配置。请在 .env 中设置 TAVILY_API_KEY" 
    };
  }
  
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { 
        tool: "WebSearch", 
        output: "", 
        error: `Tavily API 错误: ${response.status} - ${errorText}` 
      };
    }
    
    const data = await response.json() as {
      results: Array<{title: string; url: string; content: string; score: number}>;
      answer?: string;
    };
    
    if (!data.results || data.results.length === 0) {
      return { tool: "WebSearch", output: `未找到"${query}"的相关结果` };
    }
    
    let output = "";
    
    if (data.answer) {
      output += `摘要: ${data.answer}\n\n`;
    }
    
    output += "搜索结果:\n";
    const results = data.results.slice(0, limit).map((item, i) => {
      const content = item.content?.substring(0, 200) || "";
      return `${i + 1}. ${item.title}\n   ${content}${content.length === 200 ? "..." : ""}\n   URL: ${item.url}`;
    }).join("\n\n");
    
    output += results;
    
    return { tool: "WebSearch", output };
  } catch (error: any) {
    if (error.name === "AbortError") {
      return { tool: "WebSearch", output: "", error: "搜索超时，请稍后重试" };
    }
    return { tool: "WebSearch", output: "", error: error.message };
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

/**
 * 执行获取用户画像
 */
function executeGetProfile(sessionId?: string): ToolResult {
  const sid = sessionId || "default";
  const profile = userProfileStore.get(sid);
  
  if (!profile) {
    return { tool: "GetProfile", output: "暂无用户信息" };
  }
  
  const markdown = userProfileStore.toMarkdown(profile);
  return { tool: "GetProfile", output: markdown };
}

/**
 * 执行更新用户画像
 */
function executeUpdateProfile(sessionId: string | undefined, args: Record<string, any>): ToolResult {
  const sid = sessionId || "default";
  
  const updates: any = {};
  
  if (args.name) updates.name = args.name;
  if (args.email) updates.email = args.email;
  if (args.company) updates.company = args.company;
  if (args.role) updates.role = args.role;
  if (args.bio) updates.bio = args.bio;
  
  const profile = userProfileStore.update(sid, updates);
  
  if (args.preference && profile) {
    const [key, value] = args.preference.split(":");
    if (key && value) {
      userProfileStore.appendPreference(sid, key.trim(), value.trim());
    }
  }
  
  const updated = userProfileStore.get(sid);
  const markdown = userProfileStore.toMarkdown(updated!);
  
  return { tool: "UpdateProfile", output: "用户画像已更新:\n\n" + markdown };
}

/**
 * 执行子智能体
 */
async function executeSubAgent(task: string, label?: string, runTimeoutSeconds?: number): Promise<ToolResult> {
  const { subAgentSystem } = await import("../subagents/index.js");
  
  try {
    const result = await subAgentSystem.spawn({
      task,
      label,
      runTimeoutSeconds,
      mode: "run",
      cleanup: "keep",
    }, "main");
    
    return {
      tool: "SubAgent",
      output: `子智能体已启动\n\n- Run ID: ${result.runId}\n- Session: ${result.childSessionKey}\n- 任务: ${task.substring(0, 100)}${task.length > 100 ? "..." : ""}\n\n子智能体将在后台执行，完成后向主会话报告结果。`,
    };
  } catch (error) {
    return {
      tool: "SubAgent",
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
