export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface LLMService {
  generateText(prompt: string, options?: LLMOptions): Promise<string>;
}

export function createLLMService(): LLMService {
  return {
    async generateText(prompt: string, options?: LLMOptions): Promise<string> {
      return prompt;
    },
  };
}
