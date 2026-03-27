import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function requireField(value, fieldName) {
  if (value === undefined) {
    throw new Error(`browser helper requires field: ${fieldName}`);
  }

  return value;
}

async function safePageTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

async function summarizeTabs(context, selectedPage) {
  const tabs = [];
  for (const [index, page] of context.pages().entries()) {
    tabs.push({
      index,
      title: await safePageTitle(page),
      url: page.url(),
      isSelected: page === selectedPage,
    });
  }
  return tabs;
}

async function selectPage(context, pageIndex, newPage) {
  if (newPage) {
    const createdPage = await context.newPage();
    return {
      page: createdPage,
      pageIndex: context.pages().length - 1,
    };
  }

  const pages = context.pages();
  const selected = pages[pageIndex] ?? pages[0] ?? await context.newPage();
  const resolvedIndex = pages.indexOf(selected);

  return {
    page: selected,
    pageIndex: resolvedIndex >= 0 ? resolvedIndex : 0,
  };
}

async function buildOutput(action, endpointUrl, page, pageIndex, context, extras = {}) {
  return {
    action,
    endpointUrl,
    pageIndex,
    currentUrl: page.url(),
    title: await safePageTitle(page),
    tabs: await summarizeTabs(context, page),
    ...extras,
  };
}

function getSearchFieldCandidates(currentUrl, explicitSelector) {
  if (explicitSelector) {
    return [explicitSelector];
  }

  const hostname = (() => {
    try {
      return new URL(currentUrl).hostname;
    } catch {
      return "";
    }
  })();

  const candidates = [];

  // 针对常见搜索引擎优先尝试稳定选择器，再回退到通用输入框启发式。
  if (hostname.includes("baidu.com")) {
    candidates.push("#kw", "input[name='wd']", "textarea[name='wd']");
  }

  if (hostname.includes("google.")) {
    candidates.push("textarea[name='q']", "input[name='q']");
  }

  if (hostname.includes("bing.com") || hostname.includes("yahoo.com")) {
    candidates.push("input[name='q']");
  }

  candidates.push(
    "input[type='search']",
    "input[role='searchbox']",
    "textarea[role='searchbox']",
    "form input[type='text']",
    "form textarea",
    "input[type='text']",
    "textarea",
  );

  return candidates;
}

async function resolveSearchField(page, explicitSelector, timeoutMs) {
  const candidates = getSearchFieldCandidates(page.url(), explicitSelector);

  for (const selector of candidates) {
    const locator = page.locator(selector).first();

    try {
      await locator.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 2000) });
      return { locator, selector };
    } catch {
      continue;
    }
  }

  throw new Error("Could not locate a visible search field on the current page.");
}

async function extractPageText(page, timeoutMs) {
  try {
    const text = await page.locator("body").innerText({ timeout: Math.min(timeoutMs, 5000) });
    return text.trim().slice(0, 4000);
  } catch {
    return "";
  }
}

async function main() {
  const rawInput = await new Promise((resolve, reject) => {
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      source += chunk;
    });
    process.stdin.on("end", () => resolve(source));
    process.stdin.on("error", reject);
  });

  const input = JSON.parse(rawInput);
  const browser = await chromium.connectOverCDP(input.endpointUrl);

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Connected to browser, but no browser context is available via CDP.");
    }

    const { page, pageIndex } = await selectPage(context, input.pageIndex ?? 0, Boolean(input.newPage));
    const timeoutMs = input.timeoutMs ?? 15000;
    let result;

    switch (input.action) {
      case "status":
        result = await buildOutput("status", input.endpointUrl, page, pageIndex, context, {
          message: `Connected to local browser via CDP: ${input.endpointUrl}`,
        });
        break;

      case "select_tab":
        result = await buildOutput("select_tab", input.endpointUrl, page, pageIndex, context, {
          message: `Selected tab #${pageIndex}`,
        });
        break;

      case "goto": {
        const url = requireField(input.url, "url");
        await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
        result = await buildOutput("goto", input.endpointUrl, page, pageIndex, context, {
          message: `Navigated to ${url}`,
        });
        break;
      }

      case "search": {
        const value = requireField(input.value, "value");

        if (input.url) {
          await page.goto(input.url, { waitUntil: "networkidle", timeout: timeoutMs });
        }

        const { locator, selector } = await resolveSearchField(page, input.selector, timeoutMs);

        await locator.click({ timeout: timeoutMs });
        await locator.fill(value, { timeout: timeoutMs });
        await Promise.allSettled([
          page.waitForLoadState("networkidle", { timeout: timeoutMs }),
          locator.press(input.key || "Enter", { timeout: timeoutMs }),
        ]);
        await page.waitForTimeout(500);

        result = await buildOutput("search", input.endpointUrl, page, pageIndex, context, {
          message: `Searched for \"${value}\" using ${selector}`,
          text: await extractPageText(page, timeoutMs),
        });
        break;
      }

      case "click": {
        const selector = requireField(input.selector, "selector");
        await page.locator(selector).first().click({ timeout: timeoutMs });
        result = await buildOutput("click", input.endpointUrl, page, pageIndex, context, {
          message: `Clicked ${selector}`,
        });
        break;
      }

      case "type": {
        const selector = requireField(input.selector, "selector");
        const value = requireField(input.value, "value");
        await page.locator(selector).first().fill(value, { timeout: timeoutMs });
        result = await buildOutput("type", input.endpointUrl, page, pageIndex, context, {
          message: `Filled ${selector}`,
        });
        break;
      }

      case "press": {
        const key = requireField(input.key, "key");
        if (input.selector) {
          await page.locator(input.selector).first().press(key, { timeout: timeoutMs });
        } else {
          await page.keyboard.press(key);
        }
        result = await buildOutput("press", input.endpointUrl, page, pageIndex, context, {
          message: `Pressed ${key}`,
        });
        break;
      }

      case "wait_for": {
        const selector = requireField(input.selector, "selector");
        await page.locator(selector).first().waitFor({ timeout: timeoutMs });
        result = await buildOutput("wait_for", input.endpointUrl, page, pageIndex, context, {
          message: `Selector became available: ${selector}`,
        });
        break;
      }

      case "text": {
        const selector = input.selector || "body";
        const text = (await page.locator(selector).first().innerText({ timeout: timeoutMs })).trim();
        result = await buildOutput("text", input.endpointUrl, page, pageIndex, context, {
          text,
          message: input.selector
            ? `Extracted text from ${selector}`
            : "Extracted text from the full page body",
        });
        break;
      }

      case "html": {
        const html = input.selector
          ? await page.locator(input.selector).first().innerHTML({ timeout: timeoutMs })
          : await page.content();
        result = await buildOutput("html", input.endpointUrl, page, pageIndex, context, { html });
        break;
      }

      case "evaluate": {
        const script = requireField(input.script, "script");
        const evaluationResult = await page.evaluate((source) => globalThis.eval(source), script);
        result = await buildOutput("evaluate", input.endpointUrl, page, pageIndex, context, {
          evaluationResult: typeof evaluationResult === "string"
            ? evaluationResult
            : JSON.stringify(evaluationResult, null, 2),
        });
        break;
      }

      case "screenshot": {
        const screenshotPath = requireField(input.outputPath, "outputPath");
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: input.fullPage ?? true });
        result = await buildOutput("screenshot", input.endpointUrl, page, pageIndex, context, { screenshotPath });
        break;
      }

      default:
        throw new Error(`Unsupported browser action: ${input.action}`);
    }

    process.stdout.write(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
