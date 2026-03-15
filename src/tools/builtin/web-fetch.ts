/**
 * @module web-fetch
 * @description 网页内容获取工具。
 *
 * 获取指定 URL 的网页内容，自动将 HTML 转换为 Markdown 格式。
 * 支持使用 Readability 提取主体内容，可选使用 Playwright 渲染
 * JavaScript 动态页面。内置 SSRF 防护和响应缓存机制。
 * 适合阅读文档页面、博客文章、API 文档等。
 */
import { z, ZodType } from "zod";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types";
import { defaultSSRFProtection } from "../../infra/net/ssrf.js";

/** 默认最大内容长度：150000 字符 */
const MAX_CONTENT_LENGTH = 150_000;

/**
 * 网页获取工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - url: 要获取的目标 URL
 * - extractMainContent: 是否使用 Readability 提取主要内容，默认 true
 * - maxLength: 最大返回字符数，范围 1000-200000，默认 150000
 * - usePlaywright: 是否使用 Playwright 渲染 JS 动态页面，默认 false
 */
const WebFetchInput: ZodType<{
  url: string;
  extractMainContent?: boolean;
  maxLength?: number;
  usePlaywright?: boolean;
}> = z.object({
  url: z.string().url().describe("要获取的 URL"),
  extractMainContent: z.boolean().default(true).describe("是否提取主要内容"),
  maxLength: z.number().int().min(1000).max(200_000).default(150_000).describe("最大字符数"),
  usePlaywright: z.boolean().default(false).describe("是否使用 Playwright 渲染 JS (对 SPA 有效)"),
});

/**
 * 网页获取工具的输出结果接口。
 *
 * @property success - 请求是否成功
 * @property url - 请求的 URL
 * @property status - HTTP 响应状态码
 * @property title - 页面标题
 * @property content - 提取/转换后的页面内容
 * @property contentLength - 内容的字符长度
 * @property error - 错误信息（失败时）
 * @property usedPlaywright - 是否使用了 Playwright 渲染
 */
interface WebFetchOutput {
  success: boolean;
  url: string;
  status?: number;
  title?: string;
  content?: string;
  contentLength?: number;
  error?: string;
  usedPlaywright?: boolean;
}

/** 请求结果缓存，key 为 URL，value 包含内容和时间戳 */
const fetchCache = new Map<string, { content: string; timestamp: number }>();
/** 缓存过期时间：5 分钟 */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * 使用 Playwright 无头浏览器获取页面内容。
 *
 * 启动 Chromium 浏览器渲染页面，等待网络请求完成后提取内容。
 * 适用于需要 JavaScript 渲染的单页应用（SPA）。
 *
 * @param url - 要获取的页面 URL
 * @param timeout - 页面加载超时时间（毫秒），默认 30000
 * @returns 包含页面 HTML 内容和标题的对象
 */
async function fetchWithPlaywright(url: string, timeout = 30000): Promise<{ content: string; title: string }> {
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout });

    const title = await page.title();
    const content = await page.content();

    return { content, title };
  } finally {
    await browser.close();
  }
}

/**
 * 将 HTML 内容转换为 Markdown 格式。
 *
 * 递归遍历 DOM 节点，将常见 HTML 标签转换为对应的 Markdown 语法。
 * 支持标题、段落、列表、引用、代码块、链接、加粗、斜体等。
 *
 * @param html - 原始 HTML 字符串
 * @returns 转换后的 Markdown 文本
 */
function htmlToMarkdown(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const { Node } = dom.window;
  let md = "";

  const getText = (el: globalThis.Element): string => {
    return el.textContent?.trim().replace(/\s+/g, " ") || "";
  };

  const processNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim() || "";
      if (text) md += text;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as globalThis.Element;
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case "h1": md += `\n# ${getText(el)}\n`; break;
      case "h2": md += `\n## ${getText(el)}\n`; break;
      case "h3": md += `\n### ${getText(el)}\n`; break;
      case "h4": md += `\n#### ${getText(el)}\n`; break;
      case "h5": md += `\n##### ${getText(el)}\n`; break;
      case "h6": md += `\n###### ${getText(el)}\n`; break;
      case "p": md += `\n${getText(el)}\n`; break;
      case "br": md += "\n"; break;
      case "hr": md += "\n---\n"; break;
      case "li": md += `- ${getText(el)}\n`; break;
      case "blockquote": md += `\n> ${getText(el)}\n`; break;
      case "pre": {
        const codeEl = el.querySelector("code");
        const code = codeEl ? getText(codeEl) : getText(el);
        md += `\n\`\`\`\n${code}\n\`\`\`\n`;
        break;
      }
      case "code": md += `\`${getText(el)}\``; break;
      case "a": md += `[${getText(el)}](${el.getAttribute("href") || ""})`; break;
      case "strong": md += `**${getText(el)}**`; break;
      case "em": md += `*${getText(el)}*`; break;
      default: {
        const children = Array.from(el.childNodes);
        children.forEach(processNode);
      }
    }
  };

  const body = doc.body;
  if (body) {
    Array.from(body.childNodes).forEach(processNode);
  }
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 网页获取工具定义。
 *
 * 抓取网页内容并转换为 Markdown，支持主体内容提取和 Playwright 渲染。
 * 内置 SSRF 防护和 5 分钟响应缓存。
 * 无需用户审批即可执行。
 *
 * @example
 * // 获取文档页面
 * { url: "https://docs.python.org/3/tutorial/classes.html", maxLength: 100000 }
 */
export const webFetchTool: FlashClawToolDefinition<typeof WebFetchInput, WebFetchOutput> = {
  name: "web_fetch",
  description:
    "获取指定 URL 的网页内容，自动将 HTML 转换为 Markdown 格式，提取主体内容。" +
    "适合阅读文档页面、博客文章、API 文档、公众号文章等。",
  inputSchema: WebFetchInput,
  permissionLevel: "read",
  category: "web",
  requiresSandbox: false,
  timeoutMs: 60_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { url: "https://docs.python.org/3/tutorial/classes.html", maxLength: 100000 } },
  ],
  /**
   * 将输出转换为模型可读的文本格式。
   *
   * 成功时返回内容文本，失败时返回错误信息。
   *
   * @param output - 网页获取的原始输出
   * @returns 格式化后的文本字符串
   */
  toModelOutput: (output: WebFetchOutput): string => {
    if (!output.success) {
      return `Error: ${output.error}`;
    }
    return output.content || `No content extracted from ${output.url}`;
  },
  /**
   * 执行网页内容获取。
   *
   * 流程：SSRF 检查 -> 缓存查找 -> 发起请求 -> 内容提取 -> 格式转换。
   *
   * @param input - 输入参数，包含 URL 和各种获取选项
   * @param _context - 工具执行上下文（本工具未使用）
   * @returns 包含页面内容和元信息的结果对象
   */
  execute: async (input: { url: string; extractMainContent?: boolean; maxLength?: number; usePlaywright?: boolean }, _context: ToolExecutionContext): Promise<WebFetchOutput> => {
    const ssrfCheck = await defaultSSRFProtection.checkWithDNS(input.url);
    if (!ssrfCheck.allowed) {
      return {
        success: false,
        url: input.url,
        error: `SSRF protection: ${ssrfCheck.reason}`,
      };
    }

    const cacheKey = input.url;
    const cached = fetchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return {
        success: true,
        url: input.url,
        content: cached.content,
        contentLength: cached.content.length,
      };
    }

    try {
      if (input.usePlaywright) {
        const { content, title } = await fetchWithPlaywright(input.url, 30000);
        let markdown = htmlToMarkdown(content);

        if (input.extractMainContent) {
          const dom = new JSDOM(content, { url: input.url });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();
          markdown = htmlToMarkdown(article?.content || content);
        }

        if (markdown.length > (input.maxLength || MAX_CONTENT_LENGTH)) {
          markdown = markdown.substring(0, input.maxLength || MAX_CONTENT_LENGTH) +
            `\n\n[Content truncated at ${input.maxLength || MAX_CONTENT_LENGTH} characters]`;
        }

        fetchCache.set(cacheKey, { content: markdown, timestamp: Date.now() });

        return {
          success: true,
          url: input.url,
          title,
          content: markdown,
          contentLength: markdown.length,
          usedPlaywright: true,
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(input.url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        },
        redirect: "manual",
      });
      clearTimeout(timeout);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          const redirectUrl = new URL(location, input.url).toString();
          const redirectCheck = await defaultSSRFProtection.checkWithDNS(redirectUrl);
          if (!redirectCheck.allowed) {
            return {
              success: false,
              url: input.url,
              error: `SSRF protection (redirect): ${redirectCheck.reason}`,
            };
          }
        }
      }

      if (!response.ok) {
        return {
          success: false,
          url: input.url,
          status: response.status,
          error: `HTTP ${response.status} ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      const rawHtml = await response.text();

      let content: string;
      let title: string | undefined;

      if (contentType.includes("text/html") || contentType.includes("xhtml")) {
        const dom = new JSDOM(rawHtml, { url: input.url });
        if (input.extractMainContent) {
          const reader = new Readability(dom.window.document);
          const article = reader.parse();
          title = article?.title ?? undefined;
          content = htmlToMarkdown(article?.content || "");
        } else {
          title = dom.window.document.title ?? undefined;
          content = htmlToMarkdown(rawHtml);
        }
      } else if (contentType.includes("application/json")) {
        const json = JSON.parse(rawHtml);
        content = JSON.stringify(json, null, 2);
      } else {
        content = rawHtml;
      }

      if (content.length > (input.maxLength || MAX_CONTENT_LENGTH)) {
        content = content.substring(0, input.maxLength || MAX_CONTENT_LENGTH) +
          `\n\n[Content truncated at ${input.maxLength || MAX_CONTENT_LENGTH} characters]`;
      }

      console.log(`[web_fetch] URL: ${input.url}, rawHTML: ${rawHtml.length}, content: ${content.length}`);

      fetchCache.set(cacheKey, { content, timestamp: Date.now() });

      return {
        success: true,
        url: input.url,
        status: response.status,
        title,
        content,
        contentLength: content.length,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          url: input.url,
          error: "Request timeout",
        };
      }

      if (input.usePlaywright) {
        return {
          success: false,
          url: input.url,
          error: `Playwright failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }

      return {
        success: false,
        url: input.url,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
};
