/**
 * @module evolution/feedback-analyzer
 * @description 对话反馈分析器。
 *
 * 使用 LLM 分析每次对话交互的质量，识别隐式和显式反馈信号。
 * 隐式信号包括：追问（confused）、重复请求（frustrated）、情绪变化等。
 * 分析结果缓存在内存中，避免对同一对话重复分析。
 */

import OpenAI from "openai";
import type { Logger } from "../core/container/tokens";
import type { FeedbackAnalysis, FeedbackSignal } from "./types";

/** 分析结果的内存缓存键 = sessionId + userMessage 前 80 字符的哈希 */
function cacheKey(sessionId: string, userMessage: string): string {
  return `${sessionId}::${userMessage.slice(0, 80)}`;
}

/**
 * 反馈分析器。
 * 通过 LLM 低温度推理分析对话质量，检测用户隐式反馈信号。
 *
 * @class FeedbackAnalyzer
 */
export class FeedbackAnalyzer {
  private client: OpenAI;
  private logger: Logger;
  /** 分析结果缓存，避免重复分析同一对话 */
  private cache: Map<string, FeedbackAnalysis> = new Map();
  /** 缓存容量上限 */
  private readonly maxCacheSize = 200;

  constructor(logger: Logger) {
    this.logger = logger;
    this.client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.OPENAI_API_KEY || "",
    });
  }

  /**
   * 分析一次对话交互，返回反馈分析结果。
   * 如果缓存中已有该对话的分析结果，直接返回缓存。
   *
   * @param userMessage - 用户消息
   * @param assistantResponse - 助手回复
   * @param sessionId - 会话 ID
   * @returns 反馈分析结果
   */
  async analyze(
    userMessage: string,
    assistantResponse: string,
    sessionId: string,
  ): Promise<FeedbackAnalysis> {
    const key = cacheKey(sessionId, userMessage);

    // 命中缓存则直接返回
    const cached = this.cache.get(key);
    if (cached) {
      this.logger.debug("[FeedbackAnalyzer] 缓存命中，跳过 LLM 分析", { sessionId: sessionId.slice(0, 8) });
      return cached;
    }

    // 先做规则级快速检测（不依赖 LLM）
    const quickSignal = this.detectQuickSignal(userMessage);

    try {
      const result = await this.analyzeWithLLM(userMessage, assistantResponse, sessionId, quickSignal);

      // 写入缓存（LRU 淘汰）
      if (this.cache.size >= this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value as string;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, result);

      return result;
    } catch (err) {
      this.logger.error("[FeedbackAnalyzer] LLM 分析失败，使用规则降级", { err });
      return this.buildFallbackAnalysis(userMessage, assistantResponse, sessionId, quickSignal);
    }
  }

  /**
   * 规则级快速信号检测：通过关键词和模式匹配初步判断反馈类型。
   * 作为 LLM 分析的辅助输入和降级兜底。
   */
  private detectQuickSignal(userMessage: string): FeedbackSignal {
    const msg = userMessage.toLowerCase();

    // 重复请求模式
    if (/再说一遍|重新|没听懂|不对|重来|again|repeat|retry/i.test(msg)) {
      return "repeated_request";
    }
    // 困惑信号
    if (/什么意思|不明白|不理解|看不懂|confused|what do you mean|huh\??/i.test(msg)) {
      return "confused";
    }
    // 沮丧/不满信号
    if (/没用|不行|太差|垃圾|废物|useless|terrible|awful|不满意/i.test(msg)) {
      return "frustrated";
    }
    // 正面信号
    if (/谢谢|太好了|不错|完美|感谢|great|perfect|awesome|thanks|good job/i.test(msg)) {
      return "positive";
    }
    // 负面信号
    if (/错了|不对|有误|wrong|incorrect|mistake/i.test(msg)) {
      return "negative";
    }

    return "neutral";
  }

  /**
   * 使用 LLM 进行深度反馈分析。
   * 低温度（0.2）确保输出稳定一致。
   */
  private async analyzeWithLLM(
    userMessage: string,
    assistantResponse: string,
    sessionId: string,
    quickSignal: FeedbackSignal,
  ): Promise<FeedbackAnalysis> {
    const systemPrompt = `你是一个对话质量分析专家。分析以下对话交互，判断用户的反馈信号。

请以 JSON 格式输出，包含以下字段：
- signal: 反馈信号类型，取值范围：positive, negative, neutral, confused, frustrated, repeated_request
- confidence: 置信度，0-1 之间的小数
- category: 反馈类别，取值范围：tool_usage（工具使用问题）, response_quality（回复质量问题）, memory_recall（记忆检索问题）, task_understanding（任务理解问题）, general（一般性反馈）
- suggestion: 改进建议（简洁的一句话，描述如何改进系统行为）

分析维度：
1. 用户是否在追问或要求重新回答（confused / repeated_request）
2. 用户的情绪是正面还是负面
3. 助手的回复是否充分回答了用户的问题
4. 是否存在工具使用、记忆检索等具体问题

规则提示：关键词初步检测信号为 "${quickSignal}"，请综合判断最终信号。

仅输出 JSON，不要有其他文字。`;

    const userPrompt = `用户消息：${userMessage.slice(0, 500)}

助手回复：${assistantResponse.slice(0, 500)}`;

    const response = await this.client.chat.completions.create({
      model: process.env.MODEL || "qwen-plus",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const raw = response.choices[0]?.message?.content?.trim() || "";

    // 提取 JSON（兼容 markdown code block 包裹）
    const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed: {
      signal?: string;
      confidence?: number;
      category?: string;
      suggestion?: string;
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      this.logger.warn("[FeedbackAnalyzer] LLM 输出 JSON 解析失败，使用降级结果", { raw: raw.slice(0, 100) });
      return this.buildFallbackAnalysis(userMessage, assistantResponse, sessionId, quickSignal);
    }

    const validSignals: FeedbackSignal[] = ["positive", "negative", "neutral", "confused", "frustrated", "repeated_request"];
    const signal: FeedbackSignal = validSignals.includes(parsed.signal as FeedbackSignal)
      ? (parsed.signal as FeedbackSignal)
      : quickSignal;

    return {
      id: this.generateId(),
      signal,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      category: parsed.category || "general",
      suggestion: parsed.suggestion,
      context: {
        userMessage,
        assistantResponse,
        sessionId,
        timestamp: Date.now(),
      },
    };
  }

  /**
   * 降级分析：当 LLM 不可用时基于规则生成分析结果。
   */
  private buildFallbackAnalysis(
    userMessage: string,
    assistantResponse: string,
    sessionId: string,
    signal: FeedbackSignal,
  ): FeedbackAnalysis {
    return {
      id: this.generateId(),
      signal,
      confidence: 0.4,
      category: "general",
      suggestion: undefined,
      context: {
        userMessage,
        assistantResponse,
        sessionId,
        timestamp: Date.now(),
      },
    };
  }

  /** 生成唯一反馈 ID */
  private generateId(): string {
    return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
