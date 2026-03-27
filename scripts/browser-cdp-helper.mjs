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
        const selector = requireField(input.selector, "selector");
        const text = (await page.locator(selector).first().innerText({ timeout: timeoutMs })).trim();
        result = await buildOutput("text", input.endpointUrl, page, pageIndex, context, { text });
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
