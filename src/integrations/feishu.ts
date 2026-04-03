import * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuStreamingCard, type StreamingCardSession } from "./feishu-streaming-card";

export interface FeishuBotConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  webhookUrl?: string;
  useLongConnection?: boolean;
  /** 是否启用流式卡片输出（默认 true） */
  enableStreaming?: boolean;
  /** 是否在 footer 显示耗时（默认 true） */
  showElapsed?: boolean;
}

export interface FeishuBotOptions {
  connectorId?: string;
}

export interface FeishuRoutingOptions {
  connectorId?: string;
}

/**
 * 结构化通知目标。
 * 多机器人场景下，任务和心跳通知必须带上 connectorId 才能路由到正确机器人。
 */
export interface FeishuNotificationTarget {
  platform: "feishu";
  connectorId: string;
  chatId: string;
  tenantKey?: string;
}

export interface FeishuBotStatus {
  id: string;
  connected: boolean;
  appId?: string;
  streaming: boolean;
  mode: "webhook" | "websocket";
}

/**
 * Minimal interface for the ChatEngine dependency.
 * Injected via setChatEngine() — no hard imports.
 */
interface ChatEngineAPI {
  chat(request: { message: string; sessionId: string; userId?: string }): Promise<{ response: string }>;
  chatStream?(
    request: { message: string; sessionId: string; userId?: string },
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
  setLastNotificationTarget?(target: FeishuNotificationTarget): void;
}

type JsonRecord = Record<string, unknown>;

interface FeishuSenderId {
  user_id?: string;
  open_id?: string;
  union_id?: string;
}

interface FeishuMessagePayload {
  message_id?: string;
  message_type?: string;
  content?: string;
  chat_id?: string;
  sender?: {
    sender_id?: FeishuSenderId;
  };
}

interface FeishuEventHeader {
  event_type?: string;
  event_id?: string;
  app_id?: string;
  tenant_key?: string;
  token?: string;
}

interface FeishuEventPayload {
  schema?: string;
  header?: FeishuEventHeader;
  event?: {
    message?: FeishuMessagePayload;
    sender?: {
      sender_id?: FeishuSenderId;
    };
    tenant_key?: string;
    app_id?: string;
    token?: string;
  };
  message?: FeishuMessagePayload;
  sender?: {
    sender_id?: FeishuSenderId;
  };
  type?: string;
  challenge?: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
}

interface IncomingMessageContext {
  chatId: string;
  text: string;
  sessionId: string;
  userId: string;
  senderId?: FeishuSenderId;
  messageId?: string;
  tenantKey?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function parseFeishuMode(mode: string | undefined): boolean | undefined {
  if (!mode) return undefined;
  const normalized = mode.trim().toLowerCase();
  if (normalized === "websocket") return true;
  if (normalized === "webhook") return false;
  return undefined;
}

function sanitizeSegment(value: string): string {
  return encodeURIComponent(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readLegacyFeishuBotConfig(env: NodeJS.ProcessEnv = process.env): FeishuBotConfig {
  const mode = parseFeishuMode(env.FEISHU_MODE);

  return {
    appId: readString(env.FEISHU_APP_ID),
    appSecret: readString(env.FEISHU_APP_SECRET),
    verificationToken: readString(env.FEISHU_VERIFICATION_TOKEN),
    encryptKey: readString(env.FEISHU_ENCRYPT_KEY),
    webhookUrl: readString(env.FEISHU_WEBHOOK_URL),
    useLongConnection:
      mode ?? readBoolean(env.FEISHU_USE_LONG_CONNECTION, true),
    enableStreaming: readBoolean(env.FEISHU_STREAMING, true),
    showElapsed: readBoolean(env.FEISHU_SHOW_ELAPSED, true),
  };
}

export class FeishuBot {
  private readonly connectorId: string;
  private readonly config: FeishuBotConfig;
  private wsClient?: Lark.WSClient;
  private tenantAccessToken = "";
  private tokenExpireTime = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  /* ── DI fields ── */
  private chatEngineAPI: ChatEngineAPI | null = null;
  private taskSchedulerAPI: TaskSchedulerAPI | null = null;

  /* ── 流式卡片管理器 ── */
  private readonly streamingCard: FeishuStreamingCard;

  constructor(config?: FeishuBotConfig, options?: FeishuBotOptions) {
    this.connectorId = options?.connectorId ?? "default";
    const baseConfig = config ?? readLegacyFeishuBotConfig();
    this.config = {
      ...baseConfig,
      useLongConnection: baseConfig.useLongConnection ?? true,
      enableStreaming: baseConfig.enableStreaming ?? true,
      showElapsed: baseConfig.showElapsed ?? true,
    };

    // 初始化流式卡片管理器，注入 token 获取函数
    this.streamingCard = new FeishuStreamingCard(() => this.getTenantAccessToken());
  }

  getId(): string {
    return this.connectorId;
  }

  /* ── DI setters ── */

  setChatEngine(engine: ChatEngineAPI): void {
    this.chatEngineAPI = engine;
    console.log(`[FeishuBot:${this.connectorId}] ChatEngine attached`);
  }

  setTaskScheduler(scheduler: TaskSchedulerAPI): void {
    this.taskSchedulerAPI = scheduler;
    console.log(`[FeishuBot:${this.connectorId}] TaskScheduler attached`);
  }

  /**
   * 显式启动机器人。
   * 多机器人场景下由管理器顺序调用，避免多个 WS 初始化同时篡改全局 console。
   */
  async start(): Promise<void> {
    if (!this.isConfigured()) return;

    if (this.shouldUseWebSocket()) {
      await this.initWSClient();
      return;
    }

    console.log(`[FeishuBot:${this.connectorId}] using Webhook mode`);
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.webhookUrl ||
      (this.config.appId && this.config.appSecret),
    );
  }

  getConfig(): FeishuBotConfig & { id: string } {
    return {
      id: this.connectorId,
      ...this.config,
      appSecret: this.config.appSecret ? "***" : undefined,
      verificationToken: this.config.verificationToken ? "***" : undefined,
      encryptKey: this.config.encryptKey ? "***" : undefined,
      webhookUrl: this.config.webhookUrl ? "***" : undefined,
    };
  }

  verifyToken(token: string): boolean {
    if (!this.config.verificationToken) return true;
    return token === this.config.verificationToken;
  }

  /**
   * 初始化飞书 WebSocket 长连接客户端。
   *
   * 设计要点：
   * 1. SDK 的 start() 是 fire-and-forget，必须自行探测 ready 状态
   * 2. 每次重试创建全新 WSClient，避免内部状态污染
   * 3. 失败后进入后台静默重连，不阻塞主服务
   */
  private async initWSClient(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) return;

    console.log(`[FeishuBot:${this.connectorId}] Initializing Feishu WebSocket client...`);

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 3000;
    const MAX_DELAY_MS = 60000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        this.wsClient = new Lark.WSClient({
          appId: this.config.appId,
          appSecret: this.config.appSecret,
          loggerLevel: Lark.LoggerLevel.info,
        });

        const connected = await this.startWithTimeout();

        if (connected) {
          console.log(`[FeishuBot:${this.connectorId}] WebSocket client started successfully`);
          return;
        }

        throw new Error("WebSocket connection not established within timeout");
      } catch (error: unknown) {
        const errMsg = toErrorMessage(error);

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000,
            MAX_DELAY_MS,
          );
          console.warn(
            `[FeishuBot:${this.connectorId}] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}. ` +
              `Retrying in ${(delay / 1000).toFixed(1)}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.error(
            `[FeishuBot:${this.connectorId}] Failed after ${MAX_RETRIES} attempts. ` +
              `Last error: ${errMsg}. The bot will operate without real-time event subscription.`,
          );
          this.scheduleBackgroundReconnect();
        }
      }
    }
  }

  /**
   * 带超时检测的 WSClient 启动。
   * SDK 会打印 "ws client ready"，这里通过拦截 console.info 判断连接成功。
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

      const originalInfo = console.info;

      const cleanup = () => {
        console.info = originalInfo;
        clearTimeout(timer);
      };

      console.info = (...args: unknown[]) => {
        originalInfo.apply(console, args);
        const msg = args.map((arg) => String(arg)).join(" ");
        if (msg.includes("ws client ready") && !settled) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };

      const wsClient = this.wsClient as unknown as {
        start(config: { eventDispatcher: Lark.EventDispatcher }): void;
      };

      wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          "im.message.receive_v1": async (data: unknown) => {
            await this.handleRealtimeEvent(data);
          },
        }),
      });
    });
  }

  /**
   * 后台静默重连：初始重试耗尽后，每 2 分钟探测一次飞书 endpoint。
   */
  private scheduleBackgroundReconnect(): void {
    const INTERVAL_MS = 120_000;
    console.log(`[FeishuBot:${this.connectorId}] Scheduling background reconnect every 2 minutes...`);

    const intervalId = setInterval(async () => {
      try {
        if (!this.config.appId || !this.config.appSecret) return;

        const response = await fetch("https://open.feishu.cn/callback/ws/endpoint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            AppID: this.config.appId,
            AppSecret: this.config.appSecret,
          }),
        });
        const data = await response.json() as { code?: number };

        if (data.code !== 0) {
          console.log(`[FeishuBot:${this.connectorId}] Background probe: code ${String(data.code)}, skipping`);
          return;
        }

        console.log(`[FeishuBot:${this.connectorId}] Server available, attempting reconnect...`);
        this.wsClient = new Lark.WSClient({
          appId: this.config.appId,
          appSecret: this.config.appSecret,
          loggerLevel: Lark.LoggerLevel.info,
        });

        const connected = await this.startWithTimeout();
        if (connected) {
          console.log(`[FeishuBot:${this.connectorId}] Background reconnect successful!`);
          clearInterval(intervalId);
        }
      } catch (error: unknown) {
        console.log(`[FeishuBot:${this.connectorId}] Background reconnect failed: ${toErrorMessage(error)}`);
      }
    }, INTERVAL_MS);
  }

  private async handleRealtimeEvent(data: unknown): Promise<void> {
    const event = this.asEventPayload(data);
    const context = this.parseIncomingMessage(event, true);

    if (!context) {
      return;
    }

    this.scheduleMessagePipeline(context);
  }

  private scheduleMessagePipeline(context: IncomingMessageContext): void {
    setTimeout(() => {
      void this.runMessagePipeline(context).catch(async (error: unknown) => {
        console.error(`[FeishuBot:${this.connectorId}] Chat error:`, error);
        const errorResponse = await this.generateErrorResponse(context.text, error);
        await this.sendMessage(context.chatId, context.senderId, errorResponse);
      });
    }, 100);
  }

  /**
   * 统一消息处理入口。
   * WebSocket 与 HTTP webhook 都在这里汇合，避免两条逻辑链逐渐分叉。
   */
  private async runMessagePipeline(context: IncomingMessageContext): Promise<void> {
    console.log(
      `[FeishuBot:${this.connectorId}] Processing message from ${this.getRawSenderId(context.senderId)}: ${context.text}`,
    );

    this.taskSchedulerAPI?.setLastChatId(context.chatId);
    this.taskSchedulerAPI?.setLastNotificationTarget?.(this.buildNotificationTarget(context));

    if (context.messageId) {
      await this.addReaction(context.messageId, "THUMBSUP");
    }

    if (!this.chatEngineAPI) {
      throw new Error("ChatEngine not available");
    }

    const useStreaming = this.canUseStreaming();

    if (useStreaming) {
      await this.handleMessageStreaming(context);
      return;
    }

    await this.handleMessageNonStreaming(context);
  }

  /**
   * 流式模式处理消息：
   * 1. 创建流式卡片
   * 2. 流式调用 ChatEngine.chatStream()
   * 3. Finalize 关闭流式展示
   */
  private async handleMessageStreaming(context: IncomingMessageContext): Promise<void> {
    let cardSession: StreamingCardSession | null = null;
    const t0 = Date.now();

    try {
      const tCard = Date.now();
      cardSession = await this.streamingCard.create(context.chatId, {
        title: "🤖 FlashClaw",
        headerTemplate: "blue",
        finishTitle: "🤖 FlashClaw",
        finishTemplate: "green",
        showElapsed: this.config.showElapsed,
        subtitle: "正在思考...",
      });
      console.log(
        `[FeishuBot:${this.connectorId}] ⏱ card create=${Date.now() - tCard}ms, mode=${cardSession.mode}`,
      );

      const tStream = Date.now();
      const result = await this.chatEngineAPI!.chatStream!(
        { message: context.text, sessionId: context.sessionId, userId: context.userId },
        {
          onDelta: async (_delta: string, fullText: string) => {
            if (cardSession) {
              await this.streamingCard.pushText(cardSession, fullText);
            }
          },
          onDone: async (fullText: string) => {
            console.log(
              `[FeishuBot:${this.connectorId}] ⏱ stream done=${Date.now() - tStream}ms, chars=${fullText.length}`,
            );
          },
          onError: async (error: Error) => {
            console.error(`[FeishuBot:${this.connectorId}] Stream error:`, error.message);
          },
        },
      );

      const tFinal = Date.now();
      if (cardSession) {
        await this.streamingCard.finalize(cardSession, result.response);
      }
      console.log(`[FeishuBot:${this.connectorId}] ⏱ finalize=${Date.now() - tFinal}ms`);
      console.log(`[FeishuBot:${this.connectorId}] ⏱ E2E TOTAL=${Date.now() - t0}ms`);
    } catch (error: unknown) {
      const errMsg = toErrorMessage(error);
      console.error(`[FeishuBot:${this.connectorId}] Streaming failed:`, errMsg);
      if (cardSession && !cardSession.closed) {
        try {
          await this.streamingCard.finalize(
            cardSession,
            `⚠️ 处理遇到问题，请稍后重试。\n\n错误：${errMsg}`,
          );
          return;
        } catch {
          // Fall through to API send fallback below.
        }
      }
      await this.sendViaAPI(context.chatId, "抱歉，处理消息时遇到问题，请稍后重试。");
    }
  }

  /**
   * 非流式模式处理消息（降级方案）。
   */
  private async handleMessageNonStreaming(context: IncomingMessageContext): Promise<void> {
    console.log(`[FeishuBot:${this.connectorId}] Using non-streaming mode`);
    const startTime = Date.now();

    const result = await this.chatEngineAPI!.chat({
      message: context.text,
      sessionId: context.sessionId,
      userId: context.userId,
    });

    const elapsed = Date.now() - startTime;
    const elapsedStr = elapsed < 1000
      ? `${elapsed}ms`
      : `${(elapsed / 1000).toFixed(1)}s`;

    let reply = result.response;
    if (this.config.showElapsed) {
      reply += `\n\n---\n⏱ 耗时 ${elapsedStr}`;
    }

    console.log(`[FeishuBot:${this.connectorId}] Chat done, response length:`, result.response.length);
    await this.sendMessage(context.chatId, context.senderId, reply);
  }

  private async generateErrorResponse(userMessage: string, error: unknown): Promise<string> {
    if (!this.chatEngineAPI) {
      return "抱歉，我遇到了一些问题。请稍后重试，或者换一种方式提问。";
    }
    try {
      const result = await this.chatEngineAPI.chat({
        message: `用户说: "${userMessage}"\n\n处理用户请求时发生错误: ${toErrorMessage(error)}\n\n请生成一个友好的回复，告知用户遇到了问题，但不要提到技术细节。可以建议用户稍后重试或换一种方式提问。`,
        sessionId: `feishu_error_response:${sanitizeSegment(this.connectorId)}`,
        userId: `feishu:${sanitizeSegment(this.connectorId)}:system:error`,
      });
      return result.response;
    } catch {
      return "抱歉，我遇到了一些问题。请稍后重试，或者换一种方式提问。";
    }
  }

  private buildNotificationTarget(context: IncomingMessageContext): FeishuNotificationTarget {
    return {
      platform: "feishu",
      connectorId: this.connectorId,
      chatId: context.chatId,
      tenantKey: context.tenantKey,
    };
  }

  private buildScopedUserId(senderId: FeishuSenderId | undefined, tenantKey?: string): string {
    const rawUserId = this.getRawSenderId(senderId);
    const tenantSegment = sanitizeSegment(tenantKey ?? "default");
    const connectorSegment = sanitizeSegment(this.connectorId);
    return `feishu:${connectorSegment}:${tenantSegment}:${sanitizeSegment(rawUserId)}`;
  }

  private buildSessionId(chatId: string, senderId: FeishuSenderId | undefined, tenantKey?: string): string {
    const connectorSegment = sanitizeSegment(this.connectorId);
    const tenantSegment = sanitizeSegment(tenantKey ?? "default");
    const chatSegment = sanitizeSegment(chatId);
    const userSegment = sanitizeSegment(this.getRawSenderId(senderId));
    return `feishu:${connectorSegment}:${tenantSegment}:${chatSegment}:${userSegment}`;
  }

  private getRawSenderId(senderId?: FeishuSenderId): string {
    return senderId?.user_id || senderId?.open_id || senderId?.union_id || "unknown";
  }

  private extractMessageText(message: FeishuMessagePayload): string {
    if (!message.content) return "";
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      return readString(parsed.text) ?? "";
    } catch {
      return message.content;
    }
  }

  private extractSenderId(event: FeishuEventPayload, message: FeishuMessagePayload): FeishuSenderId | undefined {
    return event.event?.sender?.sender_id
      || event.sender?.sender_id
      || message.sender?.sender_id;
  }

  private extractTenantKey(event: FeishuEventPayload): string | undefined {
    return event.header?.tenant_key
      || event.event?.tenant_key
      || event.tenant_key;
  }

  private extractProvidedToken(event: FeishuEventPayload): string | undefined {
    return event.header?.token
      || event.event?.token
      || event.token;
  }

  private asEventPayload(body: unknown): FeishuEventPayload {
    if (!isRecord(body)) {
      return {};
    }

    const header = isRecord(body.header)
      ? {
          event_type: readString(body.header.event_type),
          event_id: readString(body.header.event_id),
          app_id: readString(body.header.app_id),
          tenant_key: readString(body.header.tenant_key),
          token: readString(body.header.token),
        }
      : undefined;

    const eventPayload = isRecord(body.event)
      ? {
          message: this.asMessagePayload(body.event.message),
          sender: isRecord(body.event.sender)
            ? { sender_id: this.asSenderId(body.event.sender.sender_id) }
            : undefined,
          tenant_key: readString(body.event.tenant_key),
          app_id: readString(body.event.app_id),
          token: readString(body.event.token),
        }
      : undefined;

    return {
      schema: readString(body.schema),
      header,
      event: eventPayload,
      message: this.asMessagePayload(body.message),
      sender: isRecord(body.sender)
        ? { sender_id: this.asSenderId(body.sender.sender_id) }
        : undefined,
      type: readString(body.type),
      challenge: readString(body.challenge),
      token: readString(body.token),
      app_id: readString(body.app_id),
      tenant_key: readString(body.tenant_key),
    };
  }

  private asMessagePayload(value: unknown): FeishuMessagePayload | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    return {
      message_id: readString(value.message_id),
      message_type: readString(value.message_type),
      content: readString(value.content),
      chat_id: readString(value.chat_id),
      sender: isRecord(value.sender)
        ? { sender_id: this.asSenderId(value.sender.sender_id) }
        : undefined,
    };
  }

  private asSenderId(value: unknown): FeishuSenderId | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    return {
      user_id: readString(value.user_id),
      open_id: readString(value.open_id),
      union_id: readString(value.union_id),
    };
  }

  private parseIncomingMessage(event: FeishuEventPayload, requireMessageId: boolean): IncomingMessageContext | null {
    const message = event.event?.message || event.message;
    if (!message?.chat_id) {
      return null;
    }

    if (requireMessageId && !message.message_id) {
      return null;
    }

    const messageType = message.message_type;
    if (messageType && messageType !== "text" && messageType !== "post") {
      return null;
    }

    const text = this.extractMessageText(message);
    if (!text) {
      return null;
    }

    const senderId = this.extractSenderId(event, message);
    const tenantKey = this.extractTenantKey(event);
    const sessionId = this.buildSessionId(message.chat_id, senderId, tenantKey);
    const userId = this.buildScopedUserId(senderId, tenantKey);

    return {
      chatId: message.chat_id,
      text,
      sessionId,
      userId,
      senderId,
      messageId: message.message_id,
      tenantKey,
    };
  }

  private isUrlVerification(event: FeishuEventPayload): boolean {
    return event.header?.event_type === "url_verification";
  }

  private isMessageEvent(event: FeishuEventPayload): boolean {
    return event.type === "message" || Boolean(event.event?.message || event.message);
  }

  private canUseStreaming(): boolean {
    return Boolean(
      this.config.enableStreaming &&
      this.config.appId &&
      this.config.appSecret &&
      typeof this.chatEngineAPI?.chatStream === "function",
    );
  }

  private shouldUseWebSocket(): boolean {
    return Boolean(
      this.config.useLongConnection &&
      this.config.appId &&
      this.config.appSecret,
    );
  }

  private getChallenge(event: FeishuEventPayload): string | undefined {
    return event.challenge || event.header?.event_id;
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
      },
    );

    const data = await response.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (data.code !== 0 || !data.tenant_access_token || !data.expire) {
      throw new Error(`Failed to get token: ${data.msg || "unknown error"}`);
    }

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
    return this.tenantAccessToken;
  }

  async sendMessage(
    chatId: string,
    _userId?: unknown,
    text?: string,
  ): Promise<void> {
    if (!text) return;

    console.log(`[FeishuBot:${this.connectorId}] sendMessage called, chatId:`, chatId, "text length:", text.length);

    if (this.config.webhookUrl) {
      await this.sendViaWebhook(text);
      return;
    }

    if (this.config.appId && this.config.appSecret) {
      await this.sendViaAPI(chatId, text);
      return;
    }

    console.log(`[FeishuBot:${this.connectorId}] Not configured for sending`);
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

      const payload = await response.text();
      console.log(`[FeishuBot:${this.connectorId}] Reaction response: ${payload}`);

      const data = JSON.parse(payload) as { code?: number; msg?: string };

      if (data.code !== 0) {
        throw new Error(`添加表情失败: ${data.msg || "unknown error"}`);
      }

      console.log(`[FeishuBot:${this.connectorId}] Added ${emojiType} reaction to message ${messageId}`);
    } catch (error: unknown) {
      console.error(`[FeishuBot:${this.connectorId}] Failed to add reaction:`, toErrorMessage(error));
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
    if (!this.config.appId || !this.config.appSecret) {
      return;
    }

    try {
      const token = await this.getTenantAccessToken();

      const client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: Lark.Domain.Lark,
        disableTokenCache: true,
      });

      const result = await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      }, Lark.withTenantToken(token));

      if (result.code !== 0) {
        console.error(`[FeishuBot:${this.connectorId}] Send message failed:`, result.msg);
      } else {
        console.log(`[FeishuBot:${this.connectorId}] Sent message to ${chatId}`);
      }
    } catch (error: unknown) {
      console.error(`[FeishuBot:${this.connectorId}] Failed to send message:`, toErrorMessage(error));
    }
  }

  async handleEvent(body: unknown): Promise<unknown> {
    const event = this.asEventPayload(body);
    const providedToken = this.extractProvidedToken(event);

    if (providedToken && !this.verifyToken(providedToken)) {
      return { success: false, error: "Verification token mismatch" };
    }

    if (this.isUrlVerification(event)) {
      return {
        challenge: this.getChallenge(event),
      };
    }

    if (!this.isMessageEvent(event)) {
      return { success: true };
    }

    if (!this.chatEngineAPI) {
      console.error(`[FeishuBot:${this.connectorId}] ChatEngine 未注入，无法处理 Webhook 消息`);
      return { success: false, error: "ChatEngine not available" };
    }

    const context = this.parseIncomingMessage(event, false);
    if (!context) {
      return { success: true };
    }

    try {
      await this.runMessagePipeline(context);
      return { success: true };
    } catch (error: unknown) {
      console.error(`[FeishuBot:${this.connectorId}] Chat error:`, error);
      await this.sendMessage(context.chatId, context.senderId, "处理消息失败，请稍后重试");
      return { success: false, error: toErrorMessage(error) };
    }
  }

  /**
   * 获取飞书连接状态。
   * webhook 模式没有长连接，因此只要配置完整就视为 connected。
   */
  getStatus(): FeishuBotStatus {
    const mode = this.shouldUseWebSocket() ? "websocket" : "webhook";
    const connected = mode === "websocket" ? Boolean(this.wsClient) : this.isConfigured();

    return {
      id: this.connectorId,
      connected,
      appId: this.config.appId,
      streaming: Boolean(this.config.enableStreaming),
      mode,
    };
  }
}
