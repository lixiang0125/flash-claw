import OpenAI from "openai";
import type { Logger } from "../core/container/tokens";
import type { ConversationMessage } from "./working-memory";

/**
 * Pre-compaction memory flush agent.
 *
 * Inspired by OpenClaw's design: when the working memory is about to be
 * compressed (context nearing overflow), a silent "agentic turn" is injected.
 * The LLM reviews recent messages and extracts only what's worth persisting
 * to the daily markdown file.
 *
 * Key differences from a naive per-message logger:
 *   - The LLM decides what matters (not every message gets recorded)
 *   - Outputs structured, categorized notes
 *   - Returns empty string if nothing is worth remembering (NO_REPLY)
 *   - Only fires once per compaction cycle (controlled by WorkingMemory)
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
   * Pre-compaction agentic flush.
   *
   * Called by the WorkingMemory flush callback when context is about to
   * overflow. Reviews recent messages and extracts durable memories.
   *
   * @param messages  Recent conversation messages about to be compacted.
   * @param sessionId Session identifier for context.
   * @returns Markdown notes to persist, or empty string if nothing worth saving.
   */
  async extractMemories(
    messages: ConversationMessage[],
    sessionId: string,
  ): Promise<string> {
    if (messages.length === 0) return "";

    const conversationText = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
      .join("\n\n");

    if (!conversationText.trim()) return "";

    const prompt = `You are a memory extraction agent. A conversation session is about to be compacted (older messages will be summarized and truncated). Your job is to extract ONLY the information worth remembering long-term.

Rules:
1. Extract: key facts, user preferences, important decisions, action items, technical choices
2. Skip: greetings, small talk, repetitive content, transient debugging, obvious context
3. If nothing is worth remembering, respond with exactly: NO_REPLY
4. Output concise bullet points in Markdown, categorized by topic
5. Use the same language as the conversation
6. Be very selective - only genuinely durable information

Session: ${sessionId.slice(0, 8)}
Conversation:
${conversationText}

Extract durable memories (or NO_REPLY):`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.2,
      });

      const result = response.choices[0]?.message?.content?.trim() || "";

      if (result === "NO_REPLY" || result.length < 5) {
        this.logger.debug(`Pre-compaction flush: nothing worth saving (session ${sessionId.slice(0, 8)})`);
        return "";
      }

      this.logger.info(`Pre-compaction flush: extracted memories`, {
        sessionId: sessionId.slice(0, 8),
        resultLength: result.length,
      });
      return result;
    } catch (err) {
      this.logger.error("Pre-compaction memory extraction failed", { err });
      return "";
    }
  }

  /**
   * Batch summarize for explicit daily digest (e.g., on process exit).
   * Falls back to this when there are buffered turns that never triggered
   * a pre-compaction flush.
   */
  async summarize(
    turns: Array<{ user: string; assistant: string; sessionId: string }>,
    date: string,
  ): Promise<string> {
    if (turns.length === 0) return "";

    const conversationText = turns
      .map(
        (t, i) =>
          `[Session ${t.sessionId.slice(0, 8)}] Turn ${i + 1}:\nUser: ${t.user.slice(0, 500)}\nAssistant: ${t.assistant.slice(0, 500)}`,
      )
      .join("\n\n");

    const prompt = `You are a memory system. Summarize the following conversations from ${date} into a concise daily digest.

Rules:
1. Extract key facts, user preferences, important decisions, and action items
2. Categorize by topic (not chronologically)
3. Use concise bullet points
4. Skip greetings and repetitive content
5. If user mentioned personal info (name, preferences, habits), list separately
6. Use the same language as the conversations
7. If nothing worth saving, respond with: NO_REPLY

Conversations:
${conversationText}

Daily digest:`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1500,
        temperature: 0.3,
      });

      const result = response.choices[0]?.message?.content?.trim() || "";
      if (result === "NO_REPLY") return "";

      this.logger.info(`Daily summary generated for ${date}`, {
        turns: turns.length,
        summaryLength: result.length,
      });
      return result;
    } catch (err) {
      this.logger.error("Failed to generate daily summary", { err, date });
      return turns
        .map((t) => `- ${t.user.slice(0, 100)}`)
        .join("\n");
    }
  }

  /**
   * Periodic consolidation: extract durable facts from daily logs into MEMORY.md.
   * Compares daily log content against existing long-term memory to avoid duplicates.
   * 
   * @param dailyContents Array of daily markdown file contents (most recent first)
   * @param existingMemory Current content of MEMORY.md
   * @returns New facts/preferences to append to MEMORY.md, or empty string if nothing new
   */
  async consolidateDailyLogs(
    dailyContents: string[],
    existingMemory: string,
  ): Promise<string> {
    if (dailyContents.length === 0) return "";

    const combinedLogs = dailyContents.join("\n\n---\n\n").slice(0, 8000);
    const existingSlice = existingMemory.slice(0, 3000);

    const prompt = `You are a long-term memory consolidation agent. Your job is to extract DURABLE facts from recent daily conversation logs and merge them into the user's permanent memory file.

## Existing Long-Term Memory (MEMORY.md):
${existingSlice || "(empty)"}

## Recent Daily Logs:
${combinedLogs}

## Rules:
1. Extract ONLY durable, reusable facts: user identity, preferences, habits, skills, relationships, recurring projects, important decisions
2. DO NOT extract: transient tasks, debugging details, one-off questions, greetings, temporary context
3. DO NOT duplicate information already in the existing memory above
4. Output as Markdown bullet points, grouped under sections: ## People, ## Preferences, ## Projects, ## Decisions, ## Skills, ## Other
5. Only include sections that have new content
6. Use the same language as the source material
7. If nothing new is worth adding, respond with exactly: NO_REPLY
8. Be very selective — this is permanent memory

New facts to add:`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1500,
        temperature: 0.2,
      });

      const result = response.choices[0]?.message?.content?.trim() || "";

      if (result === "NO_REPLY" || result.length < 10) {
        this.logger.debug("Consolidation: nothing new to add to MEMORY.md");
        return "";
      }

      this.logger.info("Consolidation: extracted new durable facts", {
        resultLength: result.length,
        dailyLogCount: dailyContents.length,
      });
      return result;
    } catch (err) {
      this.logger.error("Memory consolidation LLM call failed", { err });
      return "";
    }
  }
}
