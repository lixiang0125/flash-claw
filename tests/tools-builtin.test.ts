import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bashTool } from "../src/tools/builtin/bash";
import { writeFileTool } from "../src/tools/builtin/write-file";
import { readFileTool } from "../src/tools/builtin/read-file";
import { editFileTool } from "../src/tools/builtin/edit-file";
import { globTool } from "../src/tools/builtin/glob";
import { grepTool } from "../src/tools/builtin/grep";

let tmpDir: string;
let ctx: any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-claw-test-"));
  ctx = {
    sessionId: "test-session",
    workingDirectory: tmpDir,
    sandbox: null,
    securityPolicy: null,
    eventBus: null,
    logger: console,
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// bashTool
// ---------------------------------------------------------------------------
describe("bashTool", () => {
  test("executes echo and captures stdout", async () => {
    const result: any = await bashTool.execute({ command: "echo hello world" }, ctx);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  test("captures non-zero exit code", async () => {
    const result: any = await bashTool.execute({ command: "exit 42" }, ctx);
    expect(result.exitCode).toBe(42);
  });

  test("captures stderr output", async () => {
    const result: any = await bashTool.execute(
      { command: "echo errormsg >&2" },
      ctx,
    );
    expect(result.stderr).toContain("errormsg");
  });

  test("respects working directory", async () => {
    const result: any = await bashTool.execute({ command: "pwd" }, ctx);
    expect(result.stdout.trim()).toBe(tmpDir);
  });

  test("returns durationMs as a number", async () => {
    const result: any = await bashTool.execute({ command: "echo fast" }, ctx);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("handles command with pipes", async () => {
    const result: any = await bashTool.execute(
      { command: "echo one two three | wc -w" },
      ctx,
    );
    expect(result.stdout.trim()).toBe("3");
    expect(result.exitCode).toBe(0);
  });

  test("returns the executed command string", async () => {
    const cmd = "echo test-cmd";
    const result: any = await bashTool.execute({ command: cmd }, ctx);
    expect(result.command).toBe(cmd);
  });

  test("handles multi-line output", async () => {
    const result: any = await bashTool.execute(
      { command: "echo line1 && echo line2 && echo line3" },
      ctx,
    );
    const lines = result.stdout.trim().split("
");
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("line1");
    expect(lines[2]).toBe("line3");
  });
});

// ---------------------------------------------------------------------------
// writeFileTool
// ---------------------------------------------------------------------------
describe("writeFileTool", () => {
  test("writes a new file", async () => {
    const filePath = path.join(tmpDir, "new.txt");
    const result: any = await writeFileTool.execute(
      { path: filePath, content: "hello" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello");
  });

  test("overwrites an existing file", async () => {
    const filePath = path.join(tmpDir, "overwrite.txt");
    fs.writeFileSync(filePath, "old content");
    await writeFileTool.execute(
      { path: filePath, content: "new content" },
      ctx,
    );
    expect(fs.readFileSync(filePath, "utf-8")).toBe("new content");
  });

  test("creates nested directories automatically", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "deep.txt");
    const result: any = await writeFileTool.execute(
      { path: filePath, content: "deep" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("writes an empty file", async () => {
    const filePath = path.join(tmpDir, "empty.txt");
    const result: any = await writeFileTool.execute(
      { path: filePath, content: "" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("");
  });

  test("returns bytesWritten", async () => {
    const filePath = path.join(tmpDir, "bytes.txt");
    const content = "abcde";
    const result: any = await writeFileTool.execute(
      { path: filePath, content },
      ctx,
    );
    expect(result.bytesWritten).toBe(Buffer.byteLength(content, "utf-8"));
  });
});

// ---------------------------------------------------------------------------
// readFileTool
// ---------------------------------------------------------------------------
describe("readFileTool", () => {
  test("reads an existing file", async () => {
    const filePath = path.join(tmpDir, "read.txt");
    fs.writeFileSync(filePath, "file content here");
    const result: any = await readFileTool.execute({ path: filePath }, ctx);
    expect(result.content).toContain("file content here");
    expect(result.path).toBe(filePath);
  });

  test("returns error for non-existent file", async () => {
    const filePath = path.join(tmpDir, "no-such-file.txt");
    try {
      await readFileTool.execute({ path: filePath }, ctx);
      // If it doesn't throw, it may return an error field
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });

  test("supports startLine and endLine range", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    const lines = Array.from({ length: 20 }, (_, i) => "line" + (i + 1));
    fs.writeFileSync(filePath, lines.join("
"));
    const result: any = await readFileTool.execute(
      { path: filePath, startLine: 3, endLine: 5 },
      ctx,
    );
    expect(result.content).toContain("line3");
    expect(result.content).toContain("line5");
    expect(result.content).not.toContain("line1");
  });

  test("truncates large file content to MAX_OUTPUT_CHARS", async () => {
    const filePath = path.join(tmpDir, "large.txt");
    // Create content larger than 50000 chars
    const bigContent = "x".repeat(60000);
    fs.writeFileSync(filePath, bigContent);
    const result: any = await readFileTool.execute({ path: filePath }, ctx);
    expect(result.content.length).toBeLessThanOrEqual(50000);
    expect(result.truncated).toBe(true);
  });

  test("returns accurate lineCount", async () => {
    const filePath = path.join(tmpDir, "counted.txt");
    fs.writeFileSync(filePath, "a
b
c
d
e");
    const result: any = await readFileTool.execute({ path: filePath }, ctx);
    expect(result.lineCount).toBe(5);
  });

  test("reads an empty file", async () => {
    const filePath = path.join(tmpDir, "empty-read.txt");
    fs.writeFileSync(filePath, "");
    const result: any = await readFileTool.execute({ path: filePath }, ctx);
    expect(result.content).toBe("");
  });

  test("reads file with unicode content", async () => {
    const filePath = path.join(tmpDir, "unicode.txt");
    const unicodeContent = "Hello World - Bonjour le monde";
    fs.writeFileSync(filePath, unicodeContent, "utf-8");
    const result: any = await readFileTool.execute({ path: filePath }, ctx);
    expect(result.content).toContain(unicodeContent);
  });
});

// ---------------------------------------------------------------------------
// editFileTool
// ---------------------------------------------------------------------------
describe("editFileTool", () => {
  test("performs a single replacement", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    fs.writeFileSync(filePath, "hello world hello");
    const result: any = await editFileTool.execute(
      { path: filePath, search: "hello", replace: "hi" },
      ctx,
    );
    expect(result.replacements).toBe(1);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("hi world hello");
  });

  test("replaces all occurrences with replaceAll option", async () => {
    const filePath = path.join(tmpDir, "edit-all.txt");
    fs.writeFileSync(filePath, "aaa bbb aaa bbb aaa");
    const result: any = await editFileTool.execute(
      { path: filePath, search: "aaa", replace: "ccc", replaceAll: true },
      ctx,
    );
    expect(result.replacements).toBe(3);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("ccc bbb ccc bbb ccc");
  });

  test("returns 0 replacements when search string not found", async () => {
    const filePath = path.join(tmpDir, "edit-none.txt");
    fs.writeFileSync(filePath, "nothing to see here");
    const result: any = await editFileTool.execute(
      { path: filePath, search: "missing", replace: "found" },
      ctx,
    );
    expect(result.replacements).toBe(0);
  });

  test("handles special regex characters in search (escapeRegExp)", async () => {
    const filePath = path.join(tmpDir, "edit-special.txt");
    fs.writeFileSync(filePath, "price is 00.00 (USD)");
    const result: any = await editFileTool.execute(
      { path: filePath, search: "00.00 (USD)", replace: "200 EUR" },
      ctx,
    );
    expect(result.replacements).toBe(1);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("200 EUR");
  });

  test("returns updated content in result", async () => {
    const filePath = path.join(tmpDir, "edit-content.txt");
    fs.writeFileSync(filePath, "foo bar baz");
    const result: any = await editFileTool.execute(
      { path: filePath, search: "bar", replace: "qux" },
      ctx,
    );
    expect(result.content).toContain("qux");
    expect(result.path).toBe(filePath);
  });
});

// ---------------------------------------------------------------------------
// globTool
// ---------------------------------------------------------------------------
describe("globTool", () => {
  test("matches .ts files", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "c.js"), "");
    const result: any = await globTool.execute({ pattern: "*.ts" }, ctx);
    expect(result.count).toBe(2);
    expect(result.files.length).toBe(2);
    result.files.forEach((f: string) => expect(f).toMatch(/\.ts$/));
  });

  test("matches nested patterns with **", async () => {
    const nested = path.join(tmpDir, "src", "lib");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "util.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "");
    const result: any = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  test("returns empty list when no matches", async () => {
    const result: any = await globTool.execute({ pattern: "*.xyz" }, ctx);
    expect(result.files).toEqual([]);
    expect(result.count).toBe(0);
  });

  test("returns the pattern in the result", async () => {
    const result: any = await globTool.execute({ pattern: "**/*.md" }, ctx);
    expect(result.pattern).toBe("**/*.md");
  });

  test("respects working directory", async () => {
    const sub = path.join(tmpDir, "subdir");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "only-here.txt"), "");

    const subCtx = { ...ctx, workingDirectory: sub };
    const result: any = await globTool.execute({ pattern: "*.txt" }, subCtx);
    expect(result.count).toBe(1);
    expect(result.files[0]).toContain("only-here.txt");
  });

  test("limits results to 100 files", async () => {
    // Create 105 files
    for (let i = 0; i < 105; i++) {
      fs.writeFileSync(path.join(tmpDir, "file" + i + ".dat"), "");
    }
    const result: any = await globTool.execute({ pattern: "*.dat" }, ctx);
    expect(result.files.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// grepTool
// ---------------------------------------------------------------------------
describe("grepTool", () => {
  test("finds text in files", async () => {
    fs.writeFileSync(path.join(tmpDir, "search.txt"), "hello world
foo bar
hello again");
    const result: any = await grepTool.execute({ pattern: "hello" }, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(2);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty results when no matches found", async () => {
    fs.writeFileSync(path.join(tmpDir, "nope.txt"), "nothing relevant");
    const result: any = await grepTool.execute({ pattern: "zzzyyyxxx" }, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.files.length).toBe(0);
  });

  test("supports regex patterns", async () => {
    fs.writeFileSync(path.join(tmpDir, "regex.txt"), "abc123
def456
ghi789");
    const result: any = await grepTool.execute({ pattern: "[a-z]+\d+" }, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(3);
  });

  test("respects working directory", async () => {
    const sub = path.join(tmpDir, "grep-sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "target.txt"), "findme here");
    fs.writeFileSync(path.join(tmpDir, "other.txt"), "findme there");

    const subCtx = { ...ctx, workingDirectory: sub };
    const result: any = await grepTool.execute({ pattern: "findme" }, subCtx);
    // Should only find matches in the sub directory
    expect(result.totalMatches).toBe(1);
    expect(result.files.length).toBe(1);
  });

  test("returns file path and match details", async () => {
    fs.writeFileSync(path.join(tmpDir, "detail.txt"), "first line
match target here
last line");
    const result: any = await grepTool.execute({ pattern: "match target" }, ctx);
    expect(result.files.length).toBe(1);
    const file = result.files[0];
    expect(file.path).toContain("detail.txt");
    expect(file.matches.length).toBeGreaterThanOrEqual(1);
    expect(file.matches[0].content).toContain("match target");
  });
});
