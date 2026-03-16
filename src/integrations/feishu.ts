import * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuStreamingCard, type StreamingCardSession } from "./feishu-streaming-card";

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  webhookUrl?: string;
  useLongConnection?: boolean;
  /** 是否启用流式卡片输出（默认 true） */
  enableStreaming?: boolean;
  /** 是否在 footer 显示耗时（默认 true） */
  showElapsed?: boolean;
}

/**
 * Minimal interface for the ChatEngine dependency.
 * Injected via setChatEngine() — no hard imports.
 */
interface ChatEngineAPI {
  chat(request: { message: string; sessionId: string }): Promise<{ response: string }>;
  chatStream?(
    request: { message: string; sessionId: string },
    callbacks: {
      onDelta: (delta: string, fullText: string) => void | Promise<void>;
      onDone: (fullText: string) => void | Promise<void>;
      onError?: (error: Error) => void | Promise<void>;
    },
  ): Promise<{ response: string }>;
}

/**
 * Minimal interface for the TaskScheduler dependency.
 * Injected via setTaskScheduler() — no hard imports.
 */
interface TaskSchedulerAPI {
  setLastChatId(chatId: string): void;
}

export class FeishuBot {
  private config: FeishuConfig;
  private wsClient?: Lark.WSClient;
  private tenantAccessToken: string = "";
  private tokenExpireTime: number = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  /* ── DI fields ── */
  private chatEngineAPI: ChatEngineAPI | null = null;
  private taskSchedulerAPI: TaskSchedulerAPI | null = null;

  /* ── 流式卡片管理器 ── */
  private streamingCard: FeishuStreamingCard;

  constructor() {
    this.config = {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      webhookUrl: process.env.FEISHU_WEBHOOK_URL,
      useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION !== "false",
      enableStreaming: process.env.FEISHU_STREAMING !== "false",
      showElapsed: process.env.FEISHU_SHOW_ELAPSED !== "false",
    };

    // 初始化流式卡片管理器，注入 token 获取函数
    this.streamingCard = new FeishuStreamingCard(() => this.getTenantAccessToken());

    // NOTE: No auto-start here. Call start() after DI wiring is complete.
  }

  /* ── DI setters ── */

  setChatEngine(engine: ChatEngineAPI): void {
    this.chatEngineAPI = engine;
    console.log("[FeishuBot] ChatEngine attached");
  }

  setTaskScheduler(scheduler: TaskSchedulerAPI): void {
    this.taskSchedulerAPI = scheduler;
    console.log("[FeishuBot] TaskScheduler attached");
  }

  /**
   * Explicit startup — must be called AFTER setChatEngine / setTaskScheduler.
   * Initialises WebSocket or logs webhook mode.
   */
  start(): void {
    if (!this.isConfigured()) return;

    if (this.config.useLongConnection && this.config.appId && this.config.appSecret) {
      this.initWSClient();
    } else if (this.config.webhookUrl) {
      console.log("Feishu: using Webhook mode");
    }
  }

  isConfigured(): boolean {
    return !!(
      this.config.webhookUrl ||
      (this.config.appId && this.config.appSecret)
    );
  }

  getConfig(): FeishuConfig {
    return {
      ...this.config,
      appSecret: this.config.appSecret ? "***" : undefined,
    };
  }

  verifyToken(token: string): boolean {
    if (!this.config.verificationToken) return true;
    return token === this.config.verificationToken;
  }

  /**
   * 初始化飞书 WebSocket 长连接客户端。
   *
   * 改进说明：
   * 1. SDK 的 start() 是 fire-and-forget，不会 throw 或返回连接状态
   * 2. 通过拦截 SDK 内部 console 日志来判断连接是否成功
   * 3. 外层实现更健壮的重试（5次，指数退避 + 随机抖动，最大60s）
   * 4. 每次重试创建全新 WSClient 实例，避免内部状态残留
   * 5. 所有重试耗尽后启动后台静默重连（每2分钟探测一次）
   */
  private async initWSClient(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) return;

    console.log("Initializing Feishu WebSocket client...");

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 3000;
    const MAX_DELAY_MS = 60000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.wsClient = new Lark.WSClient({
          appId: this.config.appId,
          appSecret: this.config.appSecret,
          loggerLevel: Lark.LoggerLevel.info,
        });

        const connected = await this.startWithTimeout();

        if (connected) {
          console.log("Feishu WebSocket client started successfully");
          return;
        }

        throw new Error("WebSocket connection not established within timeout");
      } catch (err: any) {
        const errMsg = err?.message || String(err);

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000,
            MAX_DELAY_MS,
          );
          console.warn(
            `[FeishuBot] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}. ` +
              `Retrying in ${(delay / 1000).toFixed(1)}s...`,
          );
          await new Promise((r) => setTimeout(r, delay));
        } else {
          console.error(
            `[FeishuBot] Failed after ${MAX_RETRIES} attempts. Last error: ${errMsg}. ` +
              "The bot will operate without real-time event subscription.",
          );
          this.scheduleBackgroundReconnect();
        }
      }
    }
  }

  /**
   * 带超时检测的 WSClient 启动。
   * SDK 的 start() 方法内部会打印 "ws client ready"，
   * 通过拦截 console.info 来检测连接是否完成。
   */
  private startWithTimeout(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const TIMEOUT_MS = 25000;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      }, TIMEOUT_MS);

      const origInfo = console.info;

      const cleanup = () => {
        console.info = origInfo;
        clearTimeout(timer);
      };

      console.info = (...args: any[]) => {
        origInfo.apply(console, args);
        const msg = args.map(String).join(" ");
        if (msg.includes("ws client ready") && !settled) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };

      (this.wsClient as any).start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          "im.message.receive_v1": async (data: any) => {
            console.log("Feishu: Received message event!");
            console.log("Data:", JSON.stringify(data, null, 2));
            await this.handleMessage(data);
          },
        }),
      });
    });
  }

  /**
   * 后台静默重连：初始重试耗尽后，每2分钟探测飞书 endpoint
   * 可用性并尝试重新建立连接。
   */
  private scheduleBackgroundReconnect(): void {
    const INTERVAL_MS = 120_000;
    console.log("[FeishuBot] Scheduling background reconnect every 2 minutes...");

    const intervalId = setInterval(async () => {
      try {
        if (!this.config.appId || !this.config.appSecret) return;

        const resp = await fetch("https://open.feishu.cn/callback/ws/endpoint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            AppID: this.config.appId,
            AppSecret: this.config.appSecret,
          }),
        });
        const data = await resp.json() as any;

        if (data.code !== 0) {
          console.log(`[FeishuBot] Background probe: code ${data.code}, skipping`);
          return;
        }

        console.log("[FeishuBot] Server available, attempting reconnect...");
        this.wsClient = new Lark.WSClient({
          appId: this.config.appId,
          appSecret: this.config.appSecret,
          loggerLevel: Lark.LoggerLevel.info,
        });

        const connected = await this.startWithTimeout();
        if (connected) {
          console.log("[FeishuBot] Background reconnect successful!");
          clearInterval(intervalId);
        }
      } catch (err: any) {
        console.log(`[FeishuBot] Background reconnect failed: ${err?.message || err}`);
      }
    }, INTERVAL_MS);
  }


  /**
   * 处理收到的飞书消息。
   *
   * 核心改进：支持流式卡片输出
   * 1. 创建 CardKit 流式卡片并发送
   * 2. 调用 ChatEngine.chatStream() 流式获取 LLM 输出
   * 3. 实时将文本 delta 推送到卡片
   * 4. 完成后关闭流式模式，显示耗时 footer
   * 5. 如果流式不可用，降级为非流式模式
   */
  private async handleMessage(event: any): Promise<void> {
    console.log("Feishu: Received event:", JSON.stringify(event));

    const message = event.message;
    if (!message || !message.message_id) {
      console.log("Feishu: No message or message_id in event");
      return;
    }

    const messageType = message.message_type;
    console.log("Feishu: Message type:", messageType);

    if (messageType !== "text" && messageType !== "post") {
      console.log("Feishu: Ignoring non-text message type");
      return;
    }

    let text = "";
    try {
      const content = JSON.parse(message.content || "{}");
      text = content.text || "";
    } catch {
      text = message.content || "";
    }

    console.log("Feishu: Message text:", text);

    if (!text) {
      console.log("Feishu: Empty text, ignoring");
      return;
    }

    const senderId = event.sender?.sender_id || message.sender?.sender_id;
    const chatId = message.chat_id;
    const sessionId = this.getSessionId(chatId, senderId);
    const messageId = message.message_id;

    // Record chat ID for task notifications (via DI)
    this.taskSchedulerAPI?.setLastChatId(chatId);

    console.log(
      `Feishu: Processing message from ${senderId?.user_id || senderId?.open_id}: ${text}`
    );

    // Add emoji reaction (no LLM required)
    await this.addReaction(messageId, "THUMBSUP");

    // Background processing
    console.log("Feishu: Setting up background task");
    setTimeout(async () => {
      console.log("Feishu: Background task started");
      try {
        if (!this.chatEngineAPI) {
          console.error("Feishu: ChatEngine 未注入，无法处理消息");
          return;
        }

        // 判断是否使用流式卡片
        const useStreaming =
          this.config.enableStreaming &&
          typeof this.chatEngineAPI.chatStream === "function";

        if (useStreaming) {
          await this.handleMessageStreaming(chatId, text, sessionId);
        } else {
          await this.handleMessageNonStreaming(chatId, senderId, text, sessionId);
        }
      } catch (error) {
        console.error("Feishu: Chat error:", error);
        const errorResponse = await this.generateErrorResponse(text, error);
        await this.sendMessage(chatId, senderId, errorResponse);
      }
    }, 100);
  }

  /**
   * 流式模式处理消息：
   * 1. 创建流式卡片 → 2. 流式推送 LLM 输出 → 3. finalize 显示耗时
   */
  private async handleMessageStreaming(
    chatId: string,
    text: string,
    sessionId: string,
  ): Promise<void> {
    let cardSession: StreamingCardSession | null = null;
    const t0 = Date.now();

    try {
      // Step 1: 创建流式卡片
      const tCard = Date.now();
      cardSession = await this.streamingCard.create(chatId, {
        title: "🤖 FlashClaw",
        headerTemplate: "blue",
        finishTitle: "🤖 FlashClaw",
        finishTemplate: "green",
        showElapsed: this.config.showElapsed,
        subtitle: "正在思考...",
      });
      console.log(`[FeishuBot] ⏱ card create=${Date.now() - tCard}ms, mode=${cardSession.mode}`);

      // Step 2: 流式调用 ChatEngine
      const tStream = Date.now();
      const result = await this.chatEngineAPI!.chatStream!(
        { message: text, sessionId },
        {
          onDelta: async (_delta: string, fullText: string) => {
            if (cardSession) {
              await this.streamingCard.pushText(cardSession, fullText);
            }
          },
          onDone: async (fullText: string) => {
            console.log(`[FeishuBot] ⏱ stream done=${Date.now() - tStream}ms, chars=${fullText.length}`);
          },
          onError: async (error: Error) => {
            console.error("[FeishuBot] Stream error:", error.message);
          },
        },
      );

      // Step 3: Finalize
      const tFinal = Date.now();
      if (cardSession) {
        await this.streamingCard.finalize(cardSession, result.response);
      }
      console.log(`[FeishuBot] ⏱ finalize=${Date.now() - tFinal}ms`);
      console.log(`[FeishuBot] ⏱ E2E TOTAL=${Date.now() - t0}ms | card=${Date.now() - tCard - (Date.now() - tStream)}ms`);
    } catch (error: any) {
      console.error("[FeishuBot] Streaming failed:", error.message);
      if (cardSession && !cardSession.closed) {
        try {
          await this.streamingCard.finalize(
            cardSession,
            `⚠️ 处理遇到问题，请稍后重试。\n\n错误：${error.message}`,
          );
        } catch {
          await this.sendViaAPI(chatId, "抱歉，处理消息时遇到问题，请稍后重试。");
        }
      } else {
        await this.sendViaAPI(chatId, "抱歉，处理消息时遇到问题，请稍后重试。");
      }
    }
  }


  /**
   * 非流式模式处理消息（降级方案）。
   */
  private async handleMessageNonStreaming(
    chatId: string,
    senderId: any,
    text: string,
    sessionId: string,
  ): Promise<void> {
    console.log("[FeishuBot] Using non-streaming mode");
    const startTime = Date.now();

    const result = await this.chatEngineAPI!.chat({
      message: text,
      sessionId,
    });

    const elapsed = Date.now() - startTime;
    const elapsedStr = elapsed < 1000
      ? `${elapsed}ms`
      : `${(elapsed / 1000).toFixed(1)}s`;

    // 非流式模式：添加耗时到回复末尾
    let reply = result.response;
    if (this.config.showElapsed) {
      reply += `\n\n---\n⏱ 耗时 ${elapsedStr}`;
    }

    console.log("Feishu: Chat done, response length:", result.response.length);
    await this.sendMessage(chatId, senderId, reply);
    console.log("Feishu: sendMessage completed");
  }

  private async generateErrorResponse(userMessage: string, error: any): Promise<string> {
    if (!this.chatEngineAPI) {
      return "抱歉，我遇到了一些问题。请稍后重试，或者换一种方式提问。";
    }
    try {
      const result = await this.chatEngineAPI.chat({
        message: `用户说: "${userMessage}"\n\n处理用户请求时发生错误: ${error.message || error}\n\n请生成一个友好的回复，告知用户遇到了问题，但不要提到技术细节。可以建议用户稍后重试或换一种方式提问。`,
        sessionId: "feishu_error_response",
      });
      return result.response;
    } catch {
      return "抱歉，我遇到了一些问题。请稍后重试，或者换一种方式提问。";
    }
  }

  private getSessionId(chatId: string, userId?: any): string {
    const userIdStr =
      userId?.user_id || userId?.open_id || userId?.union_id || "unknown";
    return `feishu_${chatId}_${userIdStr}`;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (
      this.tenantAccessToken &&
      Date.now() < this.tokenExpireTime
    ) {
      return this.tenantAccessToken;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("Feishu app credentials not configured");
    }

    this.tokenRefreshPromise = this.refreshToken().finally(() => {
      this.tokenRefreshPromise = null;
    });

    return this.tokenRefreshPromise;
  }

  private async refreshToken(): Promise<string> {
    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      }
    );

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`Failed to get token: ${data.msg}`);
    }

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
    return this.tenantAccessToken;
  }

  async sendMessage(
    chatId: string,
    userId?: any,
    text?: string
  ): Promise<void> {
    if (!text) return;

    console.log("Feishu: sendMessage called, chatId:", chatId, "text length:", text?.length);

    if (this.config.webhookUrl) {
      console.log("Feishu: Using webhook mode");
      await this.sendViaWebhook(text);
    } else if (this.config.appId && this.config.appSecret) {
      console.log("Feishu: Using API mode");
      await this.sendViaAPI(chatId, text);
    } else {
      console.log("Feishu: Not configured for sending");
    }
  }

  async notify(chatId: string, text: string): Promise<void> {
    await this.sendMessage(chatId, undefined, text);
  }

  private async addReaction(messageId: string, emojiType: string): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) return;

    try {
      const token = await this.getTenantAccessToken();

      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: emojiType,
          },
        }),
      });

      const text = await response.text();
      console.log(`Feishu: Reaction response: ${text}`);

      const data = JSON.parse(text);

      if (data.code !== 0) {
        throw new Error(`添加表情失败: ${data.msg}`);
      }

      console.log(`Feishu: Added ${emojiType} reaction to message ${messageId}`);
    } catch (error: any) {
      console.error(`Feishu: Failed to add reaction:`, error.message || error);
    }
  }

  private async sendViaWebhook(text: string): Promise<void> {
    if (!this.config.webhookUrl) return;

    await fetch(this.config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text },
      }),
    });
  }

  private async sendViaAPI(chatId: string, text: string): Promise<void> {
    console.log("Feishu: sendViaAPI called, chatId:", chatId);
    if (!this.config.appId || !this.config.appSecret) {
      console.log("Feishu: No appId or appSecret");
      return;
    }

    try {
      console.log("Feishu: Getting token...");
      const token = await this.getTenantAccessToken();
      console.log("Feishu: Token:", token?.substring(0, 20) + "...");

      console.log("Feishu: Creating client...");
      const client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: Lark.Domain.Lark,
        disableTokenCache: true,
      });
      console.log("Feishu: Client created");

      console.log("Feishu: Calling message.create...");
      const result = await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      }, Lark.withTenantToken(token));
      console.log("Feishu: Send result:", JSON.stringify(result));

      if (result.code !== 0) {
        console.error("Feishu: Send message failed:", result.msg);
      } else {
        console.log(`Feishu: Sent message to ${chatId}`);
      }
    } catch (error: any) {
      console.error("Feishu: Failed to send message:", error.message || error);
      if (error.response) {
        console.error("Feishu: Response data:", error.response.data);
      }
    }
  }

  async handleEvent(body: any): Promise<any> {
    const event = body as any;

    if (event.schema === "2.0" && event.header?.event_type === "url_verification") {
      return {
        challenge: event.header?.event_id || body.challenge,
      };
    }

    if (event.header?.event_type === "url_verification") {
      return {
        challenge: body.challenge,
      };
    }

    if (event.type === "message" || event.event?.message) {
      const message = event.event?.message || event.message;
      if (!message) return { success: true };

      let text = "";
      try {
        const content = JSON.parse(message.content || "{}");
        text = content.text || "";
      } catch {
        text = message.content || "";
      }

      if (!text) return { success: true };

      const chatId = message.chat_id;
      const senderId = event.sender?.sender_id || message.sender?.sender_id;
      const sessionId = this.getSessionId(chatId, senderId);

      console.log(
        `Feishu (Webhook): Received message from ${senderId?.user_id || senderId?.open_id}: ${text}`
      );

      if (!this.chatEngineAPI) {
        console.error("Feishu: ChatEngine 未注入，无法处理 Webhook 消息");
        return { success: false, error: "ChatEngine not available" };
      }

      try {
        const result = await this.chatEngineAPI.chat({
          message: text,
          sessionId,
        });

        await this.sendMessage(chatId, senderId, result.response);
      } catch (error) {
        console.error("Feishu: Chat error:", error);
        await this.sendMessage(chatId, senderId, "处理消息失败，请稍后重试");
      }
    }

    return { success: true };
  }

  /**
   * 获取飞书连接状态
   */
  getStatus(): { connected: boolean; appId?: string; streaming: boolean } {
    return {
      connected: !!this.wsClient,
      appId: this.config.appId,
      streaming: !!this.config.enableStreaming,
    };
  }
}
