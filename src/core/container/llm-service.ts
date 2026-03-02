import { ChatOpenAI } from "@langchain/openai";
import type { LLMService, LLMOptions } from "./tokens";

export function createLLMService(): LLMService {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.MODEL || "gpt-4o";

  const llm = new ChatOpenAI({
    model,
    temperature: 0.7,
    baseURL,
    apiKey,
  });

  return {
    async generateText(prompt: string, options?: LLMOptions): Promise<string> {
      const result = await llm.invoke(prompt, {
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens,
      });

      return result.content;
    },

    async *streamText(prompt: string, options?: LLMOptions): AsyncIterable<string> {
      const stream = await llm.stream(prompt, {
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens,
      });

      for await (const chunk of stream) {
        yield chunk.content;
      }
    },

    async generateObject<T>(
      prompt: string,
      _schema: unknown,
      options?: LLMOptions,
    ): Promise<T> {
      const result = await llm.invoke(prompt, {
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens,
      });

      try {
        return JSON.parse(result.content);
      } catch {
        return result.content as T;
      }
    },
  };
}
