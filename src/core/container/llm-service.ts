import { generateText, streamText, generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface LLMService {
  generateText(prompt: string, options?: LLMOptions): Promise<string>;
  streamText(prompt: string, options?: LLMOptions): AsyncIterable<string>;
  generateObject<T>(prompt: string, schema: unknown, options?: LLMOptions): Promise<T>;
}

export function createLLMService(): LLMService {
  const model = process.env.MODEL || "qwen-plus";
  const baseURL = process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env.OPENAI_API_KEY || "";

  const openai = createOpenAI({
    apiKey,
    baseURL,
  });

  return {
    async generateText(prompt: string, options?: LLMOptions): Promise<string> {
      const result = await generateText({
        model,
        prompt,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        system: options?.systemPrompt,
        provider: openai,
      });

      return result.text;
    },

    async *streamText(prompt: string, options?: LLMOptions): AsyncIterable<string> {
      const result = streamText({
        model,
        prompt,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        system: options?.systemPrompt,
        provider: openai,
      });

      for await (const chunk of result.textStream) {
        yield chunk;
      }
    },

    async generateObject<T>(
      prompt: string,
      schema: unknown,
      options?: LLMOptions,
    ): Promise<T> {
      const result = await generateObject({
        model,
        prompt,
        schema: schema as any,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        system: options?.systemPrompt,
        provider: openai,
      });

      return result.object as T;
    },
  };
}
