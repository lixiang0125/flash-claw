import { describe, test, expect, beforeAll } from "bun:test";
import { createLLMService } from "./llm-service";

describe("LLMService", () => {
  let llmService: ReturnType<typeof createLLMService>;

  beforeAll(() => {
    llmService = createLLMService();
  });

  test("should create LLM service instance", () => {
    expect(llmService).toBeDefined();
    expect(llmService.generateText).toBeDefined();
  });
});
