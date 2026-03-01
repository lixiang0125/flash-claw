import * as Lark from "@larksuiteoapi/node-sdk";
import { chatEngine } from "../chat";
import { taskScheduler } from "../tasks";

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  webhookUrl?: string;
  useLongConnection?: boolean;
}

export class FeishuBot {
  private config: FeishuConfig;
  private wsClient?: Lark.WSClient;
  private tenantAccessToken: string = "";
  private tokenExpireTime: number = 0;

  constructor() {
    this.config = {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      webhookUrl: process.env.FEISHU_WEBHOOK_URL,
      useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION !== "false",
    };

    if (this.isConfigured()) {
      if (this.config.useLongConnection && this.config.appId && this.config.appSecret) {
        this.initWSClient();
      } else if (this.config.webhookUrl) {
        console.log("Feishu: using Webhook mode");
      }
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

    const sdkConfig: Lark.SDKConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Lark.Domain.Feishu,
      appType: Lark.AppType.SelfBuild,
    };

    this.wsClient = new Lark.WSClient({
      ...sdkConfig,
      loggerLevel: Lark.LoggerLevel.debug,
    });

    console.log("Initializing Feishu WebSocket client...");
    console.log("App ID:", this.config.appId);

    // 使用正确的事件分发器格式
    const eventDispatcher = new Lark.EventDispatcher({});
    
    // 直接在 start 方法中注册
    this.wsClient.start({
      eventDispatcher: eventDispatcher.register({
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

  private async handleMessage(
    event: any
  ): Promise<void> {
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

    // 记录聊天 ID，用于任务提醒
    taskScheduler.setLastChatId(chatId);

    console.log(
      `Feishu: Processing message from ${senderId?.user_id || senderId?.open_id}: ${text}`
    );

    // 添加 emoji reaction 表示已收到消息（无需 LLM）
    await this.addReaction(messageId, "face:收到");

    // 后台处理实际请求
    setTimeout(async () => {
      try {
        const result = await chatEngine.chat({
          message: text,
          sessionId,
        });

        await this.sendMessage(chatId, senderId, result.response);
      } catch (error) {
        console.error("Feishu: Chat error:", error);
        const errorResponse = await this.generateErrorResponse(text, error);
        await this.sendMessage(chatId, senderId, errorResponse);
      }
    }, 100);
  }

  private async generateErrorResponse(userMessage: string, error: any): Promise<string> {
    try {
      const result = await chatEngine.chat({
        message: `用户说: "${userMessage}"

处理用户请求时发生错误: ${error.message || error}

请生成一个友好的回复，告知用户遇到了问题，但不要提到技术细节。可以建议用户稍后重试或换一种方式提问。`,
        sessionId: "feishu_error_response",
      });
      return result.response;
    } catch {
      return "抱歉，我遇到了一些问题。请稍后重试，或者换一种方式提问。";
    }
  }

  private getSessionId(chatId: string, userId?: Lark.ImMessageSenderId): string {
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

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("Feishu app credentials not configured");
    }

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

  private async sendMessage(
    chatId: string,
    userId?: Lark.ImMessageSenderId,
    text?: string
  ): Promise<void> {
    if (!text) return;

    if (this.config.webhookUrl) {
      await this.sendViaWebhook(text);
    } else if (this.config.appId && this.config.appSecret) {
      await this.sendViaAPI(chatId, text);
    }
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
    if (!this.config.appId || !this.config.appSecret) return;

    try {
      const token = await this.getTenantAccessToken();

      const client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain: Lark.Domain.Feishu,
      });

      const result = await client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      console.log("Feishu: Send result:", JSON.stringify(result));
      
      if (result.code !== 0) {
        console.error("Feishu: Send message failed:", result.msg);
      } else {
        console.log(`Feishu: Sent message to ${chatId}`);
      }
    } catch (error) {
      console.error("Feishu: Failed to send message:", error);
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

      try {
        const result = await chatEngine.chat({
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
}

export const feishuBot = new FeishuBot();
