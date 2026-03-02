import { z, ZodType } from "zod";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { FlashClawToolDefinition, ToolExecutionContext } from "./types.js";

const MAX_CONTENT_LENGTH = 80_000;

const WebFetchInput: ZodType<{
  url: string;
  extractMainContent?: boolean;
  maxLength?: number;
}> = z.object({
  url: z.string().url().describe("要获取的 URL"),
  extractMainContent: z.boolean().default(true).describe("是否提取主要内容"),
  maxLength: z.number().int().min(1000).max(200_000).default(80_000).describe("最大字符数"),
});

interface WebFetchOutput {
  success: boolean;
  url: string;
  status?: number;
  title?: string;
  content?: string;
  contentLength?: number;
  error?: string;
}

export const webFetchTool: FlashClawToolDefinition<typeof WebFetchInput, WebFetchOutput> = {
  name: "web_fetch",
  description:
    "获取指定 URL 的网页内容，自动将 HTML 转换为 Markdown 格式，提取主体内容。" +
    "适合阅读文档页面、博客文章、API 文档等。",
  inputSchema: WebFetchInput,
  permissionLevel: "read",
  category: "web",
  requiresSandbox: false,
  timeoutMs: 30_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { url: "https://docs.python.org/3/tutorial/classes.html" } },
  ],
  execute: async (input: { url: string; extractMainContent?: boolean; maxLength?: number }, _context: ToolExecutionContext): Promise<WebFetchOutput> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(input.url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "FlashClaw/0.1.0 (Personal AI Agent)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });
      clearTimeout(timeout);

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
          title = article?.title;
          content = article?.content || "";
          content = htmlToMarkdown(content);
        } else {
          title = dom.window.document.title;
          content = htmlToMarkdown(rawHtml);
        }
      } else if (contentType.includes("application/json")) {
        content = JSON.stringify(JSON.parse(rawHtml), null, 2);
      } else {
        content = rawHtml;
      }

      if (content.length > (input.maxLength || MAX_CONTENT_LENGTH)) {
        content = content.substring(0, input.maxLength || MAX_CONTENT_LENGTH) +
          `\n\n[Content truncated at ${input.maxLength || MAX_CONTENT_LENGTH} characters]`;
      }

      return {
        success: true,
        url: input.url,
        status: response.status,
        title,
        content,
        contentLength: content.length,
      };
    } catch (error) {
      return {
        success: false,
        url: input.url,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
};

function htmlToMarkdown(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  let md = "";

  const processNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      md += node.textContent?.trim() || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case "h1": md += `\n# ${getText(el)}\n`; break;
      case "h2": md += `\n## ${getText(el)}\n`; break;
      case "h3": md += `\n### ${getText(el)}\n`; break;
      case "p": md += `\n${getText(el)}\n`; break;
      case "li": md += `- ${getText(el)}\n`; break;
      case "code": md += `\`${getText(el)}\``; break;
      case "pre": md += `\n\`\`\`\n${getText(el)}\n\`\`\`\n`; break;
      case "a": md += `[${getText(el)}](${el.getAttribute("href")})`; break;
      case "br": md += "\n"; break;
      default: Array.from(el.childNodes).forEach(processNode);
    }
  };

  Array.from(doc.body.childNodes).forEach(processNode);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

function getText(el: Element): string {
  return el.textContent?.trim() || "";
}
