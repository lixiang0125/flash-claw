// @ts-nocheck
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// ============================================================================
// llm-parser.ts 单元测试
// ============================================================================
// LRUCache 不导出，需通过模块级 cache 间接测试，或复制实现进行单元验证。
// parseTaskWithLLM / rewriteMemoryQuery 通过 mock.module 替换 OpenAI client。
// ============================================================================

// ---------------------------------------------------------------------------
// 1. LRUCache 独立测试（复制内部实现，直接验证逻辑）
// ---------------------------------------------------------------------------

/** 与 llm-parser.ts 中 LRUCache 实现完全一致的副本，用于隔离测试 */
class LRUCache<V> {
  private map = new Map<string, { value: V; ts: number }>();

  constructor(
    private maxSize: number = 128,
    private ttlMs: number = 5 * 60_000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, ts: Date.now() });
  }

  /** 测试辅助：获取当前缓存大小 */
  get size(): number { return this.map.size; }
}

describe("LRUCache", () => {
  it("基本 get/set 操作", () => {
    const c = new LRUCache<string>(10, 60_000);
    expect(c.get("a")).toBeUndefined();
    c.set("a", "hello");
    expect(c.get("a")).toBe("hello");
  });

  it("缓存未命中时返回 undefined", () => {
    const c = new LRUCache<number>(10, 60_000);
    expect(c.get("nonexistent")).toBeUndefined();
  });

  it("set 相同 key 时覆盖旧值", () => {
    const c = new LRUCache<string>(10, 60_000);
    c.set("k", "v1");
    c.set("k", "v2");
    expect(c.get("k")).toBe("v2");
    expect(c.size).toBe(1);
  });

  it("可缓存 null/undefined 作为值", () => {
    const c = new LRUCache<string | null>(10, 60_000);
    c.set("n", null);
    // null !== undefined，所以 get 应返回 null 而非 undefined
    expect(c.get("n")).toBeNull();
  });

  // ---- TTL 过期 ----
  describe("TTL 过期淘汰", () => {
    it("TTL 过期后 get 返回 undefined", () => {
      const c = new LRUCache<string>(10, 50); // 50ms TTL
      c.set("x", "val");
      expect(c.get("x")).toBe("val");

      // 手动等待超过 TTL
      const start = Date.now();
      while (Date.now() - start < 60) { /* busy wait */ }

      expect(c.get("x")).toBeUndefined();
    });

    it("TTL 过期条目被自动删除", () => {
      const c = new LRUCache<string>(10, 50);
      c.set("a", "1");
      c.set("b", "2");
      expect(c.size).toBe(2);

      const start = Date.now();
      while (Date.now() - start < 60) {}

      // 访问过期条目触发删除
      c.get("a");
      c.get("b");
      expect(c.size).toBe(0);
    });

    it("未过期条目不受影响", () => {
      const c = new LRUCache<string>(10, 5000);
      c.set("k", "alive");
      expect(c.get("k")).toBe("alive");
    });
  });

  // ---- 容量淘汰 (LRU) ----
  describe("容量淘汰", () => {
    it("超过 maxSize 时淘汰最旧条目", () => {
      const c = new LRUCache<number>(3, 60_000);
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3);
      expect(c.size).toBe(3);

      c.set("d", 4); // 应淘汰 "a"
      expect(c.get("a")).toBeUndefined();
      expect(c.get("b")).toBe(2);
      expect(c.get("d")).toBe(4);
      expect(c.size).toBe(3);
    });

    it("访问条目后提升优先级，淘汰真正最旧的", () => {
      const c = new LRUCache<number>(3, 60_000);
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3);

      // 访问 "a"，使其变为最近使用
      c.get("a");

      c.set("d", 4); // 现在应淘汰 "b"（最旧未访问）
      expect(c.get("a")).toBe(1); // "a" 仍在
      expect(c.get("b")).toBeUndefined(); // "b" 被淘汰
      expect(c.get("d")).toBe(4);
    });

    it("set 已存在 key 不增加容量", () => {
      const c = new LRUCache<number>(2, 60_000);
      c.set("a", 1);
      c.set("b", 2);
      c.set("a", 10); // 更新，不新增
      expect(c.size).toBe(2);
      expect(c.get("a")).toBe(10);
      expect(c.get("b")).toBe(2);
    });

    it("maxSize=1 时每次 set 都淘汰旧条目", () => {
      const c = new LRUCache<string>(1, 60_000);
      c.set("a", "x");
      expect(c.get("a")).toBe("x");
      c.set("b", "y");
      expect(c.get("a")).toBeUndefined();
      expect(c.get("b")).toBe("y");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. parseTaskWithLLM / rewriteMemoryQuery（通过 mock.module 拦截 OpenAI）
// ---------------------------------------------------------------------------

// 创建一个可控的 mock create 函数
let mockCreate: ReturnType<typeof mock>;

// mock OpenAI 模块，使 llm-parser 内部的 getClient() 返回我们的 mock
mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: (...args: any[]) => mockCreate(...args),
        },
      };
    },
  };
});

// 重要: mock.module 后 import，确保 llm-parser 使用 mock 版本
// 同时需要重置内部 _client 单例
import { parseTaskWithLLM, rewriteMemoryQuery } from "../src/chat/llm-parser";

/** 辅助: 构造 OpenAI chat completion 响应 */
function makeResponse(content: string) {
  return {
    choices: [{ message: { role: "assistant", content } }],
  };
}

describe("parseTaskWithLLM", () => {
  beforeEach(() => {
    // 重置 llm-parser 内部的 _client 单例，强制下次调用重新创建
    // 这样每个测试都会使用最新的 mockCreate
    try {
      const mod = require("../src/chat/llm-parser");
      // 内部变量通过模块作用域无法直接访问，但 mock.module 已全局替换 OpenAI
    } catch {}
    mockCreate = mock(() => Promise.resolve(makeResponse('{"isTask": false}')));
  });

  it("非任务消息返回 null", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse('{"isTask": false}'))
    );
    const result = await parseTaskWithLLM("今天天气怎么样");
    expect(result).toBeNull();
  });

  it("一次性任务返回正确的 ParsedTask", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        isTask: true,
        name: "提醒开会",
        message: "下午三点开会",
        type: "once",
        executeAfter: 3600000,
      })))
    );
    const result = await parseTaskWithLLM("一小时后提醒我开会__once");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("once");
    expect(result!.name).toBe("提醒开会");
    expect(result!.executeAfter).toBe(3600000);
  });

  it("周期性任务返回正确的 cron schedule", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        isTask: true,
        name: "每日提醒",
        message: "喝水",
        type: "recurring",
        schedule: "0 9 * * *",
      })))
    );
    const result = await parseTaskWithLLM("每天早上9点提醒我喝水__recur");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("recurring");
    expect(result!.schedule).toBe("0 9 * * *");
  });

  it("LLM 返回带 markdown 代码块时正确剥离", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse('```json\n{"isTask": true, "name": "测试", "message": "测试内容", "type": "once", "executeAfter": 60000}\n```'))
    );
    const result = await parseTaskWithLLM("1分钟后提醒__md");
    expect(result).not.toBeNull();
    expect(result!.executeAfter).toBe(60000);
  });

  it("LLM 返回空内容时返回 null", async () => {
    mockCreate = mock(() =>
      Promise.resolve({ choices: [{ message: { content: "" } }] })
    );
    const result = await parseTaskWithLLM("空响应__empty");
    expect(result).toBeNull();
  });

  it("LLM 返回无效 JSON 时返回 null（不崩溃）", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse("this is not json"))
    );
    const result = await parseTaskWithLLM("坏json__bad");
    expect(result).toBeNull();
  });

  it("网络错误时返回 null（不崩溃）", async () => {
    mockCreate = mock(() => Promise.reject(new Error("network timeout")));
    const result = await parseTaskWithLLM("网络超时__net");
    expect(result).toBeNull();
  });

  it("缺少必填字段 name 时返回 null", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        isTask: true,
        message: "内容",
        type: "once",
        executeAfter: 60000,
      })))
    );
    const result = await parseTaskWithLLM("无name__noname");
    expect(result).toBeNull();
  });

  it("once 类型 executeAfter <= 0 时返回 null", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        isTask: true,
        name: "测试",
        message: "内容",
        type: "once",
        executeAfter: -1,
      })))
    );
    const result = await parseTaskWithLLM("负数时间__neg");
    expect(result).toBeNull();
  });

  it("recurring 类型 cron 非 5 段时返回 null", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        isTask: true,
        name: "坏cron",
        message: "内容",
        type: "recurring",
        schedule: "0 9 * *", // 只有 4 段
      })))
    );
    const result = await parseTaskWithLLM("坏cron__bad");
    expect(result).toBeNull();
  });

  it("未知 type 时返回 null", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        isTask: true,
        name: "未知",
        message: "内容",
        type: "weekly",
      })))
    );
    const result = await parseTaskWithLLM("未知类型__unknown");
    expect(result).toBeNull();
  });
});

describe("rewriteMemoryQuery", () => {
  beforeEach(() => {
    mockCreate = mock(() => Promise.resolve(makeResponse("默认关键词")));
  });

  it("正常改写返回 LLM 输出", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse("用户 姓名 身份 职业"))
    );
    const result = await rewriteMemoryQuery("我是谁__rw1");
    expect(result).toBe("用户 姓名 身份 职业");
  });

  it("LLM 返回空内容时回退到原始消息", async () => {
    mockCreate = mock(() =>
      Promise.resolve({ choices: [{ message: { content: "" } }] })
    );
    const msg = "空回复测试__rw2";
    const result = await rewriteMemoryQuery(msg);
    expect(result).toBe(msg);
  });

  it("LLM 返回超长内容时回退到原始消息", async () => {
    mockCreate = mock(() =>
      Promise.resolve(makeResponse("x".repeat(201)))
    );
    const msg = "超长__rw3";
    const result = await rewriteMemoryQuery(msg);
    expect(result).toBe(msg);
  });

  it("网络错误时回退到原始消息", async () => {
    mockCreate = mock(() => Promise.reject(new Error("timeout")));
    const msg = "网络故障__rw4";
    const result = await rewriteMemoryQuery(msg);
    expect(result).toBe(msg);
  });

  it("LLM 返回正好 200 字符时正常返回（边界值）", async () => {
    const longButOk = "k".repeat(200);
    mockCreate = mock(() =>
      Promise.resolve(makeResponse(longButOk))
    );
    const result = await rewriteMemoryQuery("边界200__rw5");
    expect(result).toBe(longButOk);
  });
});
