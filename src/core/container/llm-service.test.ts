import { describe, test, expect, beforeAll } from "bun:test";
import { createLLMService } from "./llm-service";

describe("LLMService (Vercel AI SDK)", () => {
  let llmService: ReturnType<typeof createLLMService>;

  beforeAll(() => {
    llmService = createLLMService();
  });

  test("should create LLM service instance", () => {
    expect(llmService).toBeDefined();
    expect(llmService.generateText).toBeDefined();
    expect(llmService.streamText).toBeDefined();
    expect(llmService.generateObject).toBeDefined();
  });

  test("should generate text", async () => {
    const result = await llmService.generateText("Say 'hello' in one word");
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  }, 30000);

  test("should stream text", async () => {
    const chunks: string[] = [];
    for await (const chunk of llmService.streamText("Say 'hello'")) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("").toLowerCase()).toContain("hello");
  }, 30000);
});
