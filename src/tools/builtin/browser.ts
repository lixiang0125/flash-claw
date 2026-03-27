/**
 * @module browser
 * @description 基于 Chrome DevTools Protocol 的本地浏览器接管工具。
 *
 * Bun 运行时下直接使用 Playwright 连接 CDP 会出现稳定性问题，因此这里采用
 * “Bun 管理会话 + Node helper 执行 Playwright”的模式：
 * 1. 优先接管本机已有的 Chrome 调试端口
 * 2. 若端口不可用则自动拉起受控 Chrome
 * 3. 通过 Node helper 完成真实浏览器操作
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "node:child_process";
import { z, ZodType } from "zod";
import type { FlashClawToolDefinition, ToolExecutionContext } from "../types";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 15_000;
const CDP_READY_TIMEOUT_MS = 15_000;
const CDP_POLL_INTERVAL_MS = 250;
const MANAGED_BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), "flashclaw-browser-cdp");
const LOCAL_BROWSER_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const NODE_HELPER_PATH = new URL("../../../scripts/browser-cdp-helper.mjs", import.meta.url);

type BrowserAction =
  | "status"
  | "goto"
  | "search"
  | "click"
  | "type"
  | "press"
  | "text"
  | "html"
  | "evaluate"
  | "screenshot"
  | "wait_for"
  | "select_tab"
  | "reset";

interface BrowserToolInput {
  action: BrowserAction;
  endpointUrl?: string;
  pageIndex?: number;
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  script?: string;
  timeoutMs?: number;
  fullPage?: boolean;
  outputPath?: string;
  newPage?: boolean;
}

interface BrowserTabSummary {
  index: number;
  title: string;
  url: string;
  isSelected: boolean;
}

interface BrowserToolOutput {
  action: BrowserAction;
  endpointUrl: string;
  pageIndex: number;
  currentUrl: string;
  title: string;
  tabs: BrowserTabSummary[];
  text?: string;
  html?: string;
  screenshotPath?: string;
  evaluationResult?: string;
  message?: string;
}

interface BrowserSession {
  endpointUrl: string;
  pageIndex: number;
  lastActiveAt: number;
}

interface BrowserEndpointStatus {
  available: boolean;
}

interface BrowserSecurityPolicy {
  checkPath(pathValue: string, mode: "read" | "write"): { allowed: boolean; reason?: string };
}

interface BrowserHelperInput extends BrowserToolInput {
  endpointUrl: string;
  pageIndex: number;
}

interface BrowserRuntimeDeps {
  fileAccess: typeof fs.access;
  runHelper: (input: BrowserHelperInput, timeoutMs: number) => Promise<BrowserToolOutput>;
  spawnProcess: typeof spawn;
}

const BrowserInput: ZodType<BrowserToolInput> = z.object({
  action: z.enum([
    "status",
    "goto",
    "search",
    "click",
    "type",
    "press",
    "text",
    "html",
    "evaluate",
    "screenshot",
    "wait_for",
    "select_tab",
    "reset",
  ]).describe("浏览器操作类型"),
  endpointUrl: z.string().url().optional().describe("本地 Chrome 的 CDP 地址，默认 http://127.0.0.1:9222"),
  pageIndex: z.number().int().min(0).optional().describe("标签页索引，从 0 开始"),
  url: z.string().url().optional().describe("目标 URL，goto 时必填"),
  selector: z.string().optional().describe("CSS 选择器或 Playwright 兼容选择器；text/html 未传时默认读取整页"),
  value: z.string().optional().describe("输入文本；search 时表示搜索关键词"),
  key: z.string().optional().describe("键盘按键，例如 Enter"),
  script: z.string().optional().describe("在页面上下文执行的 JavaScript"),
  timeoutMs: z.number().int().min(100).max(120_000).optional().describe("等待超时时间（毫秒）"),
  fullPage: z.boolean().optional().describe("截图时是否截取整页"),
  outputPath: z.string().optional().describe("截图输出路径，默认写入工作目录下 browser-artifacts"),
  newPage: z.boolean().optional().describe("goto 时是否新建标签页"),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimeout(timeoutMs?: number): number {
  return timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function resolveEndpoint(endpointUrl?: string): string {
  return endpointUrl?.trim() || process.env["BROWSER_CDP_URL"]?.trim() || DEFAULT_CDP_ENDPOINT;
}

function getSecurityPolicy(context: ToolExecutionContext): BrowserSecurityPolicy | null {
  const candidate = context.securityPolicy;
  if (
    typeof candidate === "object"
    && candidate !== null
    && "checkPath" in candidate
    && typeof (candidate as BrowserSecurityPolicy).checkPath === "function"
  ) {
    return candidate as BrowserSecurityPolicy;
  }

  return null;
}

function assertLocalEndpoint(endpointUrl: string): void {
  let parsed: URL;

  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error(`Invalid CDP endpoint: ${endpointUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported CDP protocol: ${parsed.protocol}`);
  }

  if (!LOCAL_BROWSER_HOSTS.has(parsed.hostname)) {
    throw new Error(`CDP endpoint must point to a local browser, got host: ${parsed.hostname}`);
  }
}

function getChromeExecutableCandidates(): string[] {
  const envPath = process.env["CHROME_PATH"]?.trim();
  return [
    envPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => Boolean(value));
}

async function detectEndpointStatus(endpointUrl: string): Promise<BrowserEndpointStatus> {
  try {
    const versionUrl = new URL("/json/version", endpointUrl).toString();
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(2_000) });
    return { available: response.ok };
  } catch {
    return { available: false };
  }
}

async function waitForEndpoint(endpointUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await detectEndpointStatus(endpointUrl);
    if (status.available) {
      return;
    }

    await sleep(CDP_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for local Chrome CDP endpoint: ${endpointUrl}`);
}

async function startManagedChrome(endpointUrl: string, deps: BrowserRuntimeDeps): Promise<void> {
  const parsed = new URL(endpointUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  let chromePath: string | null = null;

  for (const candidate of getChromeExecutableCandidates()) {
    try {
      await deps.fileAccess(candidate);
      chromePath = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!chromePath) {
    throw new Error(
      "Could not find a local Chrome executable. Set CHROME_PATH or start Chrome with remote debugging manually.",
    );
  }

  await fs.mkdir(MANAGED_BROWSER_USER_DATA_DIR, { recursive: true });

  const child = deps.spawnProcess(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${MANAGED_BROWSER_USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );

  child.unref();
}

async function ensureBrowserEndpoint(endpointUrl: string, deps: BrowserRuntimeDeps): Promise<void> {
  const status = await detectEndpointStatus(endpointUrl);
  if (status.available) {
    return;
  }

  await startManagedChrome(endpointUrl, deps);
  await waitForEndpoint(endpointUrl, CDP_READY_TIMEOUT_MS);
}

async function defaultRunHelper(input: BrowserHelperInput, timeoutMs: number): Promise<BrowserToolOutput> {
  return new Promise<BrowserToolOutput>((resolve, reject) => {
    const child = spawn(
      "node",
      [NODE_HELPER_PATH.pathname],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`browser helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `browser helper exited with code ${code ?? -1}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as BrowserToolOutput);
      } catch (error) {
        reject(new Error(`Failed to parse browser helper output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const browserSessions = new Map<string, BrowserSession>();

const browserRuntimeDeps: BrowserRuntimeDeps = {
  fileAccess: fs.access,
  runHelper: defaultRunHelper,
  spawnProcess: spawn,
};

export function setBrowserRuntimeDepsForTest(overrides: Partial<BrowserRuntimeDeps>): void {
  Object.assign(browserRuntimeDeps, overrides);
}

export function resetBrowserRuntimeDepsForTest(): void {
  browserRuntimeDeps.fileAccess = fs.access;
  browserRuntimeDeps.runHelper = defaultRunHelper;
  browserRuntimeDeps.spawnProcess = spawn;
}

function requireField<T>(value: T | undefined, fieldName: string): T {
  if (value === undefined) {
    throw new Error(`browser tool requires field: ${fieldName}`);
  }
  return value;
}

async function resolveScreenshotPath(outputPath: string | undefined, context: ToolExecutionContext): Promise<string> {
  const fileName = `${Date.now()}-browser.png`;
  const resolvedPath = outputPath
    ? path.isAbsolute(outputPath)
      ? outputPath
      : path.join(context.workingDirectory, outputPath)
    : path.join(context.workingDirectory, "browser-artifacts", fileName);

  const securityPolicy = getSecurityPolicy(context);
  if (securityPolicy) {
    const pathCheck = securityPolicy.checkPath(resolvedPath, "write");
    if (!pathCheck.allowed) {
      throw new Error(`Screenshot path denied: ${pathCheck.reason || resolvedPath}`);
    }
  }

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

async function executeBrowserAction(input: BrowserToolInput, context: ToolExecutionContext): Promise<BrowserToolOutput> {
  const endpointUrl = resolveEndpoint(input.endpointUrl);
  assertLocalEndpoint(endpointUrl);

  if (input.action === "reset") {
    browserSessions.delete(context.sessionId);
    return {
      action: "reset",
      endpointUrl,
      pageIndex: -1,
      currentUrl: "",
      title: "",
      tabs: [],
      message: "Browser session state cleared. The local browser itself is left running.",
    };
  }

  await ensureBrowserEndpoint(endpointUrl, browserRuntimeDeps);

  const existingSession = browserSessions.get(context.sessionId);
  const pageIndex = input.pageIndex ?? existingSession?.pageIndex ?? 0;
  const outputPath = input.action === "screenshot"
    ? await resolveScreenshotPath(input.outputPath, context)
    : input.outputPath;

  const helperInput: BrowserHelperInput = {
    ...input,
    endpointUrl,
    pageIndex,
    outputPath,
  };

  if (helperInput.action === "goto") {
    requireField(helperInput.url, "url");
  }

  if (helperInput.action === "search") {
    requireField(helperInput.value, "value");
  }

  if (["click", "type", "wait_for"].includes(helperInput.action)) {
    requireField(helperInput.selector, "selector");
  }

  if (helperInput.action === "type") {
    requireField(helperInput.value, "value");
  }

  if (helperInput.action === "press") {
    requireField(helperInput.key, "key");
  }

  if (helperInput.action === "evaluate") {
    requireField(helperInput.script, "script");
  }

  const result = await browserRuntimeDeps.runHelper(helperInput, getTimeout(input.timeoutMs));

  browserSessions.set(context.sessionId, {
    endpointUrl,
    pageIndex: result.pageIndex,
    lastActiveAt: Date.now(),
  });

  return result;
}

export const browserTool: FlashClawToolDefinition<typeof BrowserInput, BrowserToolOutput> = {
  name: "browser",
  description:
    "通过本地 Chrome 的 CDP 接口接管真实浏览器标签页，支持多步完成网页任务：打开页面、读取文本或 HTML、输入关键词、点击按钮、按键提交、等待结果、截图和执行页面脚本。支持 `search` 动作在当前页面或指定 URL 上直接完成站内搜索。用户要求使用浏览器时，应持续调用本工具直到任务完成，而不是只打开页面。",
  inputSchema: BrowserInput,
  permissionLevel: "execute",
  category: "integration",
  requiresSandbox: false,
  timeoutMs: 120_000,
  needsApproval: true,
  strict: true,
  inputExamples: [
    { input: { action: "status" } },
    { input: { action: "goto", url: "https://example.com" } },
    { input: { action: "search", url: "https://www.baidu.com", value: "美伊战争", newPage: true } },
    { input: { action: "click", selector: "text=Sign in" } },
    { input: { action: "type", selector: "input[name='q']", value: "flashclaw" } },
  ],
  toModelOutput: (output: BrowserToolOutput): string => {
    const lines: string[] = [
      `Action: ${output.action}`,
      `Endpoint: ${output.endpointUrl}`,
      `Selected tab: #${output.pageIndex}`,
      `URL: ${output.currentUrl || "(none)"}`,
      `Title: ${output.title || "(untitled)"}`,
    ];

    if (output.message) lines.push(`Message: ${output.message}`);
    if (output.text) lines.push(`Text:\n${output.text}`);
    if (output.html) lines.push(`HTML:\n${output.html}`);
    if (output.evaluationResult) lines.push(`Evaluation Result:\n${output.evaluationResult}`);
    if (output.screenshotPath) lines.push(`Screenshot: ${output.screenshotPath}`);

    if (output.tabs.length > 0) {
      lines.push(
        "Tabs:\n" + output.tabs.map((tab) => {
          const selectedFlag = tab.isSelected ? "*" : "-";
          return `${selectedFlag} [${tab.index}] ${tab.title || "(untitled)"} -> ${tab.url || "about:blank"}`;
        }).join("\n"),
      );
    }

    return lines.join("\n");
  },
  /**
   * 连接本地浏览器并执行指定操作。
   */
  execute: async (input: BrowserToolInput, context: ToolExecutionContext): Promise<BrowserToolOutput> => {
    return executeBrowserAction(input, context);
  },
};
