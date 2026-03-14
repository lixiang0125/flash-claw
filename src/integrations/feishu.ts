import * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  webhookUrl?: string;
  useLongConnection?: boolean;
}

/**
 * Minimal interface for the ChatEngine dependency.
 * Injected via setChatEngine() — no hard imports.
 */
interface ChatEngineAPI {
  chat(request: { message: string; sessionId: string }): Promise<{ response: string }>;
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

  constructor() {
    this.config = {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      webhookUrl: process.env.FEISHU_WEBHOOK_URL,
      useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION !== "false",
    };

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

  private initWSClient(): void {
    if (!this.config.appId || !this.config.appSecret) return;

    const client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    console.log("Initializing Feishu WebSocket client...");
    console.log("App ID:", this.config.appId);

    (this.wsClient as any).start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          console.log("Feishu: Received message event!");
          console.log("Data:", JSON.stringify(data, null, 2));
          await this.handleMessage(data);
        },
      }),
      wsConfig: {
        autoReconnect: true,
      },
    }).then(() => {
      console.log("Feishu WebSocket client started successfully");
    }).catch((err: any) => {
      console.error("Feishu WebSocket error:", err);
    });
  }

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

    const senderId = message.sender?.sender_id;
    const chatId = message.chat_id;
    const sessionId = this.getSessionId(chatId, senderId);
    const messageId = message.message_id;

    // Record chat ID for task notifications (via DI)
    this.taskSchedulerAPI?.setLastChatId(chatId);

    console.log(
      `Feishu: Processing message from ${senderId?.user_id || senderId?.open_id}: ${text}`
    );

    // Add emoji reaction (no LLM required)
    await this.addReaction(messageId, "face:\u6536\u5230");

    // Background processing
    console.log("Feishu: Setting up background task");
    setTimeout(async () => {
      console.log("Feishu: Background task started");
      try {
        if (!this.chatEngineAPI) {
          console.error("Feishu: ChatEngine not wired \u2014 cannot process message");
          return;
        }
        console.log("Feishu: Calling chatEngine");
        const result = await this.chatEngineAPI.chat({
          message: text,
          sessionId,
        });
        console.log("Feishu: Chat done, response length:", result.response.length);

        console.log("Feishu: Calling sendMessage");
        await this.sendMessage(chatId, senderId, result.response);
        console.log("Feishu: sendMessage completed");
      } catch (error) {
        console.error("Feishu: Chat error:", error);
        const errorResponse = await this.generateErrorResponse(text, error);
        await this.sendMessage(chatId, senderId, errorResponse);
      }
    }, 100);
  }

  private async generateErrorResponse(userMessage: string, error: any): Promise<string> {
    if (!this.chatEngineAPI) {
      return "\u62b1\u6b49\uff0c\u6211\u9047\u5230\u4e86\u4e00\u4e9b\u95ee\u9898\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\uff0c\u6216\u8005\u6362\u4e00\u79cd\u65b9\u5f0f\u63d0\u95ee\u3002";
    }
    try {
      const result = await this.chatEngineAPI.chat({
        message: `\u7528\u6237\u8bf4: "${userMessage}"\n\n\u5904\u7406\u7528\u6237\u8bf7\u6c42\u65f6\u53d1\u751f\u9519\u8bef: ${error.message || error}\n\n\u8bf7\u751f\u6210\u4e00\u4e2a\u53cb\u597d\u7684\u56de\u590d\uff0c\u544a\u77e5\u7528\u6237\u9047\u5230\u4e86\u95ee\u9898\uff0c\u4f46\u4e0d\u8981\u63d0\u5230\u6280\u672f\u7ec6\u8282\u3002\u53ef\u4ee5\u5efa\u8bae\u7528\u6237\u7a0d\u540e\u91cd\u8bd5\u6216\u6362\u4e00\u79cd\u65b9\u5f0f\u63d0\u95ee\u3002`,
        sessionId: "feishu_error_response",
      });
      return result.response;
    } catch {
      return "\u62b1\u6b49\uff0c\u6211\u9047\u5230\u4e86\u4e00\u4e9b\u95ee\u9898\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\uff0c\u6216\u8005\u6362\u4e00\u79cd\u65b9\u5f0f\u63d0\u95ee\u3002";
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
        throw new Error(`\u6dfb\u52a0\u8868\u60c5\u5931\u8d25: ${data.msg}`);
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
      const senderId = message.sender?.sender_id;
      const sessionId = this.getSessionId(chatId, senderId);

      console.log(
        `Feishu (Webhook): Received message from ${senderId?.user_id || senderId?.open_id}: ${text}`
      );

      if (!this.chatEngineAPI) {
        console.error("Feishu: ChatEngine not wired \u2014 cannot process webhook message");
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
        await this.sendMessage(chatId, senderId, "\u5904\u7406\u6d88\u606f\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5");
      }
    }

    return { success: true };
  }

  /**
   * \u83b7\u53d6\u98de\u4e66\u8fde\u63a5\u72b6\u6001
   */
  getStatus(): { connected: boolean; appId?: string } {
    return {
      connected: !!this.wsClient,
      appId: this.config.appId,
    };
  }
}

export const feishuBot = new FeishuBot();
