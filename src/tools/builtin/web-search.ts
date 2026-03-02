import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types.js";

const WebSearchInput: ZodType<{
  query: string;
  maxResults?: number;
}> = z.object({
  query: z.string().describe("搜索关键词，用自然语言描述要查找的信息"),
  maxResults: z.number().int().min(1).max(20).default(5).describe("返回的最大结果数"),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchOutput {
  query: string;
  provider: string;
  resultCount: number;
  results: SearchResult[];
}

interface SearchProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

class DuckDuckGoProvider implements SearchProvider {
  name = "duckduckgo";

  async isAvailable(): Promise<boolean> {
    return true;
  }

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
