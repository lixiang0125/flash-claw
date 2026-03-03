import { describe, test, expect, beforeAll } from "bun:test";
import { ToolRegistry } from "./tool-registry";
import { SessionManager } from "./session-manager";
import { AgentCoreImpl } from "./agent-core";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeAll(() => {
    registry = new ToolRegistry();
  });

  test("should register and get tool", () => {
    registry.register({
      definition: {
        name: "testTool",
        description: "A test tool",
        parameters: { type: "object" },
      },
      execute: async (args) => ({
        toolCallId: "test",
        result: args.message,
      }),
    });

    const tool = registry.get("testTool");
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe("testTool");
  });

  test("should list all tools", () => {
    const tools = registry.getAll();
    expect(tools.length).toBeGreaterThan(0);
  });

  test("should execute tool", async () => {
    const result = await registry.executeTool({
      name: "testTool",
      args: { message: "hello" },
    });

    expect(result.result).toBe("hello");
  });

  test("should return error for unknown tool", async () => {
    const result = await registry.executeTool({
      name: "unknown",
      args: {},
    });

    expect(result.error).toContain("not found");
  });
});

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeAll(() => {
    manager = new SessionManager();
  });

  test("should create session", () => {
    const session = manager.create("test-session");
    expect(session.id).toBe("test-session");
    expect(session.messages).toEqual([]);
  });

  test("should get or create session", () => {
    const session = manager.getOrCreate("test-session-2");
    expect(session.id).toBe("test-session-2");
  });

  test("should add message", () => {
    manager.addMessage("test-session", {
      role: "user",
      content: "Hello",
    });

    const messages = manager.getMessages("test-session");
    expect(messages.length).toBe(1);
    const firstMessage = messages[0];
    expect(firstMessage?.content).toBe("Hello");
  });

  test("should clear session", () => {
    manager.clear("test-session");
    const messages = manager.getMessages("test-session");
    expect(messages.length).toBe(0);
  });
});

describe("AgentCore", () => {
  test.skip("should run agent", async () => {
    // Skip for now - needs more work on LangChain tool calling
  }, 30000);
});
