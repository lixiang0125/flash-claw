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
 * 飞书文档工具
 */
const FeishuDocTool: Tool = {
  name: "FeishuDoc",
  description: "飞书文档读写操作。支持读取、写入、创建文档，以及操作表格、图片等。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "操作: read, write, append, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, upload_image, upload_file" },
      doc_token: { type: "string", description: "文档 token" },
      content: { type: "string", description: "文档内容 (write/append)" },
      title: { type: "string", description: "文档标题 (create)" },
      folder_token: { type: "string", description: "文件夹 token" },
      owner_open_id: { type: "string", description: "所有者 open_id" },
      block_id: { type: "string", description: "Block ID" },
      row_size: { type: "number", description: "表格行数" },
      column_size: { type: "number", description: "表格列数" },
      column_width: { type: "array", description: "列宽" },
      table_block_id: { type: "string", description: "表格 block ID" },
      values: { type: "array", description: "表格值" },
      url: { type: "string", description: "图片/文件 URL" },
      file_path: { type: "string", description: "本地文件路径" },
      filename: { type: "string", description: "文件名" },
      parent_block_id: { type: "string", description: "父 Block ID" },
      index: { type: "number", description: "位置索引" },
    },
    required: ["action"],
  },
};

/**
 * 飞书云盘工具
 */
const FeishuDriveTool: Tool = {
  name: "FeishuDrive",
  description: "飞书云盘文件管理。支持列出文件夹、获取文件信息、创建文件夹、移动/删除文件。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "操作: list, info, create_folder, move, delete" },
      folder_token: { type: "string", description: "文件夹 token" },
      file_token: { type: "string", description: "文件 token" },
      name: { type: "string", description: "名称" },
      type: { type: "string", description: "文件类型: doc, docx, sheet, bitable, folder, file, mindnote, shortcut" },
    },
    required: ["action"],
  },
};

/**
 * 飞书权限工具
 */
const FeishuPermTool: Tool = {
  name: "FeishuPerm",
  description: "飞书文档权限管理。列出、添加、移除协作者。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "操作: list, add, remove" },
      token: { type: "string", description: "文档/文件 token" },
      type: { type: "string", description: "类型: doc, docx, sheet, bitable, folder, file, wiki, mindnote" },
      member_type: { type: "string", description: "成员类型: email, openid, userid, unionid, openchat, opendepartmentid" },
      member_id: { type: "string", description: "成员 ID" },
      perm: { type: "string", description: "权限: view, edit, full_access" },
    },
    required: ["action", "token", "type"],
  },
};

/**
 * 飞书 Wiki 工具
 */
const FeishuWikiTool: Tool = {
  name: "FeishuWiki",
  description: "飞书知识库操作。列出知识空间、节点，获取/创建/移动/重命名 Wiki 页面。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "操作: spaces, nodes, get, create, move, rename" },
      space_id: { type: "string", description: "知识空间 ID" },
      token: { type: "string", description: "Wiki token" },
      parent_node_token: { type: "string", description: "父节点 token" },
      title: { type: "string", description: "标题" },
      obj_type: { type: "string", description: "对象类型: docx, sheet, bitable, mindnote, file, doc, slides" },
      target_space_id: { type: "string", description: "目标空间 ID" },
      target_parent_token: { type: "string", description: "目标父节点 token" },
    },
    required: ["action"],
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

export const TOOLS: Tool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, FeishuDocTool, FeishuDriveTool, FeishuPermTool, FeishuWikiTool, GetProfileTool, UpdateProfileTool, SubAgentTool];

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
      case "FeishuDoc":
        return executeFeishuDoc(args);
      case "FeishuDrive":
        return executeFeishuDrive(args);
      case "FeishuPerm":
        return executeFeishuPerm(args);
      case "FeishuWiki":
        return executeFeishuWiki(args);
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
      return { 
        tool: "WebFetch", 
        output: "", 
        error: `获取失败: ${response.status}` 
      };
    }
    
    let content = await response.text();
    
    // 清洗 Jina 返回的内容
    content = content.replace(/^.*?=== Start of Content ===\n?/, '');
    content = content.replace(/\n?=== End of Content ===.*?$/, '');
    content = content.replace(/^.*?We couldn't extract content from this URL.*$/gm, '');
    content = content.replace(/^.*?blocked.*$/gi, '');
    content = content.trim();
    
    if (!content || content.length < 50) {
      return { 
        tool: "WebFetch", 
        output: "", 
        error: "无法提取网页内容，可能需要登录或网页禁止访问" 
      };
    }
    
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim();
    
    if (title && content.startsWith(`# ${title}`)) {
      content = content.replace(/^#\s+.+$/m, '').trim();
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
 * 飞书 API 客户端
 */
let feishuClient: any = null;

async function getFeishuClient() {
  if (feishuClient) return feishuClient;
  
  const Lark = require("@larksuiteoapi/node-sdk");
  
  feishuClient = new Lark.Client({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  });
  
  return feishuClient;
}

async function getTenantAccessToken(): Promise<string> {
  const client = await getFeishuClient();
  const response = await client.auth.getTenantAccessToken({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
  });
  
  if (response.code !== 0) {
    throw new Error(`飞书认证失败: ${response.msg}`);
  }
  
  return response.data.tenant_access_token;
}

/**
 * 执行飞书文档操作
 */
async function executeFeishuDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const action = args.action as string;
  
  try {
    const token = await getTenantAccessToken();
    const docToken = args.doc_token as string;
    
    const client = await getFeishuClient();
    let result: any = null;
    
    switch (action) {
      case "read": {
        const response = await client.docx.document.get({
          headers: { Authorization: `Bearer ${token}` },
          documentId: docToken,
        });
        result = response.data;
        break;
      }
      case "write":
      case "append": {
        const content = args.content as string;
        const blocks = [{ type: "markdown", markdown: { text: content } }];
        await client.docx.documentBlock.append({
          headers: { Authorization: `Bearer ${token}` },
          documentId: docToken,
          requestBody: { block: blocks[0] },
        });
        result = { success: true, message: "内容已写入" };
        break;
      }
      case "create": {
        const title = args.title as string;
        const folderToken = args.folder_token as string;
        const ownerOpenId = args.owner_open_id as string;
        
        const response = await client.docx.createDocument({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: {
            folder_token: folderToken,
            title: title,
            owner_open_id: ownerOpenId,
          },
        });
        result = response.data;
        break;
      }
      case "list_blocks": {
        const response = await client.docx.documentBlock.list({
          headers: { Authorization: `Bearer ${token}` },
          documentId: docToken,
        });
        result = response.data;
        break;
      }
      default:
        return { tool: "FeishuDoc", output: "", error: `不支持的操作: ${action}` };
    }
    
    return { tool: "FeishuDoc", output: JSON.stringify(result, null, 2) };
  } catch (error: any) {
    return { tool: "FeishuDoc", output: "", error: error.message || "飞书文档操作失败" };
  }
}

/**
 * 执行飞书云盘操作
 */
async function executeFeishuDrive(args: Record<string, unknown>): Promise<ToolResult> {
  const action = args.action as string;
  
  try {
    const token = await getTenantAccessToken();
    const client = await getFeishuClient();
    let result: any = null;
    
    switch (action) {
      case "list": {
        const folderToken = args.folder_token as string;
        const response = await client.drive.list({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: {
            folder_token: folderToken || "root",
            page_size: 100,
          },
        });
        result = response.data;
        break;
      }
      case "info": {
        const fileToken = args.file_token as string;
        const type = args.type as string;
        const response = await client.drive.getFileInfo({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: { file_token: fileToken },
        });
        result = response.data;
        break;
      }
      case "create_folder": {
        const name = args.name as string;
        const folderToken = args.folder_token as string;
        const response = await client.drive.createFolder({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: {
            name: name,
            folder_token: folderToken || "root",
          },
        });
        result = response.data;
        break;
      }
      default:
        return { tool: "FeishuDrive", output: "", error: `不支持的操作: ${action}` };
    }
    
    return { tool: "FeishuDrive", output: JSON.stringify(result, null, 2) };
  } catch (error: any) {
    return { tool: "FeishuDrive", output: "", error: error.message || "飞书云盘操作失败" };
  }
}

/**
 * 执行飞书权限操作
 */
async function executeFeishuPerm(args: Record<string, unknown>): Promise<ToolResult> {
  const action = args.action as string;
  
  try {
    const token = await getTenantAccessToken();
    const client = await getFeishuClient();
    let result: any = null;
    
    switch (action) {
      case "list": {
        const fileToken = args.token as string;
        const type = args.type as string;
        const response = await client.drive.permissionMember.list({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: { token: fileToken, type: type },
        });
        result = response.data;
        break;
      }
      default:
        return { tool: "FeishuPerm", output: "", error: `不支持的操作: ${action}` };
    }
    
    return { tool: "FeishuPerm", output: JSON.stringify(result, null, 2) };
  } catch (error: any) {
    return { tool: "FeishuPerm", output: "", error: error.message || "飞书权限操作失败" };
  }
}

/**
 * 执行飞书 Wiki 操作
 */
async function executeFeishuWiki(args: Record<string, unknown>): Promise<ToolResult> {
  const action = args.action as string;
  
  try {
    const token = await getTenantAccessToken();
    const client = await getFeishuClient();
    let result: any = null;
    
    switch (action) {
      case "spaces": {
        const response = await client.wiki.listSpaces({
          headers: { Authorization: `Bearer ${token}` },
        });
        result = response.data;
        break;
      }
      case "nodes": {
        const spaceId = args.space_id as string;
        const parentToken = args.parent_node_token as string;
        const response = await client.wiki.listNodes({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: {
            space_id: spaceId,
            parent_node_token: parentToken,
            page_size: 100,
          },
        });
        result = response.data;
        break;
      }
      case "get": {
        const wikiToken = args.token as string;
        const response = await client.wiki.getNode({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: { token: wikiToken },
        });
        result = response.data;
        break;
      }
      case "create": {
        const spaceId = args.space_id as string;
        const title = args.title as string;
        const parentToken = args.parent_node_token as string;
        const objType = args.obj_type as string;
        
        const response = await client.wiki.createNode({
          headers: { Authorization: `Bearer ${token}` },
          requestBody: {
            space_id: spaceId,
            obj_type: objType || "docx",
            parent_node_token: parentToken,
            title: title,
          },
        });
        result = response.data;
        break;
      }
      default:
        return { tool: "FeishuWiki", output: "", error: `不支持的操作: ${action}` };
    }
    
    return { tool: "FeishuWiki", output: JSON.stringify(result, null, 2) };
  } catch (error: any) {
    return { tool: "FeishuWiki", output: "", error: error.message || "飞书 Wiki 操作失败" };
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
