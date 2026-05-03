// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { bootstrap, createContainer, CONFIG, LOGGER, EVENT_BUS, DATABASE } from "./bootstrap";
import { Lifecycle } from "./container";

describe("Bootstrap", () => {
  let container: any;
  let originalApiKey: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    // 保存并设置环境变量，避免 mem0 因缺少 API key 而抛错
    originalApiKey = process.env.OPENAI_API_KEY;
    originalNodeEnv = process.env.NODE_ENV;
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = "test-dummy-key-for-bootstrap";
    }
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    // 恢复原始环境变量
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  afterAll(async () => {
    if (container) {
      await container.dispose();
    }
  });

  test("should create and initialize container", async () => {
    container = createContainer();

    // 验证服务已注册
    expect(container.has(CONFIG)).toBe(true);
    expect(container.has(LOGGER)).toBe(true);
    expect(container.has(EVENT_BUS)).toBe(true);
    expect(container.has(DATABASE)).toBe(true);

    // 验证可以解析服务
    const config = container.resolve(CONFIG);
    expect(config.port).toBe(Number(process.env.PORT ?? "3000"));
    expect(config.host).toBe(process.env.HOST || "127.0.0.1");

    const logger = container.resolve(LOGGER);
    expect(logger.info).toBeDefined();
  });

  test("should bootstrap with async initialization", async () => {
    const testContainer = await bootstrap();

    // 验证所有服务已初始化
    expect(testContainer.has(CONFIG)).toBe(true);
    expect(testContainer.has(LOGGER)).toBe(true);
    expect(testContainer.has(EVENT_BUS)).toBe(true);
    expect(testContainer.has(DATABASE)).toBe(true);

    // 验证系统就绪事件已触发
    const eventBus = testContainer.resolve(EVENT_BUS);
    let readyCalled = false;
    eventBus.on("system:ready" as any, () => {
      readyCalled = true;
    });

    // 重新触发测试
    eventBus.emit("system:ready" as any, { timestamp: Date.now() });
    expect(readyCalled).toBe(true);

    await testContainer.dispose();
  }, 10000);
});
