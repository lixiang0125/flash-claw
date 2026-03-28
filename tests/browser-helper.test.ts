import { describe, expect, test } from "bun:test";
import { shouldUseEditableClickFallback } from "../scripts/browser-cdp-helper.mjs";

describe("browser CDP helper", () => {
  test("marks common search box selectors for focus fallback", () => {
    expect(shouldUseEditableClickFallback("#kw")).toBe(true);
    expect(shouldUseEditableClickFallback("input[name='wd']")).toBe(true);
    expect(shouldUseEditableClickFallback("textarea[role='searchbox']")).toBe(true);
  });

  test("keeps normal click behavior for button-like selectors", () => {
    expect(shouldUseEditableClickFallback("button[type='submit']")).toBe(false);
    expect(shouldUseEditableClickFallback("text=百度一下")).toBe(false);
  });
});
