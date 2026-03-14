/**
 * LLM-based task parser & memory query rewriter.
 *
 * Replaces the regex-based parseTaskFromMessage() with an LLM call that
 * understands natural language in any language (Chinese, English, Japanese, etc.)
 * and extracts structured task scheduling info.
 *
 * Also provides rewriteMemoryQuery() to replace the hardcoded Chinese regex
 * patterns in buildMemorySearchText().
 *
 * Uses OpenAI SDK pointed at DashScope (Qwen) backend via env vars:
 *   OPENAI_BASE_URL, OPENAI_API_KEY, MODEL
 */

import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedTask {
  name: string;
  message: string;
  schedule?: string;
  executeAfter?: number;
  type: "once" | "recurring";
}

interface LLMTaskResponse {
  isTask: boolean;
  name?: string;
  message?: string;
  type?: "once" | "recurring";
  schedule?: string;
  executeAfter?: number;
}

// ---------------------------------------------------------------------------
// Shared client (lazy singleton)
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.OPENAI_API_KEY || "",
      timeout: 10_000, // 10s hard timeout on the HTTP request
    });
  }
  return _client;
}

function getModel(): string {
  return process.env.MODEL || "qwen-plus";
}

// ---------------------------------------------------------------------------
// LRU cache — avoids duplicate LLM calls for the same message
// ---------------------------------------------------------------------------

class LRUCache<V> {
  private map = new Map<string, { value: V; ts: number }>();

  constructor(
    private maxSize: number = 128,
    private ttlMs: number = 5 * 60_000, // 5 min default
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most-recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key); // refresh position
    if (this.map.size >= this.maxSize) {
      // Evict oldest (first entry)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, ts: Date.now() });
  }
}

const taskCache = new LRUCache<ParsedTask | null>(128, 5 * 60_000);
const memoryQueryCache = new LRUCache<string>(256, 3 * 60_000);

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const TASK_PARSE_SYSTEM_PROMPT = `You are a task-scheduling intent detector. Analyze the user's message and determine if it is a task scheduling request (reminder, alarm, timer, recurring job, etc.).

You MUST be multilingual — the user may write in Chinese (中文), English, Japanese (日本語), Korean (한국어), or any other language. Understand scheduling intent regardless of language.

## Rules

1. If the message is NOT a task/reminder/scheduling request, respond with exactly:
   {"isTask": false}

2. If it IS a task request, respond with one of:

   For ONE-TIME tasks (e.g. "remind me in 5 minutes", "3小时后提醒我", "30分後にリマインド"):
   {"isTask": true, "name": "<short task name>", "message": "<what to remind>", "type": "once", "executeAfter": <milliseconds>}

   For RECURRING tasks (e.g. "every day at 9am", "每天早上9点", "毎日9時に"):
   {"isTask": true, "name": "<short task name>", "message": "<what to remind>", "type": "recurring", "schedule": "<5-field cron>"}

## Time conversion for one-time tasks (executeAfter in milliseconds)
- 1 minute  = 60000
- 5 minutes = 300000
- 1 hour    = 3600000
- 1 day     = 86400000
- "half an hour" / "半小时" = 1800000

## Cron expression guide (5-field: minute hour day month weekday)
- "every day at 9:00"       → "0 9 * * *"
- "every hour"              → "0 * * * *"
- "every 30 minutes"        → "*/30 * * * *"
- "every Monday at 10:00"   → "0 10 * * 1"
- "weekdays at 8:30"        → "30 8 * * 1-5"
- "every day at 14:30"      → "30 14 * * *"
- Weekday numbers: Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6

## "name" field
Keep it short and descriptive (under 20 chars). Use the user's language.

## "message" field
Extract the actual content/action the user wants to be reminded about, stripping the scheduling part. If no specific content, use a generic reminder phrase in the user's language.

## Important
- Output ONLY the JSON object. No markdown fences, no explanation, no extra text.
- Do NOT treat casual conversation, questions, or statements about the past as task requests.
- "3分钟前我吃了饭" (I ate 3 minutes AGO) is NOT a task. Only future-oriented scheduling counts.
- "remind me" / "提醒我" / "リマインドして" are strong task signals.
- Bare time references without any action intent are NOT tasks.`;

const MEMORY_REWRITE_SYSTEM_PROMPT = `You are a search query optimizer. Given a user's chat message, generate 3-5 concise search keywords that would help retrieve relevant memories/facts about this user from a memory store.

Rules:
- Output ONLY the keywords separated by spaces. No explanation, no punctuation, no markdown.
- Be language-agnostic: if the user writes in Chinese, output Chinese keywords; if English, output English keywords. Mix is fine.
- Focus on the INTENT behind the question — what kind of stored facts would answer it.
- For identity questions ("who am I", "我是谁") → output keywords about user facts, name, identity, occupation.
- For preference questions ("what do I like") → output keywords about preferences, interests, habits.
- For recall questions ("remember when", "之前说过") → output keywords about past conversations, history, facts.
- For location questions → output keywords about location, city, address.
- For simple factual/general questions that don't need personal memory (e.g. "what is 2+2", "weather today"), just return the original message unchanged.
- Keep total output under 50 characters when possible.`;

// ---------------------------------------------------------------------------
// parseTaskWithLLM
// ---------------------------------------------------------------------------

/**
 * Use an LLM to parse a user message for task-scheduling intent.
 *
 * Returns a ParsedTask if the message is a scheduling request, null otherwise.
 * On any error (network, parse, timeout) returns null silently.
 */
export async function parseTaskWithLLM(
  message: string,
): Promise<ParsedTask | null> {
  const cached = taskCache.get(message);
  if (cached !== undefined) return cached;

  try {
    const client = getClient();

    const response = await client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: TASK_PARSE_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    // Strip markdown fences if the model wraps output despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed: LLMTaskResponse = JSON.parse(cleaned);

    if (!parsed.isTask) { taskCache.set(message, null); return null; }

    // Validate required fields
    if (!parsed.name || !parsed.message || !parsed.type) { taskCache.set(message, null); return null; }

    if (parsed.type === "once") {
      if (typeof parsed.executeAfter !== "number" || parsed.executeAfter <= 0) return null;
      const result: ParsedTask = {
        name: parsed.name,
        message: parsed.message,
        type: "once",
        executeAfter: parsed.executeAfter,
      };
      taskCache.set(message, result);
      return result;
    }

    if (parsed.type === "recurring") {
      if (typeof parsed.schedule !== "string" || !parsed.schedule.trim()) return null;
      // Basic cron validation: must be 5 space-separated fields
      const cronParts = parsed.schedule.trim().split(/\s+/);
      if (cronParts.length !== 5) return null;
      const result: ParsedTask = {
        name: parsed.name,
        message: parsed.message,
        type: "recurring",
        schedule: parsed.schedule.trim(),
      };
      taskCache.set(message, result);
      return result;
    }

    taskCache.set(message, null);
    return null;
  } catch {
    // Network error, JSON parse error, timeout — don't cache (transient failure)
    return null;
  }
}

// ---------------------------------------------------------------------------
// rewriteMemoryQuery
// ---------------------------------------------------------------------------

/**
 * Use an LLM to rewrite a user message into optimal memory-search keywords.
 *
 * Replaces the hardcoded Chinese regex patterns in buildMemorySearchText().
 * Returns a space-separated keyword string suitable for vector search.
 * On any failure, returns the original message as a safe fallback.
 */
export async function rewriteMemoryQuery(
  message: string,
): Promise<string> {
  const cached = memoryQueryCache.get(message);
  if (cached !== undefined) return cached;

  try {
    const client = getClient();

    const response = await client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: MEMORY_REWRITE_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      temperature: 0.1,
      max_tokens: 100,
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return message;

    // Sanity check: if the response is unreasonably long, fall back
    if (raw.length > 200) return message;

    memoryQueryCache.set(message, raw);
    return raw;
  } catch {
    // On any failure, return the original message — always safe
    return message;
  }
}
