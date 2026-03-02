import { generateText, streamText, generateObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

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

  const openai = createOpenAICompatible({
    name: "dashscope",
    baseURL,
    apiKey,
  });

  return {
    async generateText(prompt: string, options?: LLMOptions): Promise<string> {
      const result = await generateText({
        model: openai(model),
        prompt,
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        system: options?.systemPrompt,
      });

      return result.text;
    },

    async *streamText(prompt: string, options?: LLMOptions): AsyncIterable<string> {
      const result = streamText({
        model: openai(model),
        prompt,
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        system: options?.systemPrompt,
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
        model: openai(model),
        prompt,
        schema: schema as any,
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        system: options?.systemPrompt,
      });

      return result.object as T;
    },
  };
}
