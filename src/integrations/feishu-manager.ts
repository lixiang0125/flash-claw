import {
  FeishuBot,
  type FeishuBotConfig,
  type FeishuBotStatus,
  type FeishuNotificationTarget,
  type FeishuRoutingOptions,
  readLegacyFeishuBotConfig,
} from "./feishu";

interface FeishuBotDefinition extends FeishuBotConfig {
  id: string;
  isDefault?: boolean;
}

interface FeishuManagerConfig {
  defaultBotId: string | null;
  bots: FeishuBotDefinition[];
}

type JsonRecord = Record<string, unknown>;

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

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function parseMode(value: unknown): boolean | undefined {
  const mode = readString(value);
  if (!mode) return undefined;
  const normalized = mode.toLowerCase();
  if (normalized === "websocket") return true;
  if (normalized === "webhook") return false;
  return undefined;
}

function normalizeFeishuBotDefinition(value: unknown, fallbackId?: string): FeishuBotDefinition {
  if (!isRecord(value)) {
    throw new Error("FEISHU_BOTS entries must be objects");
  }

  const id = readString(value.id) ?? fallbackId;
  if (!id) {
    throw new Error("FEISHU_BOTS entries must include a non-empty id");
  }

  return {
    id,
    appId: readString(value.appId) ?? readString(value.app_id),
    appSecret: readString(value.appSecret) ?? readString(value.app_secret),
    verificationToken: readString(value.verificationToken) ?? readString(value.verification_token),
    encryptKey: readString(value.encryptKey) ?? readString(value.encrypt_key),
    webhookUrl: readString(value.webhookUrl) ?? readString(value.webhook_url),
    useLongConnection:
      readBoolean(value.useLongConnection)
      ?? parseMode(value.mode)
      ?? true,
    enableStreaming: readBoolean(value.enableStreaming) ?? true,
    showElapsed: readBoolean(value.showElapsed) ?? true,
    isDefault: readBoolean(value.isDefault) ?? false,
  };
}

function parseFeishuBots(raw: string): FeishuBotDefinition[] {
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeFeishuBotDefinition(item));
  }

  if (!isRecord(parsed)) {
    throw new Error("FEISHU_BOTS must be a JSON array or object map");
  }

  return Object.entries(parsed).map(([id, item]) => normalizeFeishuBotDefinition(item, id));
}

export function readFeishuManagerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FeishuManagerConfig {
  const rawBots = readString(env.FEISHU_BOTS);

  if (rawBots) {
    const bots = parseFeishuBots(rawBots);
    const defaultBotId = readString(env.FEISHU_DEFAULT_BOT_ID)
      ?? bots.find((bot) => bot.isDefault)?.id
      ?? bots[0]?.id
      ?? null;

    return {
      defaultBotId,
      bots,
    };
  }

  const legacyConfig = readLegacyFeishuBotConfig(env);
  const isLegacyConfigured = Boolean(
    legacyConfig.webhookUrl ||
    (legacyConfig.appId && legacyConfig.appSecret),
  );

  return {
    defaultBotId: isLegacyConfigured ? "default" : null,
    bots: isLegacyConfigured
      ? [{ id: "default", ...legacyConfig, isDefault: true }]
      : [],
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FeishuBotManager {
  private readonly bots = new Map<string, FeishuBot>();
  private readonly defaultBotId: string | null;

  constructor(config?: FeishuManagerConfig) {
    const resolvedConfig = config ?? readFeishuManagerConfigFromEnv();

    for (const botDefinition of resolvedConfig.bots) {
      const bot = new FeishuBot(botDefinition, { connectorId: botDefinition.id });
      if (bot.isConfigured()) {
        this.bots.set(botDefinition.id, bot);
      }
    }

    if (resolvedConfig.defaultBotId && this.bots.has(resolvedConfig.defaultBotId)) {
      this.defaultBotId = resolvedConfig.defaultBotId;
    } else {
      this.defaultBotId = this.bots.keys().next().value ?? null;
    }
  }

  setChatEngine(engine: {
    chat(request: { message: string; sessionId: string; userId?: string }): Promise<{ response: string }>;
    chatStream?(
      request: { message: string; sessionId: string; userId?: string },
      callbacks: {
        onDelta: (delta: string, fullText: string) => void | Promise<void>;
        onDone: (fullText: string) => void | Promise<void>;
        onError?: (error: Error) => void | Promise<void>;
      },
    ): Promise<{ response: string }>;
  }): void {
    for (const bot of this.bots.values()) {
      bot.setChatEngine(engine);
    }
  }

  setTaskScheduler(scheduler: {
    setLastChatId(chatId: string): void;
    setLastNotificationTarget?(target: FeishuNotificationTarget): void;
  }): void {
    for (const bot of this.bots.values()) {
      bot.setTaskScheduler(scheduler);
    }
  }

  async start(): Promise<void> {
    for (const bot of this.bots.values()) {
      await bot.start();
    }
  }

  isConfigured(connectorId?: string): boolean {
    if (connectorId) {
      return this.bots.get(connectorId)?.isConfigured() ?? false;
    }
    return this.bots.size > 0;
  }

  getConfig(connectorId?: string): unknown {
    if (connectorId) {
      return this.bots.get(connectorId)?.getConfig() ?? null;
    }

    return {
      defaultBotId: this.defaultBotId,
      bots: Array.from(this.bots.values(), (bot) => bot.getConfig()),
    };
  }

  getStatus(): { connected: boolean; defaultBotId: string | null; bots: FeishuBotStatus[] } {
    const statuses = Array.from(this.bots.values(), (bot) => bot.getStatus());
    return {
      connected: statuses.length > 0 && statuses.every((status) => status.connected),
      defaultBotId: this.defaultBotId,
      bots: statuses,
    };
  }

  async handleEvent(body: unknown, options?: FeishuRoutingOptions): Promise<unknown> {
    const bot = this.resolveBot(body, options?.connectorId);
    if (!bot) {
      return { success: false, error: "Feishu bot not configured" };
    }

    return bot.handleEvent(body);
  }

  async sendMessage(chatId: string, userId?: unknown, text?: string): Promise<void> {
    const bot = this.getDefaultBot();
    if (!bot) return;
    await bot.sendMessage(chatId, userId, text);
  }

  async notify(chatId: string, text: string): Promise<void> {
    const bot = this.getDefaultBot();
    if (!bot) return;
    await bot.notify(chatId, text);
  }

  async notifyTarget(target: FeishuNotificationTarget, text: string): Promise<void> {
    const bot = this.bots.get(target.connectorId) ?? this.getDefaultBot();
    if (!bot) {
      return;
    }
    await bot.notify(target.chatId, text);
  }

  private getDefaultBot(): FeishuBot | null {
    if (!this.defaultBotId) {
      return null;
    }
    return this.bots.get(this.defaultBotId) ?? null;
  }

  private resolveBot(body: unknown, explicitConnectorId?: string): FeishuBot | null {
    if (explicitConnectorId) {
      return this.bots.get(explicitConnectorId) ?? null;
    }

    const appId = this.extractAppId(body);
    if (appId) {
      for (const bot of this.bots.values()) {
        const config = bot.getConfig();
        if (isRecord(config) && config.appId === appId) {
          return bot;
        }
      }
    }

    const verificationToken = this.extractVerificationToken(body);
    if (verificationToken) {
      for (const bot of this.bots.values()) {
        const config = bot.getConfig();
        if (
          isRecord(config) &&
          readString(config.verificationToken) &&
          bot.verifyToken(verificationToken)
        ) {
          return bot;
        }
      }
    }

    return this.getDefaultBot();
  }

  private extractAppId(body: unknown): string | undefined {
    if (!isRecord(body)) {
      return undefined;
    }

    if (isRecord(body.header)) {
      const appId = readString(body.header.app_id);
      if (appId) return appId;
    }

    if (isRecord(body.event)) {
      const appId = readString(body.event.app_id);
      if (appId) return appId;
    }

    return readString(body.app_id);
  }

  private extractVerificationToken(body: unknown): string | undefined {
    if (!isRecord(body)) {
      return undefined;
    }

    if (isRecord(body.header)) {
      const token = readString(body.header.token);
      if (token) return token;
    }

    if (isRecord(body.event)) {
      const token = readString(body.event.token);
      if (token) return token;
    }

    return readString(body.token);
  }
}
