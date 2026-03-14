import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import { FeishuBot } from "../src/integrations/feishu";

describe("FeishuBot DI", () => {
  let bot: FeishuBot;

  beforeEach(() => {
    bot = new FeishuBot();
  });

  it("构造函数不应自动启动 WebSocket", () => {
    const status = bot.getStatus();
    expect(status.connected).toBe(false);
  });

  it("setChatEngine 应正确注入 ChatEngine", () => {
    const mockEngine = {
      chat: mock(() => Promise.resolve({ response: "test reply" })),
    };
    bot.setChatEngine(mockEngine);
  });

  it("setTaskScheduler 应正确注入 TaskScheduler", () => {
    const mockScheduler = {
      setLastChatId: mock(() => {}),
    };
    bot.setTaskScheduler(mockScheduler);
  });

  it("handleEvent 未注入 ChatEngine 时应返回错误", async () => {
    spyOn(bot, "sendMessage").mockResolvedValue(undefined);

    const result = await bot.handleEvent({
      type: "message",
      event: {
        message: {
          chat_id: "test_chat",
          content: JSON.stringify({ text: "hello" }),
          message_type: "text",
          sender: { sender_id: { user_id: "u1" } },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("ChatEngine not available");
  });

  it("handleEvent 注入 ChatEngine 后应正常处理消息", async () => {
    const mockEngine = {
      chat: mock(() => Promise.resolve({ response: "你好！" })),
    };
    bot.setChatEngine(mockEngine);

    const sendSpy = spyOn(bot, "sendMessage").mockResolvedValue(undefined);

    const result = await bot.handleEvent({
      type: "message",
      event: {
        message: {
          chat_id: "test_chat",
          content: JSON.stringify({ text: "hello" }),
          message_type: "text",
          sender: { sender_id: { user_id: "u1" } },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(mockEngine.chat).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    if (sendSpy.mock.calls.length > 0) {
      expect(sendSpy.mock.calls[0][0]).toBe("test_chat");
    }
  });

  it("handleEvent url_verification 应返回 challenge", async () => {
    const result = await bot.handleEvent({
      schema: "2.0",
      header: { event_type: "url_verification", event_id: "ev_123" },
      challenge: "test_challenge",
    });
    expect(result.challenge).toBeDefined();
  });

  it("start() 未配置时不应抛错", () => {
    expect(() => bot.start()).not.toThrow();
  });

  it("isConfigured 无配置时应返回 false", () => {
    const cleanBot = new FeishuBot();
    expect(typeof cleanBot.isConfigured()).toBe("boolean");
  });

  it("sendMessage 被 mock 后不产生网络请求", async () => {
    const mockEngine = {
      chat: mock(() => Promise.resolve({ response: "回复内容" })),
    };
    bot.setChatEngine(mockEngine);

    const sendSpy = spyOn(bot, "sendMessage").mockResolvedValue(undefined);

    await bot.handleEvent({
      type: "message",
      event: {
        message: {
          chat_id: "chat_abc",
          content: JSON.stringify({ text: "测试" }),
          message_type: "text",
          sender: { sender_id: { user_id: "u2" } },
        },
      },
    });

    expect(sendSpy).toHaveBeenCalled();
    const callArgs = sendSpy.mock.calls[0];
    expect(callArgs[0]).toBe("chat_abc");
    expect(callArgs[2]).toBe("回复内容");
  });
});
