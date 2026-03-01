import * as Lark from "@larksuiteoapi/node-sdk";
import { chatEngine } from "../chat";

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
}

export interface FeishuMessage {
  msg_type: string;
  content?: any;
}

export interface FeishuUserId {
  union_id?: string;
  open_id?: string;
  user_id?: string;
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
    };

    if (this.isConfigured()) {
      this.initWSClient();
    }
  }

  isConfigured(): boolean {
    return !!(this.config.appId && this.config.appSecret);
  }

  getConfig(): FeishuConfig {
    return this.config;
  }

  verifyToken(token: string): boolean {
    if (!this.config.verificationToken) return true;
    return token === this.config.verificationToken;
  }

  private initWSClient(): void {
    if (!this.config private initWSClient.appId || !this.config.appSecret) return;

    const sdkConfig: Lark.SDKConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Lark.Domain.Feishu,
      appType: Lark.AppType.SelfBuild,
      loggerLevel: Lark.LoggerLevel.debug,
    };

    this.wsClient = new Lark.WSClient({
      ...sdkConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });

    console.log("Initializing Feishu WebSocket client...");

    this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({
        "im.message.receive_v1": this.handleMessage.bind(this),
      }),
      wsConfig: {
        autoReconnect: true,
      },
    });

    console.log("Feishu WebSocket client started");
  }

  private async handleMessage(
    event: Lark.im.message.receive_v1.Event
  ): Promise<void> {
    const message = event.message;
    if (!message || !message.message_id) return;

    const messageType = message.message_type;
    if (messageType !== "text" && messageType !== "post") return;

    let text = "";
    try {
      const content = JSON.parse(message.content || "{}");
      text = content.text || "";
    } catch {
      text = message.content || "";
    }

    if (!text) return;

    const senderId = message.sender?.sender_id;
    const chatId = message.chat_id;
    const sessionId = this.getSessionId(chatId, senderId);

    console.log(
      `Received message from ${senderId?.user_id || senderId?.open_id}: ${text}`
    );

    try {
      const result = await chatEngine.chat({
        message: text,
        sessionId,
      });

      await this.sendMessage(chatId, senderId, result.response);
    } catch (error) {
      console.error("Chat error:", error);
      await this.sendMessage(chatId, senderId, "处理消息失败，请稍后重试");
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

    const client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Lark.Domain.Feishu,
    });

    const resp = await client.auth.v3.tenantAccessToken.internal({
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    });

    if (resp.code !== 0) {
      throw new Error(`Failed to get token: ${resp.msg}`);
    }

    this.tenantAccessToken = resp.data.tenant_access_token;
    this.tokenExpireTime = Date.now() + (resp.data.expire - 300) * 1000;
    return this.tenantAccessToken;
  }

  private async sendMessage(
    chatId: string,
    userId?: Lark.ImMessageSenderId,
    text?: string
  ): Promise<void> {
    if (!text || !this.config.appId || !this.config.appSecret) return;

    const client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Lark.Domain.Feishu,
    });

    try {
      const token = await this.getTenantAccessToken();
      const receiveId = chatId;

      await client.im.v1.messages.create({
        data: {
          receive_id_type: "chat_id",
          msg_type: "text",
          content: JSON.stringify({ text }),
          receive_id: receiveId,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      console.log(`Sent message to ${receiveId}`);
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  }

  async handleEvent(body: any): Promise<any> {
    const event = body as any;

    if (event.schema === "2.0" && event.header?.event_type === "url_verification") {
      return {
        challenge: event.header?.event_id || body.challenge,
      };
    }

    return { success: true };
  }
}

export const feishuBot = new FeishuBot();
