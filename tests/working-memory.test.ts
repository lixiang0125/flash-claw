// @ts-nocheck
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { WorkingMemory } from "../src/memory/working-memory";
import type { ConversationMessage } from "../src/memory/working-memory";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 创建一条会话消息 */
function makeMsg(
  role: "system" | "user" | "assistant" | "tool",
  content: string,
  extra?: { toolCallId?: string; toolName?: string }
): ConversationMessage {
  return { role, content, timestamp: Date.now(), ...extra };
}

/** 批量创建用户消息 */
function makeManyMsgs(count: number, prefix = "msg"): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `${prefix}-${i}`,
    timestamp: Date.now() + i,
  }));
}

// ===========================================================================
// 测试用例
// ===========================================================================

describe("WorkingMemory", () => {
  let wm: WorkingMemory;

  beforeEach(() => {
    wm = new WorkingMemory();
  });

  // ========================================================================
  // 构造函数与配置
  // ========================================================================
  describe("构造函数与配置", () => {
    it("应使用默认配置初始化", () => {
      const cfg = wm.getConfig();
      expect(cfg.maxMessages).toBe(50);
      expect(cfg.maxTokens).toBe(30_000);
      expect(cfg.enableCompression).toBe(true);
      expect(cfg.compressionThreshold).toBe(30);
      expect(cfg.memoryFlushEnabled).toBe(true);
    });

    it("应将自定义部分配置与默认值合并", () => {
      const custom = new WorkingMemory({ maxMessages: 100, enableCompression: false });
      const cfg = custom.getConfig();
      expect(cfg.maxMessages).toBe(100);
      expect(cfg.enableCompression).toBe(false);
      // 未覆盖的字段保持默认
      expect(cfg.maxTokens).toBe(30_000);
      expect(cfg.compressionThreshold).toBe(30);
    });

    it("getConfig 应返回配置副本而非引用", () => {
      const cfg1 = wm.getConfig();
      (cfg1 as any).maxMessages = 999;
      const cfg2 = wm.getConfig();
      expect(cfg2.maxMessages).toBe(50);
    });
  });

  // ========================================================================
  // append — 消息追加与自动裁剪
  // ========================================================================
  describe("append — 消息追加与自动裁剪", () => {
    it("应正确追加一条消息", () => {
      wm.append("s1", makeMsg("user", "你好"));
      const msgs = wm.getMessages("s1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("你好");
      expect(msgs[0].role).toBe("user");
    });

    it("当消息数超过 maxMessages 时应自动裁剪最旧的", () => {
      const small = new WorkingMemory({ maxMessages: 5, maxTokens: 999_999 });
      for (let i = 0; i < 8; i++) {
        small.append("s1", makeMsg("user", `msg-${i}`));
      }
      const result = small.getMessages("s1");
      expect(result.length).toBeLessThanOrEqual(5);
      // 最后一条应是最后追加的
      expect(result[result.length - 1].content).toBe("msg-7");
    });

    it("按 maxTokens 裁剪时应保留 system 消息", () => {
      const tiny = new WorkingMemory({ maxMessages: 200, maxTokens: 100 });
      tiny.append("s1", makeMsg("system", "你是一个助手。"));
      // 追加大量内容以超过 token 上限
      for (let i = 0; i < 20; i++) {
        tiny.append("s1", makeMsg("user", "这是一段较长的文本用于超限" + "填充".repeat(15)));
      }
      const result = tiny.getMessages("s1");
      const systemMsgs = result.filter(m => m.role === "system");
      expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
      expect(systemMsgs[0].content).toBe("你是一个助手。");
    });

    it("应正确估算中文文本的 token 数", () => {
      const wm2 = new WorkingMemory();
      wm2.append("s1", makeMsg("user", "你好世界测试")); // 6 中文字 → ~4 tokens
      const stats = wm2.getStats("s1");
      expect(stats.estimatedTokens).toBeGreaterThan(0);
      expect(stats.messageCount).toBe(1);
    });

    it("应正确估算混合文本的 token 数", () => {
      const wm2 = new WorkingMemory();
      wm2.append("s1", makeMsg("user", "你好HelloWorld世界"));
      const stats = wm2.getStats("s1");
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // appendBatch — 批量追加
  // ========================================================================
  describe("appendBatch — 批量追加", () => {
    it("应批量追加所有消息", () => {
      wm.appendBatch("s1", [
        makeMsg("user", "第一条"),
        makeMsg("assistant", "第二条"),
        makeMsg("user", "第三条"),
      ]);
      const result = wm.getMessages("s1");
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe("第一条");
      expect(result[2].content).toBe("第三条");
    });

    it("批量追加也应遵守 maxMessages 限制", () => {
      const small = new WorkingMemory({ maxMessages: 3, maxTokens: 999_999 });
      small.appendBatch("s1", makeManyMsgs(6));
      const result = small.getMessages("s1");
      expect(result.length).toBeLessThanOrEqual(3);
      expect(result[result.length - 1].content).toBe("msg-5");
    });
  });

  // ========================================================================
  // getMessages / getRecent
  // ========================================================================
  describe("getMessages / getRecent", () => {
    it("对未知 session 应返回空数组", () => {
      expect(wm.getMessages("nonexistent")).toEqual([]);
    });

    it("应返回指定 session 的全部消息", () => {
      wm.append("s1", makeMsg("user", "a"));
      wm.append("s1", makeMsg("assistant", "b"));
      wm.append("s2", makeMsg("user", "c"));
      expect(wm.getMessages("s1")).toHaveLength(2);
      expect(wm.getMessages("s2")).toHaveLength(1);
    });

    it("getRecent 应返回最后 N 条消息", () => {
      for (let i = 0; i < 10; i++) {
        wm.append("s1", makeMsg("user", `msg-${i}`));
      }
      const recent = wm.getRecent("s1", 3);
      expect(recent).toHaveLength(3);
      expect(recent[0].content).toBe("msg-7");
      expect(recent[2].content).toBe("msg-9");
    });

    it("getRecent 的 count 超过总数时应返回全部", () => {
      wm.append("s1", makeMsg("user", "唯一消息"));
      const recent = wm.getRecent("s1", 100);
      expect(recent).toHaveLength(1);
    });
  });

  // ========================================================================
  // clear / clearAll / resetSession
  // ========================================================================
  describe("clear / clearAll / resetSession", () => {
    it("clear 应删除指定 session", () => {
      wm.append("s1", makeMsg("user", "hello"));
      wm.append("s2", makeMsg("user", "world"));
      wm.clear("s1");
      expect(wm.getMessages("s1")).toEqual([]);
      expect(wm.getMessages("s2")).toHaveLength(1);
    });

    it("clearAll 应删除所有 session", () => {
      wm.append("s1", makeMsg("user", "a"));
      wm.append("s2", makeMsg("user", "b"));
      wm.clearAll();
      expect(wm.activeSessionCount).toBe(0);
    });

    it("resetSession 应先调用 flushCallback 再清除", async () => {
      const flushedMessages: ConversationMessage[] = [];
      wm.setFlushCallback(async (_sid, msgs) => {
        flushedMessages.push(...msgs);
      });
      wm.append("s1", makeMsg("user", "用户消息"));
      wm.append("s1", makeMsg("assistant", "助手回复"));
      wm.append("s1", makeMsg("system", "系统提示"));

      await wm.resetSession("s1");

      // flushCallback 应收到 user+assistant 消息
      const roles = flushedMessages.map(m => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(wm.getMessages("s1")).toEqual([]);
    });

    it("resetSession 无 flushCallback 时应直接清除", async () => {
      wm.append("s1", makeMsg("user", "test"));
      await wm.resetSession("s1");
      expect(wm.getMessages("s1")).toEqual([]);
    });
  });

  // ========================================================================
  // compress — 会话历史压缩
  // ========================================================================
  describe("compress — 会话历史压缩", () => {
    it("消息数低于阈值时 compress 应为空操作", async () => {
      for (let i = 0; i < 10; i++) {
        wm.append("s1", makeMsg("user", `msg-${i}`));
      }
      await wm.compress("s1", async () => "摘要");
      expect(wm.getMessages("s1")).toHaveLength(10);
    });

    it("消息数达到阈值时应压缩并保留最近 10 条", async () => {
      const cWm = new WorkingMemory({
        compressionThreshold: 15,
        maxMessages: 200,
        maxTokens: 999_999,
        memoryFlushEnabled: false,
      });
      cWm.append("s1", makeMsg("system", "系统指令"));
      for (let i = 0; i < 20; i++) {
        cWm.append("s1", makeMsg("user", `用户消息-${i}`));
      }

      await cWm.compress("s1", async () => "这是一段对话摘要");

      const result = cWm.getMessages("s1");
      // system + summary + 最近10条
      expect(result[0].role).toBe("system");
      expect(result[0].content).toBe("系统指令");
      expect(result[1].content).toContain("摘要");
      const recentMsgs = result.slice(2);
      expect(recentMsgs).toHaveLength(10);
      expect(recentMsgs[recentMsgs.length - 1].content).toBe("用户消息-19");
    });

    it("summarizer 应只接收旧消息（不含 system 和最近 10 条）", async () => {
      const cWm = new WorkingMemory({
        compressionThreshold: 15,
        maxMessages: 200,
        maxTokens: 999_999,
        memoryFlushEnabled: false,
      });
      cWm.append("s1", makeMsg("system", "sys"));
      for (let i = 0; i < 20; i++) {
        cWm.append("s1", makeMsg("user", `m-${i}`));
      }

      let receivedMsgs: ConversationMessage[] = [];
      await cWm.compress("s1", async (msgs) => {
        receivedMsgs = msgs;
        return "summary";
      });

      // 不应含 system
      expect(receivedMsgs.some(m => m.role === "system")).toBe(false);
      // 不应含最近 10 条 (m-10 到 m-19)
      for (let i = 10; i < 20; i++) {
        expect(receivedMsgs.map(m => m.content)).not.toContain(`m-${i}`);
      }
      // 应含旧消息 (m-0 到 m-9)
      for (let i = 0; i < 10; i++) {
        expect(receivedMsgs.map(m => m.content)).toContain(`m-${i}`);
      }
    });

    it("compress 应在压缩前调用 tryFlush", async () => {
      const cWm = new WorkingMemory({
        compressionThreshold: 15,
        maxMessages: 200,
        maxTokens: 10_000,
        reserveTokensFloor: 9_800,
        memoryFlushEnabled: true,
        memoryFlushSoftThreshold: 100,
      });
      let flushCalled = false;
      cWm.setFlushCallback(async () => { flushCalled = true; });
      cWm.append("s1", makeMsg("system", "sys"));
      for (let i = 0; i < 20; i++) {
        cWm.append("s1", makeMsg("user", "较长内容" + "x".repeat(50)));
      }
      await cWm.compress("s1", async () => "summary");
      expect(flushCalled).toBe(true);
    });

    it("多次压缩周期中 flush 可以重复触发", async () => {
      const cWm = new WorkingMemory({
        compressionThreshold: 5,
        maxMessages: 200,
        maxTokens: 200,
        reserveTokensFloor: 10,
        memoryFlushEnabled: true,
        memoryFlushSoftThreshold: 10,
      });
      let flushCount = 0;
      cWm.setFlushCallback(async () => { flushCount++; });

      for (let i = 0; i < 20; i++) {
        cWm.append("s1", makeMsg("user", "round1-" + "x".repeat(30)));
      }
      await cWm.compress("s1", async () => "summary1");
      const first = flushCount;

      for (let i = 0; i < 20; i++) {
        cWm.append("s1", makeMsg("user", "round2-" + "x".repeat(30)));
      }
      await cWm.compress("s1", async () => "summary2");
      expect(flushCount).toBeGreaterThan(first);
    });
  });

  // ========================================================================
  // shouldFlush / tryFlush
  // ========================================================================
  describe("shouldFlush / tryFlush", () => {
    it("memoryFlushEnabled 为 false 时 shouldFlush 应返回 false", () => {
      const noFlush = new WorkingMemory({ memoryFlushEnabled: false });
      noFlush.setFlushCallback(async () => {});
      expect(noFlush.shouldFlush("s1", 999_999)).toBe(false);
    });

    it("同一压缩周期内已 flush 过时 shouldFlush 应返回 false", async () => {
      const wm2 = new WorkingMemory({
        memoryFlushEnabled: true,
        maxTokens: 200,
        reserveTokensFloor: 10,
        memoryFlushSoftThreshold: 10,
      });
      wm2.setFlushCallback(async () => {});
      // Add enough messages so estimateTokens > threshold (200-10-10=180)
      for (let i = 0; i < 30; i++) {
        wm2.append("s1", makeMsg("user", "padding-content-" + "x".repeat(20)));
      }
      await wm2.tryFlush("s1");
      expect(wm2.shouldFlush("s1", 999_999)).toBe(false);
    });

    it("tryFlush 在超过阈值时应调用 callback", async () => {
      const wm2 = new WorkingMemory({
        memoryFlushEnabled: true,
        maxTokens: 200,
        reserveTokensFloor: 10,
        memoryFlushSoftThreshold: 10,
      });
      let callbackCalled = false;
      wm2.setFlushCallback(async () => { callbackCalled = true; });
      for (let i = 0; i < 30; i++) {
        wm2.append("s1", makeMsg("user", "flush-padding-" + "x".repeat(20)));
      }
      await wm2.tryFlush("s1");
      expect(callbackCalled).toBe(true);
    });
  });

  // ========================================================================
  // getStats / getTokenUsage
  // ========================================================================
  describe("getStats / getTokenUsage", () => {
    it("getStats 应返回消息数和 token 估算", () => {
      wm.append("s1", makeMsg("user", "hello world"));
      wm.append("s1", makeMsg("assistant", "hi there"));
      const stats = wm.getStats("s1");
      expect(stats.messageCount).toBe(2);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });

    it("getTokenUsage 应与 getStats.estimatedTokens 一致", () => {
      wm.append("s1", makeMsg("user", "测试文本"));
      expect(wm.getTokenUsage("s1")).toBe(wm.getStats("s1").estimatedTokens);
    });
  });

  // ========================================================================
  // activeSessionCount
  // ========================================================================
  describe("activeSessionCount", () => {
    it("应正确追踪活跃 session 数量", () => {
      expect(wm.activeSessionCount).toBe(0);
      wm.append("s1", makeMsg("user", "a"));
      expect(wm.activeSessionCount).toBe(1);
      wm.append("s2", makeMsg("user", "b"));
      expect(wm.activeSessionCount).toBe(2);
      // 同一 session 追加不增加计数
      wm.append("s1", makeMsg("user", "c"));
      expect(wm.activeSessionCount).toBe(2);
      wm.clear("s1");
      expect(wm.activeSessionCount).toBe(1);
      wm.clearAll();
      expect(wm.activeSessionCount).toBe(0);
    });
  });
});
