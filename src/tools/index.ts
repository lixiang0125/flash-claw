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

export const TOOLS: Tool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, WebFetchTool, GetProfileTool, UpdateProfileTool];

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
      case "GetProfile":
        return executeGetProfile(args.sessionId);
      case "UpdateProfile":
        return executeUpdateProfile(args.sessionId, args);
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
  const extractMode = format || "markdown";
  
  try {
    // 先尝试简单 fetch
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    
    if (!response.ok) {
      return { tool: "WebFetch", output: "", error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    const contentType = response.headers.get("content-type") || "";
    const html = await response.text();
    
    let text: string;
    let title: string | undefined;
    
    if (contentType.includes("application/json")) {
      try {
        const json = JSON.parse(html);
        text = JSON.stringify(json, null, 2);
      } catch {
        text = html;
      }
    } else {
      // 使用 Readability 提取可读内容
      try {
        const { JSDOM } = require("jsdom");
        const { Readability } = require("@mozilla/readability");
        
        const dom = new JSDOM(html, { url });
        const document = dom.window.document;
        const reader = new Readability(document);
        const article = reader.parse();
        
        if (article) {
          title = article.title;
          text = extractMode === "text" ? article.textContent : article.content;
        } else {
          text = simpleHtmlToText(html);
        }
      } catch (e) {
        text = simpleHtmlToText(html);
      }
    }
    
    // 如果内容太短，尝试使用 Playwright 渲染
    if (text.length < 500) {
      console.log(`WebFetch: Content too short (${text.length} chars), trying Playwright...`);
      try {
        const playwrightResult = await fetchWithPlaywright(url, extractMode);
        if (playwrightResult.text.length > text.length) {
          text = playwrightResult.text;
          title = title || playwrightResult.title;
        }
      } catch (e) {
        console.error("WebFetch: Playwright failed:", e);
      }
    }
    
    // 截断内容
    const maxChars = 30000;
    const truncated = text.length > maxChars 
      ? text.substring(0, maxChars) + "\n\n[内容过长，已截断...]" 
      : text;
    
    const result = title 
      ? `标题: ${title}\n\n${truncated}`
      : truncated;
    
    return { tool: "WebFetch", output: `URL: ${url}\n\n${result}` };
  } catch (error: any) {
    return { tool: "WebFetch", output: "", error: error.message };
  }
}

/**
 * 使用 Playwright 渲染页面并提取内容
 */
async function fetchWithPlaywright(url: string, extractMode: string): Promise<{ text: string; title?: string }> {
  const { chromium } = require("playwright");
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  
  try {
    const page = await browser.newPage();
    
    // 设置视口
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // 访问页面
    await page.goto(url, { 
      waitUntil: "networkidle",
      timeout: 30000 
    });
    
    // 等待内容加载
    await page.waitForTimeout(2000);
    
    // 获取标题
    const title = await page.title();
    
    // 尝试获取主要内容
    let content = "";
    
    // 方法1: 尝试获取 article 或 main 标签
    const articleContent = await page.$eval("article, main, .article, #article", el => el.innerText).catch(() => null);
    
    if (articleContent) {
      content = articleContent;
    } else {
      // 方法2: 获取 body 文本并清理
      content = await page.evaluate(() => {
        const body = document.body;
        // 移除脚本和样式
        const scripts = body.querySelectorAll("script, style, nav, footer, header, aside");
        scripts.forEach(el => el.remove());
        return body.innerText || "";
      });
    }
    
    await browser.close();
    
    return {
      text: extractMode === "text" ? content : content,
      title
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * 简单的 HTML 转文本
 */
function simpleHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    parameters: tool.parameters,
  }));
}
