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
import { FeishuBot } from "../src/integrations/feishu";
import { chatEngine } from "../src/chat/engine";

// ============================================================================
// 集成测试 — DI 链路验证
// ============================================================================
// 模拟 bootstrap 中的组装流程:
//   WorkingMemory → ChatEngine → FeishuBot / TaskScheduler
// 使用真实 WorkingMemory + FeishuBot, mock OpenAI client
// sendMessage 被 spyOn 拦截，消除所有网络依赖
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

function createMockOpenAIClient(replyText: string) {
  return {
    chat: {
      completions: {
        create: mock(() =>
          Promise.resolve({
            choices: [{ message: { role: "assistant", content: replyText } }],
          })
        ),
      },
    },
  };
}

function createFeishuMessageEvent(
  text: string,
  chatId: string = "chat_001",
  userId: string = "user_001"
) {
  return {
    type: "message",
    event: {
      message: {
        chat_id: chatId,
        content: JSON.stringify({ text }),
        message_type: "text",
        sender: { sender_id: { user_id: userId } },
      },
    },
  };
}

/** 将 chatEngine 单例完整装配好 (模拟 bootstrap) */
function wireAll(replyText: string = "模拟回复") {
  const wm = new WorkingMemory();
  const mm = createMockMemoryManager();
  const mockClient = createMockOpenAIClient(replyText);

  chatEngine.setWorkingMemory(wm);
  chatEngine.setMemoryManager(mm as any);
  chatEngine.setTools([]);
  chatEngine.setToolExecutor(async () => ({ result: null }));
  (chatEngine as any).client = mockClient;

  const fb = new FeishuBot();
  fb.setChatEngine(chatEngine as any);

  // 关键: mock sendMessage 消除真实 HTTP 请求（飞书 API 400 错误）
  const sendMessageSpy = spyOn(fb, "sendMessage").mockResolvedValue(undefined);

  const mockTaskScheduler = {
    setLastChatId: mock(() => {}),
    createTask: mock(() => ({})),
    createOneTimeTask: mock(() => ({})),
  };
  fb.setTaskScheduler(mockTaskScheduler as any);
  chatEngine.setTaskScheduler(mockTaskScheduler as any);

  return { wm, mm, mockClient, fb, mockTaskScheduler, sendMessageSpy };
}

// ===========================================================================
// 测试
// ===========================================================================

describe("集成测试 — DI 链路验证", () => {

  beforeEach(() => {
    // 重置单例状态
    chatEngine.setWorkingMemory(undefined as any);
    chatEngine.setMemoryManager(undefined as any);
    chatEngine.setTaskScheduler(undefined as any);
    chatEngine.setToolExecutor(undefined as any);
    chatEngine.setTools([]);
    (chatEngine as any).sessionSkills?.clear?.();
  });

  // =========================================================================
  // bootstrap 模拟
  // =========================================================================
  describe("bootstrap 模拟: 手动组装 DI 链路", () => {
    it("所有组件正确创建并互相引用", () => {
      const { wm, fb } = wireAll();
      expect(wm).toBeInstanceOf(WorkingMemory);
      expect(fb).toBeInstanceOf(FeishuBot);
      expect((fb as any).chatEngineAPI).toBeDefined();
    });
  });

  // =========================================================================
  // WorkingMemory → ChatEngine
  // =========================================================================
  describe("WorkingMemory → ChatEngine 数据流", () => {
    it("chat() 后 user 和 assistant 消息写入 WorkingMemory", async () => {
      const { wm } = wireAll("你好世界");
      const r = await chatEngine.chat({ message: "测试消息", sessionId: "int-s1", userId: "u1" });
      expect(r.response).toBe("你好世界");
      const h = wm.getMessages("int-s1");
      expect(h.some(m => m.role === "user" && m.content === "测试消息")).toBe(true);
      expect(h.some(m => m.role === "assistant" && m.content === "你好世界")).toBe(true);
    });

    it("连续 chat() 调用携带历史上下文发送给 OpenAI", async () => {
      const { wm, mockClient } = wireAll("第二次回复");
      wm.append("int-s2", { role: "user", content: "第一轮问题", timestamp: Date.now() });
      wm.append("int-s2", { role: "assistant", content: "第一轮回答", timestamp: Date.now() });

      await chatEngine.chat({ message: "第二轮问题", sessionId: "int-s2" });

      expect(mockClient.chat.completions.create).toHaveBeenCalled();
      const calls = (mockClient.chat.completions.create as any).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCallArgs = calls[0];
      const msgs = firstCallArgs[0]?.messages;
      if (msgs) {
        expect(msgs.length).toBeGreaterThanOrEqual(4);
      }
    });

    it("clearSession 清除 WorkingMemory 中的会话", async () => {
      const { wm } = wireAll("回复");
      await chatEngine.chat({ message: "消息", sessionId: "int-s3" });
      expect(wm.getMessages("int-s3").length).toBeGreaterThan(0);
      await chatEngine.clearSession("int-s3");
      expect(wm.getMessages("int-s3").length).toBe(0);
    });
  });

  // =========================================================================
  // FeishuBot → ChatEngine
  // =========================================================================
  describe("FeishuBot → ChatEngine 消息路由", () => {
    it("飞书消息事件通过 chatEngine 处理并返回回复", async () => {
      const { fb, sendMessageSpy } = wireAll("AI回复");
      const event = createFeishuMessageEvent("你好");
      const res = await fb.handleEvent(event);
      expect(res.success).toBe(true);
      // 验证 sendMessage 被调用（而非真实 HTTP 请求）
      expect(sendMessageSpy).toHaveBeenCalled();
    });

    it("飞书 sendMessage 收到正确的回复文本", async () => {
      const { fb, sendMessageSpy } = wireAll("测试回复内容");
      await fb.handleEvent(createFeishuMessageEvent("问题", "chat_x"));
      const callArgs = sendMessageSpy.mock.calls[0];
      // sendMessage(chatId, userId, text)
      expect(callArgs[0]).toBe("chat_x");
      expect(callArgs[2]).toBe("测试回复内容");
    });

    it("未注入 ChatEngine 的 FeishuBot 返回错误", async () => {
      const fb = new FeishuBot();
      const sendSpy = spyOn(fb, "sendMessage").mockResolvedValue(undefined);
      const event = createFeishuMessageEvent("你好");
      const res = await fb.handleEvent(event);
      expect(res.success).toBe(false);
    });

    it("URL 验证事件正确返回 challenge", async () => {
      const { fb } = wireAll();
      const res = await fb.handleEvent({
        schema: "2.0",
        header: { event_type: "url_verification", event_id: "ev_1" },
        challenge: "test_challenge",
      });
      expect(res.challenge).toBeDefined();
    });
  });

  // =========================================================================
  // 完整 E2E 模拟
  // =========================================================================
  describe("完整 E2E 模拟: 消息 → 飞书 → 引擎 → 记忆", () => {
    it("完整消息流: 飞书事件 → ChatEngine → WorkingMemory 更新", async () => {
      const { fb, wm, mm, sendMessageSpy } = wireAll("你好!我是AI助手");
      const event = createFeishuMessageEvent("请介绍自己", "chat_e2e", "user_x");
      const res = await fb.handleEvent(event);

      expect(res.success).toBe(true);
      expect(sendMessageSpy).toHaveBeenCalled();
      await new Promise(r => setTimeout(r, 50));
      expect(mm.storeInteraction).toHaveBeenCalled();
    });

    it("多轮对话: 连续飞书消息构建完整历史", async () => {
      const { fb, wm, sendMessageSpy } = wireAll("第一轮AI回复");
      const chatId = "chat_multi";

      await fb.handleEvent(createFeishuMessageEvent("第一个问题", chatId));
      (chatEngine as any).client = createMockOpenAIClient("第二轮AI回复");
      const res2 = await fb.handleEvent(createFeishuMessageEvent("第二个问题", chatId));
      expect(res2.success).toBe(true);
      // sendMessage 应被调用 2 次（每轮各一次）
      expect(sendMessageSpy.mock.calls.length).toBe(2);
    });

    it("多会话隔离: 不同 chatId 互不干扰", async () => {
      const { fb, wm, sendMessageSpy } = wireAll("回复A");
      await fb.handleEvent(createFeishuMessageEvent("问题A", "chat_a", "user_a"));

      (chatEngine as any).client = createMockOpenAIClient("回复B");
      await fb.handleEvent(createFeishuMessageEvent("问题B", "chat_b", "user_b"));

      expect(wm.activeSessionCount).toBeGreaterThanOrEqual(2);
      expect(sendMessageSpy.mock.calls.length).toBe(2);
    });

    it("任务相关消息带关键词时 chatEngine 检测但不崩溃", async () => {
      const { fb, sendMessageSpy } = wireAll("好的，已创建提醒");
      const event = createFeishuMessageEvent("提醒我明天下午开会", "chat_task");
      const res = await fb.handleEvent(event);
      expect(res.success).toBe(true);
      expect(sendMessageSpy).toHaveBeenCalled();
    });
  });
});
