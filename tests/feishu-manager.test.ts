import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { FeishuBot } from "../src/integrations/feishu";
import { FeishuBotManager, readFeishuManagerConfigFromEnv } from "../src/integrations/feishu-manager";

const FEISHU_ENV_KEYS = [
  "FEISHU_BOTS",
  "FEISHU_DEFAULT_BOT_ID",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_WEBHOOK_URL",
  "FEISHU_USE_LONG_CONNECTION",
  "FEISHU_STREAMING",
  "FEISHU_SHOW_ELAPSED",
] as const;

const originalEnv = new Map<string, string | undefined>();

function getBotMap(manager: FeishuBotManager): Map<string, FeishuBot> {
  return (manager as unknown as { bots: Map<string, FeishuBot> }).bots;
}

beforeEach(() => {
  for (const key of FEISHU_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of FEISHU_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe("FeishuBotManager", () => {
  it("兼容 legacy 单机器人环境变量", () => {
    process.env.FEISHU_APP_ID = "cli_legacy";
    process.env.FEISHU_APP_SECRET = "secret_legacy";
    process.env.FEISHU_USE_LONG_CONNECTION = "false";

    const config = readFeishuManagerConfigFromEnv(process.env);
    expect(config.defaultBotId).toBe("default");
    expect(config.bots).toHaveLength(1);
    expect(config.bots[0]?.id).toBe("default");
    expect(config.bots[0]?.appId).toBe("cli_legacy");
  });

  it("按显式 connectorId 分发到目标 bot", async () => {
    const manager = new FeishuBotManager({
      defaultBotId: "alpha",
      bots: [
        { id: "alpha", appId: "cli_alpha", appSecret: "secret_alpha", useLongConnection: false },
        { id: "beta", appId: "cli_beta", appSecret: "secret_beta", useLongConnection: false },
      ],
    });

    const bots = getBotMap(manager);
    const alpha = bots.get("alpha");
    const beta = bots.get("beta");

    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    const alphaSpy = spyOn(alpha!, "handleEvent").mockResolvedValue({ success: true, routed: "alpha" });
    const betaSpy = spyOn(beta!, "handleEvent").mockResolvedValue({ success: true, routed: "beta" });

    const result = await manager.handleEvent({ type: "message" }, { connectorId: "beta" });

    expect(betaSpy).toHaveBeenCalledTimes(1);
    expect(alphaSpy).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ success: true, routed: "beta" });
  });

  it("可按 header.app_id 自动识别 bot", async () => {
    const manager = new FeishuBotManager({
      defaultBotId: "alpha",
      bots: [
        { id: "alpha", appId: "cli_alpha", appSecret: "secret_alpha", useLongConnection: false },
        { id: "beta", appId: "cli_beta", appSecret: "secret_beta", useLongConnection: false },
      ],
    });

    const bots = getBotMap(manager);
    const alpha = bots.get("alpha");
    const beta = bots.get("beta");

    const alphaSpy = spyOn(alpha!, "handleEvent").mockResolvedValue({ success: true, routed: "alpha" });
    const betaSpy = spyOn(beta!, "handleEvent").mockResolvedValue({ success: true, routed: "beta" });

    const result = await manager.handleEvent({
      schema: "2.0",
      header: {
        app_id: "cli_beta",
      },
    });

    expect(betaSpy).toHaveBeenCalledTimes(1);
    expect(alphaSpy).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ success: true, routed: "beta" });
  });

  it("notifyTarget 应路由到对应 connector", async () => {
    const manager = new FeishuBotManager({
      defaultBotId: "alpha",
      bots: [
        { id: "alpha", appId: "cli_alpha", appSecret: "secret_alpha", useLongConnection: false },
        { id: "beta", appId: "cli_beta", appSecret: "secret_beta", useLongConnection: false },
      ],
    });

    const bots = getBotMap(manager);
    const alphaSpy = spyOn(bots.get("alpha")!, "notify").mockResolvedValue(undefined);
    const betaSpy = spyOn(bots.get("beta")!, "notify").mockResolvedValue(undefined);

    await manager.notifyTarget(
      {
        platform: "feishu",
        connectorId: "beta",
        chatId: "chat_beta",
      },
      "hello",
    );

    expect(betaSpy).toHaveBeenCalledWith("chat_beta", "hello");
    expect(alphaSpy).toHaveBeenCalledTimes(0);
  });
});
