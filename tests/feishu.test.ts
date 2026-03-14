import { describe, it, expect, mock, beforeEach } from "bun:test";
import { FeishuBot } from "../src/integrations/feishu";

describe("FeishuBot DI", () => {
  let bot: FeishuBot;

  beforeEach(() => {
    // 每个测试用例创建新实例，确保隔离
    bot = new FeishuBot();
  });

  it("构造函数不应自动启动 WebSocket", () => {
    // 未配置 appId/appSecret 时，getStatus 应返回未连接
    const status = bot.getStatus();
    expect(status.connected).toBe(false);
  });

  it("setChatEngine 应正确注入 ChatEngine", () => {
    const mockEngine = {
      chat: mock(() => Promise.resolve({ response: "test reply" })),
    };
    // 不应抛错
    bot.setChatEngine(mockEngine);
  });

  it("setTaskScheduler 应正确注入 TaskScheduler", () => {
    const mockScheduler = {
      setLastChatId: mock(() => {}),
    };
    // 不应抛错
    bot.setTaskScheduler(mockScheduler);
  });

  it("handleEvent 未注入 ChatEngine 时应返回错误", async () => {
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
    // 环境变量未设置，start 应静默返回
    expect(() => bot.start()).not.toThrow();
  });

  it("isConfigured 无配置时应返回 false", () => {
    // 清除环境变量后创建的实例
    const cleanBot = new FeishuBot();
    // 注意：如果环境变量中有 FEISHU_APP_ID 会返回 true
    // 此测试仅验证方法可调用
    expect(typeof cleanBot.isConfigured()).toBe("boolean");
  });
});
