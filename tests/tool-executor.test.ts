import { describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import { ToolExecutor } from "../src/tools/tool-executor";
import type { FlashClawToolDefinition } from "../src/tools/types";

function createLogger() {
  return {
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  };
}

function createSandboxManager() {
  return {
    initialize: async () => undefined,
    acquire: async (sessionId: string) => ({
      containerId: `local-${sessionId}`,
      workDir: process.cwd(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "idle" as const,
      sessionId,
    }),
    release: async () => undefined,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0, timedOut: false }),
    readFile: async () => "",
    writeFile: async () => undefined,
    listDir: async () => [],
    getPoolStats: () => ({
      totalContainers: 0,
      idleContainers: 0,
      busyContainers: 0,
      waitingRequests: 0,
    }),
    dispose: async () => undefined,
  };
}

function createSecurityLayer() {
  return {
    checkPath: () => ({ allowed: true }),
    checkCommand: () => ({ allowed: true }),
  };
}

describe("ToolExecutor approval gate", () => {
  const inputSchema = z.object({ value: z.string() });

  function createTool(needsApproval: boolean): FlashClawToolDefinition<typeof inputSchema, { ok: boolean }> {
    return {
      name: "demo_tool",
      description: "Demo tool",
      inputSchema,
      permissionLevel: needsApproval ? "execute" : "read",
      category: "utility",
      requiresSandbox: false,
      timeoutMs: 1000,
      needsApproval,
      execute: mock(async () => ({ ok: true })),
    };
  }

  it("blocks approval-required tools unless auto approval is enabled", async () => {
    const tool = createTool(true);
    const executor = new ToolExecutor(
      new Map([[tool.name, tool]]),
      createSandboxManager(),
      createSecurityLayer(),
      createLogger(),
      { autoApproveTools: false },
    );

    const result = await executor.execute("demo_tool", { value: "x" }, "s1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Approval required");
    expect(result.metadata.approvalRequired).toBe(true);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("runs approval-required tools when auto approval is explicitly enabled", async () => {
    const tool = createTool(true);
    const executor = new ToolExecutor(
      new Map([[tool.name, tool]]),
      createSandboxManager(),
      createSecurityLayer(),
      createLogger(),
      { autoApproveTools: true },
    );

    const result = await executor.execute("demo_tool", { value: "x" }, "s1");

    expect(result.success).toBe(true);
    expect(result.metadata.approvalRequired).toBe(true);
    expect(tool.execute).toHaveBeenCalled();
  });
});
