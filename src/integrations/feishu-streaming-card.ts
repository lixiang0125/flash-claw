/**
 * 飞书流式卡片服务 —— 支持两种模式：
 *
 * **模式 A (CardKit)**：使用 cardkit/v1 API
 * - 需要 `cardkit:card:write` 权限
 * - 流式模式下不受 QPS 限制
 * - 支持真正的打字机效果
 *
 * **模式 B (Message PATCH, 降级)**：使用 im/v1/messages/:id PATCH
 * - 仅需 `im:message` 权限（通常已有）
 * - 受 5 QPS 限制，通过节流控制
 * - 有约 20-30 次编辑上限，通过限制更新频率规避
 *
 * 自动检测：首次调用 CardKit API 时若权限不足，自动切换为 PATCH 模式。
 *
 * @see https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
 */

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

/** 流式推送间隔（毫秒）—— CardKit 模式 */
const CARDKIT_INTERVAL_MS = 300;

/** 流式推送间隔（毫秒）—— PATCH 降级模式（需要更长间隔以避免 QPS 限制） */
const PATCH_INTERVAL_MS = 1500;

/** PATCH 模式最大更新次数（安全阈值，留余量） */
const PATCH_MAX_UPDATES = 18;

type CardTemplate = "blue" | "green" | "red" | "orange" | "turquoise" | "yellow" | "violet" | "purple" | "indigo" | "wathet" | "grey";

export interface StreamingCardConfig {
  /** 卡片标题 */
  title: string;
  /** 标题模板颜色 */
  headerTemplate?: CardTemplate;
  /** 最终完成时的标题 */
  finishTitle?: string;
  /** 最终完成时的颜色 */
  finishTemplate?: CardTemplate;
  /** 是否显示耗时 */
  showElapsed?: boolean;
  /** 副标题 */
  subtitle?: string;
}

export interface StreamingCardSession {
  cardId: string | null;
  messageId: string;
  elementId: string;
  sequence: number;
  startTime: number;
  accumulatedText: string;
  config: StreamingCardConfig;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;
  closed: boolean;
  /** 当前使用的模式 */
  mode: "cardkit" | "patch";
  /** PATCH 模式下的更新计数 */
  patchCount: number;
}

/**
 * 飞书流式卡片管理器。
 *
 * 典型用法：
 * ```ts
 * const card = new FeishuStreamingCard(getToken);
 * const session = await card.create(chatId, { title: "AI 助手" });
 * await card.pushText(session, "正在思考...");
 * await card.pushText(session, "完整回答内容");
 * await card.finalize(session);
 * ```
 */
export class FeishuStreamingCard {
  private getToken: () => Promise<string>;
  /** 是否已检测到 CardKit 权限不足 */
  private cardkitDisabled: boolean = false;

  constructor(tokenProvider: () => Promise<string>) {
    this.getToken = tokenProvider;
  }

  /**
   * 创建流式卡片并发送到聊天。
   * 自动选择 CardKit 或 PATCH 模式。
   */
  async create(
    chatId: string,
    config: StreamingCardConfig,
    receiveIdType: "chat_id" | "open_id" = "chat_id",
  ): Promise<StreamingCardSession> {
    const token = await this.getToken();
    const elementId = "md_main";
    const startTime = Date.now();

    // 尝试 CardKit 模式
    if (!this.cardkitDisabled) {
      try {
        return await this.createWithCardKit(chatId, config, elementId, startTime, token, receiveIdType);
      } catch (err: any) {
        // 权限不足，降级为 PATCH 模式
        if (err.message?.includes("99991672") || err.message?.includes("cardkit")) {
          console.warn("[StreamingCard] CardKit permission denied, falling back to PATCH mode");
          this.cardkitDisabled = true;
        } else {
          throw err;
        }
      }
    }

    // PATCH 降级模式
    return await this.createWithPatch(chatId, config, elementId, startTime, token, receiveIdType);
  }

  /**
   * CardKit 模式创建卡片。
   */
  private async createWithCardKit(
    chatId: string,
    config: StreamingCardConfig,
    elementId: string,
    startTime: number,
    token: string,
    receiveIdType: string,
  ): Promise<StreamingCardSession> {
    // Step 1: 创建卡片实体
    const cardJson = this.buildCardJson(config, elementId, "💭 正在思考...");
    const createResp = await this.apiCall<{ card_id: string }>(
      "POST",
      `${FEISHU_BASE}/cardkit/v1/cards`,
      { type: "card_json", data: JSON.stringify(cardJson) },
      token,
    );
    const cardId = createResp.card_id;
    console.log(`[StreamingCard] CardKit: card entity created: ${cardId}`);

    // Step 2: 发送消息
    const sendResp = await this.apiCall<{ message_id: string }>(
      "POST",
      `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
      token,
    );
    console.log(`[StreamingCard] CardKit: message sent: ${sendResp.message_id}`);

    return {
      cardId,
      messageId: sendResp.message_id,
      elementId,
      sequence: 1,
      startTime,
      accumulatedText: "",
      config,
      flushTimer: null,
      pendingText: "",
      closed: false,
      mode: "cardkit",
      patchCount: 0,
    };
  }

  /**
   * PATCH 降级模式创建卡片。
   * 先发送一条 interactive 消息，然后通过 PATCH 更新。
   */
  private async createWithPatch(
    chatId: string,
    config: StreamingCardConfig,
    elementId: string,
    startTime: number,
    token: string,
    receiveIdType: string,
  ): Promise<StreamingCardSession> {
    // 直接发送内联卡片消息
    const initialCard = this.buildInlineCard(config, "💭 正在思考...");
    const sendResp = await this.apiCall<{ message_id: string }>(
      "POST",
      `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(initialCard),
      },
      token,
    );
    console.log(`[StreamingCard] PATCH mode: message sent: ${sendResp.message_id}`);

    return {
      cardId: null,
      messageId: sendResp.message_id,
      elementId,
      sequence: 0,
      startTime,
      accumulatedText: "",
      config,
      flushTimer: null,
      pendingText: "",
      closed: false,
      mode: "patch",
      patchCount: 0,
    };
  }

  /**
   * 推送文本到流式卡片。
   * 根据模式自动选择推送策略。
   */
  async pushText(session: StreamingCardSession, fullText: string): Promise<void> {
    if (session.closed) return;
    session.pendingText = fullText;

    if (session.flushTimer) return;

    await this.flushText(session);

    const interval = session.mode === "cardkit" ? CARDKIT_INTERVAL_MS : PATCH_INTERVAL_MS;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      if (session.pendingText !== session.accumulatedText && !session.closed) {
        this.flushText(session).catch((err) =>
          console.error("[StreamingCard] flush error:", err.message),
        );
      }
    }, interval);
  }

  /**
   * 实际执行文本推送。
   */
  private async flushText(session: StreamingCardSession): Promise<void> {
    if (session.closed) return;

    const text = session.pendingText;
    if (text === session.accumulatedText) return;
    session.accumulatedText = text;

    const token = await this.getToken();

    if (session.mode === "cardkit") {
      await this.flushCardKit(session, text, token);
    } else {
      await this.flushPatch(session, text, token);
    }
  }

  private async flushCardKit(session: StreamingCardSession, text: string, token: string): Promise<void> {
    session.sequence += 1;
    try {
      await this.apiCall(
        "PUT",
        `${FEISHU_BASE}/cardkit/v1/cards/${session.cardId}/elements/${session.elementId}/content`,
        { content: text, sequence: session.sequence },
        token,
      );
    } catch (err: any) {
      console.error(`[StreamingCard] CardKit push failed (seq=${session.sequence}):`, err.message);
    }
  }

  private async flushPatch(session: StreamingCardSession, text: string, token: string): Promise<void> {
    // 限制 PATCH 更新次数
    if (session.patchCount >= PATCH_MAX_UPDATES) return;
    session.patchCount += 1;

    try {
      const card = this.buildInlineCard(session.config, text, true);
      await this.apiCall(
        "PATCH",
        `${FEISHU_BASE}/im/v1/messages/${session.messageId}`,
        { content: JSON.stringify(card) },
        token,
      );
    } catch (err: any) {
      console.error(`[StreamingCard] PATCH update failed (count=${session.patchCount}):`, err.message);
    }
  }

  /**
   * 结束流式卡片。
   */
  async finalize(session: StreamingCardSession, finalText?: string): Promise<void> {
    if (session.closed) return;
    session.closed = true;

    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }

    const token = await this.getToken();
    const text = finalText || session.accumulatedText || session.pendingText;
    const elapsed = Date.now() - session.startTime;

    if (session.mode === "cardkit") {
      await this.finalizeCardKit(session, text, elapsed, token);
    } else {
      await this.finalizePatch(session, text, elapsed, token);
    }

    console.log(
      `[StreamingCard] Finalized (${session.mode}) | elapsed=${this.formatElapsed(elapsed)}`,
    );
  }

  private async finalizeCardKit(
    session: StreamingCardSession,
    text: string,
    elapsed: number,
    token: string,
  ): Promise<void> {
    // 最后一次文本推送
    if (text !== session.accumulatedText) {
      session.sequence += 1;
      try {
        await this.apiCall(
          "PUT",
          `${FEISHU_BASE}/cardkit/v1/cards/${session.cardId}/elements/${session.elementId}/content`,
          { content: text, sequence: session.sequence },
          token,
        );
      } catch (err: any) {
        console.error("[StreamingCard] Final text push failed:", err.message);
      }
    }

    // 关闭流式模式
    session.sequence += 1;
    try {
      await this.apiCall(
        "PATCH",
        `${FEISHU_BASE}/cardkit/v1/cards/${session.cardId}/settings`,
        {
          settings: JSON.stringify({ config: { streaming_mode: false, update_multi: true } }),
          sequence: session.sequence,
        },
        token,
      );
    } catch (err: any) {
      console.error("[StreamingCard] Close streaming failed:", err.message);
    }

    // 全量更新最终卡片
    const finalCard = this.buildFinalCardJson(session.config, session.elementId, text, elapsed);
    session.sequence += 1;
    try {
      await this.apiCall(
        "PUT",
        `${FEISHU_BASE}/cardkit/v1/cards/${session.cardId}`,
        { card: { type: "card_json", data: JSON.stringify(finalCard) }, sequence: session.sequence },
        token,
      );
    } catch (err: any) {
      console.error("[StreamingCard] Final card update failed:", err.message);
    }
  }

  private async finalizePatch(
    session: StreamingCardSession,
    text: string,
    elapsed: number,
    token: string,
  ): Promise<void> {
    try {
      const card = this.buildFinalInlineCard(session.config, text, elapsed);
      await this.apiCall(
        "PATCH",
        `${FEISHU_BASE}/im/v1/messages/${session.messageId}`,
        { content: JSON.stringify(card) },
        token,
      );
    } catch (err: any) {
      console.error("[StreamingCard] Final PATCH failed:", err.message);
    }
  }

  // ────── 卡片 JSON 构建 ──────

  /** CardKit 模式：初始卡片 JSON（带 streaming_mode） */
  private buildCardJson(config: StreamingCardConfig, elementId: string, initialText: string): Record<string, any> {
    return {
      schema: "2.0",
      config: { update_multi: true, streaming_mode: true, enable_forward: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: config.title },
        template: config.headerTemplate || "blue",
        ...(config.subtitle ? { subtitle: { tag: "plain_text", content: config.subtitle } } : {}),
      },
      body: {
        elements: [{ tag: "markdown", element_id: elementId, content: initialText }],
      },
    };
  }

  /** CardKit 模式：最终卡片 JSON（含 footer） */
  private buildFinalCardJson(
    config: StreamingCardConfig,
    elementId: string,
    text: string,
    elapsedMs: number,
  ): Record<string, any> {
    const elements: any[] = [{ tag: "markdown", element_id: elementId, content: text }];

    if (config.showElapsed !== false) {
      elements.push(
        { tag: "hr" },
        { tag: "note", elements: [{ tag: "plain_text", content: `⏱ 耗时 ${this.formatElapsed(elapsedMs)} · FlashClaw` }] },
      );
    }

    return {
      schema: "2.0",
      config: { update_multi: true, streaming_mode: false, enable_forward: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: config.finishTitle || config.title },
        template: config.finishTemplate || "green",
      },
      body: { elements },
    };
  }

  /** PATCH 模式：内联卡片 JSON */
  private buildInlineCard(config: StreamingCardConfig, text: string, isStreaming = false): Record<string, any> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: isStreaming ? (config.headerTemplate || "blue") : (config.headerTemplate || "blue"),
        title: { tag: "plain_text", content: config.title },
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: text } },
      ],
    };
  }

  /** PATCH 模式：最终内联卡片 JSON（含 footer） */
  private buildFinalInlineCard(config: StreamingCardConfig, text: string, elapsedMs: number): Record<string, any> {
    const elements: any[] = [
      { tag: "div", text: { tag: "lark_md", content: text } },
    ];

    if (config.showElapsed !== false) {
      elements.push(
        { tag: "hr" },
        { tag: "note", elements: [{ tag: "plain_text", content: `⏱ 耗时 ${this.formatElapsed(elapsedMs)} · FlashClaw` }] },
      );
    }

    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: config.finishTemplate || "green",
        title: { tag: "plain_text", content: config.finishTitle || config.title },
      },
      elements,
    };
  }

  /** 格式化耗时 */
  private formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSec = (seconds % 60).toFixed(0);
    return `${minutes}m${remainSec}s`;
  }

  /** 通用 API 调用 */
  private async apiCall<T = any>(method: string, url: string, body?: any, token?: string): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await resp.json() as any;

    if (data.code !== 0) {
      throw new Error(`Feishu API error [${data.code}]: ${data.msg || JSON.stringify(data)}`);
    }

    return data.data as T;
  }
}
