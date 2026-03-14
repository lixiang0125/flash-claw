// @ts-nocheck
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";

// ============================================================================
// 关键: mock llm-parser 模块，避免真实 HTTP 调用导致超时
// 必须在 import engine 之前声明
// ============================================================================
mock.module("../src/chat/llm-parser", () => ({
  rewriteMemoryQuery: mock((msg: string) => Promise.resolve(msg)),
  parseTaskWithLLM: mock((_msg: string) => Promise.resolve(null)),
}));

import { WorkingMemory } from "../src/memory/working-memory";
import { chatEngine } from "../src/chat/engine";

// ============================================================================
// ChatEngine 单元测试
// ============================================================================
// 测试策略:
//   1. chatEngine 是单例，每个测试通过 DI setter 重新注入依赖
//   2. OpenAI client 通过 (chatEngine as any).client 替换为 mock
//   3. llm-parser 模块已全局 mock，rewriteMemoryQuery 直接透传
//   4. WorkingMemory 使用真实实例
//   5. MemoryManager / TaskScheduler / ToolExecutor 全部 mock
// ============================================================================

// ---------------------------------------------------------------------------
// Mock 工厂
// ---------------------------------------------------------------------------

function createMockMemoryManager() {
  return {
    recall: mock(() => Promise.resolve([])),
    storeInteraction: mock(() => Promise.resolve()),
  };
}

function createMockTaskScheduler() {
  return {
    createTask: mock(() => ({})),
    createOneTimeTask: mock(() => ({})),
  };
}

function createMockToolExecutor() {
  return mock((_name: string, _args: any, _sid: string) =>
    Promise.resolve({ result: "tool-result", error: undefined })
  );
}

/** 创建模拟 OpenAI client（默认返回纯文本，无 tool_calls） */
function createMockClient(content: string = "你好，我是助手。", toolCalls?: any[]) {
  return {
    chat: {
      completions: {
        create: mock(() =>
          Promise.resolve({
            choices: [{
              message: {
                role: "assistant",
                content,
                tool_calls: toolCalls,
              },
              finish_reason: toolCalls ? "tool_calls" : "stop",
            }],
          })
        ),
      },
    },
  };
}

/** 向 chatEngine 注入所有依赖并替换 OpenAI client */
function wireEngine(opts?: {
  wm?: WorkingMemory;
  mm?: ReturnType<typeof createMockMemoryManager>;
  ts?: ReturnType<typeof createMockTaskScheduler>;
  te?: ReturnType<typeof createMockToolExecutor>;
  tools?: any[];
  client?: any;
}) {
  const wm = opts?.wm ?? new WorkingMemory();
  const mm = opts?.mm ?? createMockMemoryManager();
  const ts = opts?.ts ?? createMockTaskScheduler();
  const te = opts?.te ?? createMockToolExecutor();
  const tools = opts?.tools ?? [];
  const client = opts?.client ?? createMockClient();

  chatEngine.setWorkingMemory(wm);
  chatEngine.setMemoryManager(mm as any);
  chatEngine.setTaskScheduler(ts as any);
  chatEngine.setToolExecutor(te);
  chatEngine.setTools(tools);
  (chatEngine as any).client = client;

  return { wm, mm, ts, te, client };
}

// ===========================================================================
// 测试
// ===========================================================================

describe("ChatEngine", () => {
  beforeEach(() => {
    // 重置单例状态
    chatEngine.setWorkingMemory(undefined as any);
    chatEngine.setMemoryManager(undefined as any);
    chatEngine.setTaskScheduler(undefined as any);
    chatEngine.setToolExecutor(undefined as any);
    chatEngine.setTools([]);
    // 清除 sessionSkills
    (chatEngine as any).sessionSkills?.clear?.();
  });

  // =========================================================================
  // DI 注入
  // =========================================================================
  describe("DI 注入", () => {
    it("setWorkingMemory 注入后 getHistoryMessages 可用", () => {
      const wm = new WorkingMemory();
      wm.append("s1", { role: "user", content: "hello", timestamp: Date.now() });
      chatEngine.setWorkingMemory(wm);
      const h = chatEngine.getHistoryMessages("s1");
      expect(h.length).toBeGreaterThanOrEqual(1);
    });

    it("setTools 接受工具数组不抛异常", () => {
      expect(() => chatEngine.setTools([{ type: "function", function: { name: "t" } }])).not.toThrow();
    });

    it("setToolExecutor 接受函数不抛异常", () => {
      expect(() => chatEngine.setToolExecutor(createMockToolExecutor())).not.toThrow();
    });

    it("setMemoryManager 接受 manager 不抛异常", () => {
      expect(() => chatEngine.setMemoryManager(createMockMemoryManager() as any)).not.toThrow();
    });

    it("setTaskScheduler 接受 scheduler 不抛异常", () => {
      expect(() => chatEngine.setTaskScheduler(createMockTaskScheduler() as any)).not.toThrow();
    });
  });

  // =========================================================================
  // getHistoryMessages
  // =========================================================================
  describe("getHistoryMessages — 从 WorkingMemory 读取历史", () => {
    it("未注入 WorkingMemory 时返回空数组", () => {
      chatEngine.setWorkingMemory(undefined as any);
      const r = chatEngine.getHistoryMessages("no-wm");
      expect(Array.isArray(r)).toBe(true);
      expect(r.length).toBe(0);
    });

    it("注入 WM 后返回该会话消息", () => {
      const wm = new WorkingMemory();
      wm.append("s1", { role: "user", content: "第一条", timestamp: Date.now() });
      wm.append("s1", { role: "assistant", content: "第一条回复", timestamp: Date.now() });
      chatEngine.setWorkingMemory(wm);
      const msgs = chatEngine.getHistoryMessages("s1");
      expect(msgs.length).toBe(2);
      expect(msgs[0].content).toBe("第一条");
    });

    it("WM 中追加的消息即时可读", () => {
      const wm = new WorkingMemory();
      chatEngine.setWorkingMemory(wm);
      expect(chatEngine.getHistoryMessages("s1").length).toBe(0);
      wm.append("s1", { role: "user", content: "追加", timestamp: Date.now() });
      expect(chatEngine.getHistoryMessages("s1").length).toBe(1);
    });
  });

  // =========================================================================
  // clearSession
  // =========================================================================
  describe("clearSession — 会话重置", () => {
    it("清除会话后消息为空", async () => {
      const wm = new WorkingMemory();
      wm.append("s1", { role: "user", content: "msg", timestamp: Date.now() });
      chatEngine.setWorkingMemory(wm);
      expect(chatEngine.getHistoryMessages("s1").length).toBe(1);
      await chatEngine.clearSession("s1");
      expect(chatEngine.getHistoryMessages("s1").length).toBe(0);
    });

    it("clearSession 同时清除 sessionSkills", async () => {
      const wm = new WorkingMemory();
      chatEngine.setWorkingMemory(wm);
      const skills = (chatEngine as any).sessionSkills as Map<string, any>;
      skills.set("s1", ["a"]);
      expect(skills.has("s1")).toBe(true);
      await chatEngine.clearSession("s1");
      expect(skills.has("s1")).toBe(false);
    });

    it("未注入 WM 时 clearSession 不抛异常", async () => {
      chatEngine.setWorkingMemory(undefined as any);
      await expect(chatEngine.clearSession("x")).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // chat() — 基本对话流程
  // =========================================================================
  describe("chat() — 基本对话流程", () => {
    it("chat() 将 user 和 assistant 消息追加到 WorkingMemory", async () => {
      const reply = "AI回复内容";
      const { wm } = wireEngine({ client: createMockClient(reply) });
      const r = await chatEngine.chat({ message: "你好", sessionId: "s-append", userId: "u1" });
      expect(r.response).toBe(reply);
      const h = wm.getMessages("s-append");
      expect(h.some(m => m.role === "user" && m.content === "你好")).toBe(true);
      expect(h.some(m => m.role === "assistant" && m.content === reply)).toBe(true);
    });

    it("chat() 调用 memoryManager.storeInteraction", async () => {
      const mm = createMockMemoryManager();
      wireEngine({ mm, client: createMockClient("ok") });
      await chatEngine.chat({ message: "记住", sessionId: "s-store", userId: "u1" });
      // storeInteraction is called async via .catch() chain, give it a tick
      await new Promise(r => setTimeout(r, 50));
      expect(mm.storeInteraction).toHaveBeenCalled();
    });

    it("chat() 返回 response + sessionId", async () => {
      wireEngine({ client: createMockClient("回复") });
      const r = await chatEngine.chat({ message: "测试", sessionId: "s-ret" });
      expect(r.response).toBe("回复");
      expect(r.sessionId).toBe("s-ret");
    });

    it("chat() 未传 sessionId 时自动使用 default", async () => {
      wireEngine({ client: createMockClient("ok") });
      const r = await chatEngine.chat({ message: "无session" });
      expect(r.sessionId).toBe("default");
    });

    it("chat() LLM 失败时优雅返回错误信息", async () => {
      wireEngine({
        client: {
          chat: { completions: { create: mock(() => Promise.reject(new Error("API失败"))) } },
        } as any,
      });
      const r = await chatEngine.chat({ message: "失败测试", sessionId: "s-err" });
      expect(r).toBeDefined();
      expect(typeof r.response).toBe("string");
      expect(r.response.length).toBeGreaterThan(0);
    });

    it("chat() 在消息数超过压缩阈值时触发自动压缩", async () => {
      const wm = new WorkingMemory({ compressionThreshold: 5 });
      // 预填充消息以超过阈值
      for (let i = 0; i < 10; i++) {
        wm.append("s-comp", { role: i % 2 === 0 ? "user" : "assistant", content: `消息${i}`, timestamp: Date.now() });
      }
      const compressSpy = spyOn(wm, "compress");
      wireEngine({ wm, client: createMockClient("压缩回复") });
      await chatEngine.chat({ message: "触发压缩", sessionId: "s-comp" });
      // chat() appends user + assistant = 12 total, threshold = 5
      // auto-compression should trigger
      expect(compressSpy).toHaveBeenCalled();
    });

    it("chat() 处理 tool_calls 并执行工具", async () => {
      const te = createMockToolExecutor();
      let callCount = 0;
      const mockClient = {
        chat: {
          completions: {
            create: mock(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve({
                  choices: [{
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [{
                        id: "call_1",
                        type: "function",
                        function: { name: "web_search", arguments: '{"query":"天气"}' },
                      }],
                    },
                  }],
                });
              }
              return Promise.resolve({
                choices: [{ message: { role: "assistant", content: "北京晴天" } }],
              });
            }),
          },
        },
      };
      wireEngine({
        te,
        client: mockClient as any,
        tools: [{ type: "function", function: { name: "web_search", description: "搜索" } }],
      });
      const r = await chatEngine.chat({ message: "天气", sessionId: "s-tool" });
      expect(te).toHaveBeenCalled();
      expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(2);
      expect(r.response).toContain("北京");
    });

    it("chat() 工具循环不超过 MAX_STEPS(10)", async () => {
      const te = createMockToolExecutor();
      const alwaysToolClient = {
        chat: {
          completions: {
            create: mock(() =>
              Promise.resolve({
                choices: [{
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }],
                  },
                }],
              })
            ),
          },
        },
      };
      wireEngine({
        te,
        client: alwaysToolClient as any,
        tools: [{ type: "function", function: { name: "t", description: "无限" } }],
      });
      const r = await chatEngine.chat({ message: "loop", sessionId: "s-loop" });
      expect((alwaysToolClient.chat.completions.create as any).mock.calls.length).toBeLessThanOrEqual(11);
      expect(r).toBeDefined();
    });

    it("chat() 调用 memoryManager.recall 获取记忆上下文", async () => {
      const mm = createMockMemoryManager();
      mm.recall.mockImplementation(() =>
        Promise.resolve([{ entry: { content: "火锅" }, score: 0.9 }])
      );
      wireEngine({ mm, client: createMockClient("好的") });
      await chatEngine.chat({ message: "你记得吗", sessionId: "s-recall", userId: "u1" });
      expect(mm.recall).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // parseAndScheduleTask
  // =========================================================================
  describe("parseAndScheduleTask — 任务调度预过滤", () => {
    it("不含任务关键词的消息不触发任务创建", async () => {
      const ts = createMockTaskScheduler();
      wireEngine({ ts, client: createMockClient("普通回复") });
      await chatEngine.chat({ message: "今天天气真好", sessionId: "s-notask" });
      expect(ts.createTask).not.toHaveBeenCalled();
      expect(ts.createOneTimeTask).not.toHaveBeenCalled();
    });

    it("未注入 taskScheduler 时不报错", async () => {
      const wm = new WorkingMemory();
      const mm = createMockMemoryManager();
      chatEngine.setWorkingMemory(wm);
      chatEngine.setMemoryManager(mm as any);
      chatEngine.setTaskScheduler(undefined as any);
      chatEngine.setTools([]);
      (chatEngine as any).client = createMockClient("ok");
      const r = await chatEngine.chat({ message: "提醒我开会", sessionId: "s-nots" });
      expect(r).toBeDefined();
    });
  });

  // =========================================================================
  // 边界情况
  // =========================================================================
  describe("边界情况", () => {
    it("空消息不崩溃", async () => {
      wireEngine({ client: createMockClient("空回复") });
      const r = await chatEngine.chat({ message: "", sessionId: "s-empty" });
      expect(r).toBeDefined();
    });
  });
});
