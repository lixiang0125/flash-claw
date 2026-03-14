import OpenAI from "openai";
import type { Logger } from "../core/container/tokens";

/**
 * Uses the project's main LLM (same as ChatEngine) to summarize a day's
 * conversations into a concise markdown digest.
 *
 * Design rationale:
 *   - Reuses OPENAI_API_KEY / OPENAI_BASE_URL / MODEL — no extra config
 *   - Produces structured, human-readable markdown
 *   - Idempotent: can be called multiple times for the same day (overwrites)
 */
export class DailySummarizer {
  private client: OpenAI;
  private model: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.model = process.env.MODEL || "qwen3.5-plus";
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "",
      baseURL:
        process.env.OPENAI_BASE_URL ||
        "https://coding.dashscope.aliyuncs.com/v1",
    });
  }

  /**
   * Summarize a list of conversation turns into a daily digest.
   *
   * @param turns  Array of { user, assistant } message pairs from today.
   * @param date   ISO date string (YYYY-MM-DD).
   * @returns      Markdown-formatted daily summary.
   */
  async summarize(
    turns: Array<{ user: string; assistant: string; sessionId: string }>,
    date: string,
  ): Promise<string> {
    if (turns.length === 0) return "";

    const conversationText = turns
      .map(
        (t, i) =>
          `[会话 ${t.sessionId.slice(0, 8)}] 第${i + 1}轮:\n用户: ${t.user.slice(0, 500)}\n助手: ${t.assistant.slice(0, 500)}`,
      )
      .join("\n\n");

    const prompt = `你是一个记忆系统的摘要助手。请将以下 ${date} 的对话记录总结为一份精炼的每日摘要。

要求：
1. 提取关键事实、用户偏好、重要决定和待办事项
2. 按主题分类（不按时间顺序）
3. 使用简洁的 bullet points
4. 忽略闲聊和重复内容
5. 如果用户提到了个人信息（姓名、偏好、习惯等），单独列出
6. 输出纯 Markdown，不要包裹在代码块中

对话记录:
${conversationText}

请输出每日摘要:`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1500,
        temperature: 0.3,
      });

      const summary = response.choices[0]?.message?.content?.trim() || "";
      this.logger.info(`Daily summary generated for ${date}`, {
        turns: turns.length,
        summaryLength: summary.length,
      });
      return summary;
    } catch (err) {
      this.logger.error("Failed to generate daily summary", { err, date });
      // Fallback: return a simple bullet list of topics
      return turns
        .map((t) => `- ${t.user.slice(0, 100)}`)
        .join("\n");
    }
  }
}
