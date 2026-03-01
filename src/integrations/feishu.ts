import { chatEngine } from "../chat";

/**
 * 飞书消息类型
 */
export interface FeishuMessage {
  msg_type: string;
  content?: any;
}

/**
 * 飞书 Webhook/事件回调事件
 */
export interface FeishuEvent {
  schema: string;
  header: {
    event_type: string;
    event_id: string;
    create_time: string;
    token: string;
  };
  event?: {
    message?: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
      sender?: {
        sender_id?: {
          union_id?: string;
          open_id?: string;
          user_id?: string;
        };
        sender_type?: string;
      };
      create_time?: string;
    };
  };
}

/**
 * 飞书用户 ID
 */
export interface FeishuUserId {
  union_id?: string;
  open_id?: string;
  user_id?: string;
}

/**
 * 飞书应用配置
 */
export interface FeishuConfig {
  webhookUrl?: string;
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
}

/**
 * 飞书机器人
 */
export class FeishuBot {
  private config: FeishuConfig;
  private tenantAccessToken: string = "";
  private tokenExpireTime: number = 0;

  constructor() {
    this.config = {
      webhookUrl: process.env.FEISHU_WEBHOOK_URL,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    };
  }

  /**
   * 检查是否已配置
   */
  isConfigured(): boolean {
    return !!(
      this.config.webhookUrl ||
      (this.config.appId && this.config.appSecret)
    );
  }

  /**
   * 获取配置
   */
  getConfig(): FeishuConfig {
    return this.config;
  }

  /**
   * 验证 verification token
   */
  verifyToken(token: string): boolean {
    if (!this.config.verificationToken) return true;
    return token === this.config.verificationToken;
  }

  /**
   * 获取 tenant_access_token
   */
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

  /**
   * 解析消息内容
   */
  parseMessage(event: FeishuEvent): { text: string; messageId: string } | null {
    if (!event.event?.message) return null;

    const message = event.event.message;
    try {
      const content = JSON.parse(message.content || "{}");
      return {
        text: content.text || "",
        messageId: message.message_id,
      };
    } catch {
      return {
        text: message.content || "",
        messageId: message.message_id,
      };
    }
  }

  /**
   * 获取发送者 ID
   */
  getSenderId(event: FeishuEvent): FeishuUserId {
    return (
      event.event?.message?.sender?.sender_id || {}
    );
  }

  /**
   * 获取会话 ID
   */
  getSessionId(event: FeishuEvent): string {
    const chatId = event.event?.message?.chat_id || "unknown";
    const userId = this.getSenderId(event);
    const userIdStr = userId.user_id || userId.open_id || userId.union_id || "unknown";
    return `feishu_${chatId}_${userIdStr}`;
  }

  /**
   * 获取用户名称
   */
  async getUserName(userId: FeishuUserId): Promise<string> {
    if (!this.config.appId || !this.config.appSecret) {
      return "用户";
    }

    try {
      const token = await this.getTenantAccessToken();
      const openId = userId.open_id || userId.user_id;
      
      if (!openId) return "用户";

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/users/${openId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await response.json();
      if (data.code === 0 && data.data?.name) {
        return data.data.name;
      }
    } catch (e) {
      console.error("Failed to get user name:", e);
    }

    return "用户";
  }

  /**
   * 通过 Webhook 发送消息
   */
  async sendMessageViaWebhook(text: string): Promise<void> {
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

  /**
   * 通过 API 发送消息
   */
  async sendMessageAPI(chatId: string, text: string): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) return;

    const token = await this.getTenantAccessToken();

    await fetch("https://open.feishu.cn/open-apis/im/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id_type: "chat_id",
        msg_type: "text",
        content: JSON.stringify({ text }),
        receive_id: chatId,
      }),
    });
  }

  /**
   * 发送消息（自动选择方式）
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.config.webhookUrl) {
      await this.sendMessageViaWebhook(text);
    } else if (this.config.appId && this.config.appSecret) {
      await this.sendMessageAPI(chatId, text);
    }
  }

  /**
   * 回复消息（带引用）
   */
  async replyMessage(
    messageId: string,
    text: string
  ): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) return;

    const token = await this.getTenantAccessToken();

    await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      }
    );
  }

  /**
   * 处理 Webhook 事件
   */
  async handleEvent(body: any): Promise<any> {
    const event = body as FeishuEvent;

    // URL 验证回调
    if (event.schema === "2.0" && event.header?.event_type === "url_verification") {
      return {
        challenge: event.header?.event_id || body.challenge,
      };
    }

    // 消息回调
    if (event.event?.message?.message_id) {
      const parsed = this.parseMessage(event);
      if (!parsed || !parsed.text) {
        return { success: true };
      }

      const sessionId = this.getSessionId(event);
      const chatId = event.event.message.chat_id;

      try {
        const result = await chatEngine.chat({
          message: parsed.text,
          sessionId,
        });

        await this.sendMessage(chatId, result.response);
      } catch (error) {
        console.error("Chat error:", error);
        await this.sendMessage(chatId, "处理消息失败，请稍后重试");
      }
    }

    return { success: true };
  }
}

export const feishuBot = new FeishuBot();
