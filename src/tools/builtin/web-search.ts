/**
 * @module web-search
 * @description 网络搜索工具。
 *
 * 使用搜索引擎搜索互联网信息，返回相关网页的标题、URL 和摘要。
 * 当前使用 DuckDuckGo 作为默认搜索提供者，采用策略模式支持
 * 多搜索引擎切换。适合查询实时信息、技术文档、问题解答等。
 */
import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

/**
 * 网络搜索工具的输入参数 Schema。
 *
 * 使用 Zod 定义输入校验规则：
 * - query: 搜索关键词，用自然语言描述要查找的信息
 * - maxResults: 最大返回结果数，范围 1-20，默认 5
 */
const WebSearchInput: ZodType<{
  query: string;
  maxResults?: number;
}> = z.object({
  query: z.string().describe("搜索关键词，用自然语言描述要查找的信息"),
  maxResults: z.number().int().min(1).max(20).default(5).describe("返回的最大结果数"),
});

/**
 * 单个搜索结果的接口。
 *
 * @property title - 搜索结果页面标题
 * @property url - 搜索结果页面 URL
 * @property snippet - 搜索结果摘要文本
 */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 网络搜索工具的输出结果接口。
 *
 * @property query - 执行的搜索关键词
 * @property provider - 使用的搜索提供者名称
 * @property resultCount - 返回的结果数量
 * @property results - 搜索结果列表
 */
interface WebSearchOutput {
  query: string;
  provider: string;
  resultCount: number;
  results: SearchResult[];
}

/**
 * 搜索提供者接口。
 *
 * 定义搜索引擎适配器的统一接口，支持策略模式的多引擎切换。
 *
 * @property name - 搜索提供者名称标识
 */
interface SearchProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

/**
 * DuckDuckGo 搜索提供者实现。
 *
 * 通过解析 DuckDuckGo HTML 搜索页面提取搜索结果。
 * 使用正则表达式从 HTML 中提取标题、URL 和摘要信息。
 */
class DuckDuckGoProvider implements SearchProvider {
  /** 搜索提供者名称标识 */
  name = "duckduckgo";

  /**
   * 检查该搜索提供者是否可用。
   *
   * DuckDuckGo 始终返回 true，作为默认可用的搜索引擎。
   *
   * @returns 始终返回 true
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * 执行 DuckDuckGo 搜索。
   *
   * 通过请求 DuckDuckGo 的 HTML 版本页面，使用正则表达式
   * 从返回的 HTML 中提取搜索结果的标题、URL 和摘要。
   *
   * @param query - 搜索关键词
   * @param maxResults - 最大返回结果数
   * @returns 搜索结果列表
   * @throws 当 DuckDuckGo 请求失败时抛出错误
   */
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FlashClaw/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo request failed: ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];
    
    const titleRegex = /<a class="result__a" href="[^"]*"[^>]*>([^<]+)<\/a>/g;
    const urlRegex = /<a class="result__a"[^>]*href="([^"]*)"/g;
    const snippetRegex = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/g;

    const titles = [...html.matchAll(titleRegex)].map(m => m[1] ?? "");
    const urls = [...html.matchAll(urlRegex)].map(m => decodeURIComponent((m[1] ?? "").replace(/\\x/g, "%")));
    const snippets = [...html.matchAll(snippetRegex)].map(m => m[1] ?? "");

    for (let i = 0; i < Math.min(maxResults, titles.length); i++) {
      results.push({
        title: titles[i]?.trim() || "",
        url: urls[i] || "",
        snippet: snippets[i]?.trim() || "",
      });
    }

    return results;
  }
}

/**
 * 网络搜索工具定义。
 *
 * 使用搜索引擎查询互联网信息，当前默认使用 DuckDuckGo。
 * 无需用户审批即可执行（只读操作）。
 *
 * @example
 * // 搜索技术教程
 * { query: "TypeScript Zod schema validation tutorial", maxResults: 5 }
 *
 * @example
 * // 搜索最佳实践
 * { query: "Docker container security best practices 2026" }
 */
export const webSearchTool: FlashClawToolDefinition<typeof WebSearchInput, WebSearchOutput> = {
  name: "web_search",
  description:
    "使用搜索引擎搜索互联网信息。返回相关网页的标题、URL 和摘要。" +
    "适合查询实时信息、技术文档、问题解答等。",
  inputSchema: WebSearchInput,
  permissionLevel: "read",
  category: "web",
  requiresSandbox: false,
  timeoutMs: 15_000,
  needsApproval: false,
  strict: true,
  inputExamples: [
    { input: { query: "TypeScript Zod schema validation tutorial", maxResults: 5 } },
    { input: { query: "Docker container security best practices 2026" } },
  ],
  /**
   * 将输出转换为模型可读的文本格式。
   *
   * 将搜索结果格式化为 Markdown 链接列表。
   *
   * @param output - 搜索的原始输出
   * @returns 格式化后的 Markdown 文本
   */
  toModelOutput: (output: WebSearchOutput): string => {
    if (output.results.length === 0) {
      return `No results found for "${output.query}"`;
    }
    return output.results.map(r => `- [${r.title}](${r.url}): ${r.snippet}`).join("\n");
  },
  /**
   * 执行网络搜索。
   *
   * 遍历可用的搜索提供者，使用第一个可用的提供者执行搜索。
   *
   * @param input - 输入参数，包含搜索关键词和最大结果数
   * @param _context - 工具执行上下文（本工具未使用）
   * @returns 包含搜索结果列表和元信息的对象
   * @throws 当所有搜索提供者均不可用时抛出错误
   */
  execute: async (input: { query: string; maxResults?: number }, _context: ToolExecutionContext): Promise<WebSearchOutput> => {
    const providers: SearchProvider[] = [
      new DuckDuckGoProvider(),
    ];

    for (const provider of providers) {
      if (await provider.isAvailable()) {
        try {
          const results = await provider.search(input.query, input.maxResults || 5);
          return {
            query: input.query,
            provider: provider.name,
            resultCount: results.length,
            results,
          };
        } catch {
          continue;
        }
      }
    }

    throw new Error(
      "No search provider available. " +
      "Configure at least one: SearXNG instance, Bing API key, or DuckDuckGo fallback."
    );
  },
};
