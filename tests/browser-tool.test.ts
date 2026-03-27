import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  browserTool,
  resetBrowserRuntimeDepsForTest,
  setBrowserRuntimeDepsForTest,
} from "../src/tools/builtin/browser";

let runHelperMock: ReturnType<typeof mock>;
let spawnMock: ReturnType<typeof mock>;

const context = {
  sessionId: "browser-test-session",
  workingDirectory: "/tmp/flashclaw-browser-tests",
  sandbox: null,
  securityPolicy: {
    checkPath: () => ({ allowed: true }),
  },
  eventBus: null,
  logger: console,
};

beforeEach(() => {
  runHelperMock = mock(async (input: { action: string; endpointUrl: string; pageIndex: number }) => ({
    action: input.action,
    endpointUrl: input.endpointUrl,
    pageIndex: input.pageIndex,
    currentUrl: "https://example.com",
    title: "Example",
    tabs: [
      { index: 0, title: "Example", url: "https://example.com", isSelected: true },
      { index: 1, title: "Docs", url: "https://docs.example.com", isSelected: false },
    ],
    message: input.action === "goto" ? "Navigated to https://openai.com" : "Connected to local browser via CDP",
  }));

  spawnMock = mock(() => ({
    unref() {
      return undefined;
    },
  } as unknown as ChildProcess));

  setBrowserRuntimeDepsForTest({
    runHelper: runHelperMock as unknown as typeof import("../src/tools/builtin/browser")["setBrowserRuntimeDepsForTest"] extends (overrides: infer T) => void
      ? NonNullable<T extends { runHelper?: infer R } ? R : never>
      : never,
    spawnProcess: spawnMock as unknown as typeof import("node:child_process").spawn,
    fileAccess: mock(async () => undefined) as typeof import("fs/promises").access,
  });

  globalThis.fetch = mock(async () => ({
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test" }),
  })) as unknown as typeof fetch;
});

afterEach(async () => {
  await browserTool.execute({ action: "reset" }, context);
  resetBrowserRuntimeDepsForTest();
  delete process.env.BROWSER_CDP_URL;
  delete process.env.CHROME_PATH;
});

describe("browserTool", () => {
  test("status returns tab summaries via local CDP", async () => {
    const result = await browserTool.execute({ action: "status" }, context);

    expect(runHelperMock).toHaveBeenCalledTimes(1);
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0]?.title).toBe("Example");
    expect(result.pageIndex).toBe(0);
  });

  test("goto reuses configured local endpoint from env", async () => {
    process.env.BROWSER_CDP_URL = "http://localhost:9222";

    const result = await browserTool.execute({ action: "goto", url: "https://openai.com" }, context);

    expect(runHelperMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://localhost:9222", action: "goto" }),
      15000,
    );
    expect(result.message).toContain("Navigated");
  });

  test("auto-starts managed Chrome when local endpoint is unavailable", async () => {
    process.env.CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        throw new Error("connection refused");
      }

      return {
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test" }),
      };
    }) as unknown as typeof fetch;

    const result = await browserTool.execute({ action: "status" }, context);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.message).toContain("Connected to local browser");
  });

  test("rejects non-local CDP endpoint for safety", async () => {
    await expect(
      browserTool.execute({ action: "status", endpointUrl: "http://example.com:9222" }, context),
    ).rejects.toThrow("CDP endpoint must point to a local browser");
  });
});
