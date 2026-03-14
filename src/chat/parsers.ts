import type { Skill } from "../skills";

/**
 * Task parsing result
 */
export interface ParsedTask {
  name: string;
  message: string;
  schedule?: string;      // cron expression (recurring)
  executeAfter?: number;  // ms (one-time)
  type: "once" | "recurring";
}

/**
 * Intent keywords that must be present for task creation.
 * Without these, a message like "3 minutes ago I ate" would wrongly
 * create a 3-minute reminder.
 */
const TASK_INTENT = /(?:提醒|定时|闹钟|记得|别忘|remind|timer|alarm|schedule|每|after|later)/i;

/**
 * Parse task creation requests from user messages.
 * Returns null if the message is NOT a task request.
 */
export function parseTaskFromMessage(message: string): ParsedTask | null {
  // Gate: must contain at least one task-intent keyword
  if (!TASK_INTENT.test(message)) return null;

  const lowerMessage = message.toLowerCase();

  // ---- One-time: "X分钟后提醒我..." ----
  const onceMinute = message.match(/(\d+)\s*分钟\s*(?:后|之后)/);
  if (onceMinute) {
    const minutes = parseInt(onceMinute[1] ?? "0", 10);
    if (minutes > 0 && minutes <= 10080) { // max 7 days
      return {
        name: `${minutes}分钟后提醒`,
        message: extractTaskContent(message),
        executeAfter: minutes * 60 * 1000,
        type: "once",
      };
    }
  }

  const onceHour = message.match(/(\d+)\s*(?:小时|个小时)\s*(?:后|之后)/);
  if (onceHour) {
    const hours = parseInt(onceHour[1] ?? "0", 10);
    if (hours > 0 && hours <= 168) {
      return {
        name: `${hours}小时后提醒`,
        message: extractTaskContent(message),
        executeAfter: hours * 60 * 60 * 1000,
        type: "once",
      };
    }
  }

  const onceDay = message.match(/(\d+)\s*天\s*(?:后|之后)/);
  if (onceDay) {
    const days = parseInt(onceDay[1] ?? "0", 10);
    if (days > 0 && days <= 30) {
      return {
        name: `${days}天后提醒`,
        message: extractTaskContent(message),
        executeAfter: days * 24 * 60 * 60 * 1000,
        type: "once",
      };
    }
  }

  // ---- Recurring: "每X分钟..." ----
  if (lowerMessage.includes("每")) {
    const everyMinute = message.match(/每\s*(\d+)\s*分钟/);
    if (everyMinute) {
      const minutes = parseInt(everyMinute[1] ?? "0", 10);
      if (minutes >= 1 && minutes <= 1440) {
        return {
          name: `每${minutes}分钟提醒`,
          message: extractTaskContent(message),
          schedule: `*/${minutes} * * * *`,
          type: "recurring",
        };
      }
    }

    const everyHour = message.match(/每\s*(\d+)\s*(?:小时|个小时)/);
    if (everyHour) {
      const hours = parseInt(everyHour[1] ?? "0", 10);
      if (hours >= 1 && hours <= 24) {
        return {
          name: `每${hours}小时提醒`,
          message: extractTaskContent(message),
          schedule: `0 */${hours} * * *`,
          type: "recurring",
        };
      }
    }

    if (/每天/.test(lowerMessage)) {
      const timeMatch = message.match(/(?:早上|上午|下午|晚上)?\s*(\d{1,2})\s*(?:点|:|：)\s*(\d{0,2})/);
      let hour = 8;
      let minute = 0;
      if (timeMatch) {
        hour = parseInt(timeMatch[1] ?? "8", 10);
        minute = parseInt(timeMatch[2] || "0", 10);
        // Handle "下午3点" / "晚上8点"
        if (/下午|晚上/.test(message) && hour < 12) hour += 12;
      }
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return {
          name: `每天${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}提醒`,
          message: extractTaskContent(message),
          schedule: `${minute} ${hour} * * *`,
          type: "recurring",
        };
      }
    }

    // "每周X" pattern
    const weekdayMap: Record<string, number> = {
      "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0,
    };
    const weekMatch = message.match(/每(?:周|星期)([一二三四五六日天])/);
    if (weekMatch && weekMatch[1]) {
      const dow = weekdayMap[weekMatch[1]] ?? 1;
      const timeMatch2 = message.match(/(\d{1,2})\s*(?:点|:|：)\s*(\d{0,2})/);
      const h = timeMatch2 ? parseInt(timeMatch2[1] ?? "9", 10) : 9;
      const m = timeMatch2 ? parseInt(timeMatch2[2] || "0", 10) : 0;
      return {
        name: `每周${weekMatch[1]}提醒`,
        message: extractTaskContent(message),
        schedule: `${m} ${h} * * ${dow}`,
        type: "recurring",
      };
    }
  }

  return null;
}

/**
 * Extract the actual task content from the message,
 * stripping scheduling keywords.
 */
function extractTaskContent(message: string): string {
  return message
    .replace(/\d+\s*分钟\s*(?:后|之后)/g, "")
    .replace(/\d+\s*(?:小时|个小时)\s*(?:后|之后)/g, "")
    .replace(/\d+\s*天\s*(?:后|之后)/g, "")
    .replace(/每\s*\d*\s*(?:分钟|小时|个小时)/g, "")
    .replace(/每天|每周.{1}/g, "")
    .replace(/(?:早上|上午|下午|晚上)?\s*\d{1,2}\s*(?:点|:|：)\s*\d{0,2}/g, "")
    .replace(/提醒我?|定时|循环|闹钟|记得|别忘|给我|发|条|消息/g, "")
    .trim() || "提醒";
}

/**
 * Convert cron expression to human-readable Chinese.
 */
export function cronToHumanReadable(cron: string): string {
  if (cron === "once") return "一次性";

  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;

  const [minute, hour, _day, _month, week] = parts;

  // */N * * * * -> 每N分钟
  if (minute?.startsWith("*/") && hour === "*") {
    return `每 ${minute.slice(2)} 分钟`;
  }

  // 0 */N * * * -> 每N小时
  if (minute === "0" && hour?.startsWith("*/")) {
    return `每 ${hour.slice(2)} 小时`;
  }

  // M H * * * -> 每天 HH:MM
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && week === "*") {
    return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }

  // M H * * DOW -> 每周X HH:MM
  if (minute?.match(/^\d+$/) && hour?.match(/^\d+$/) && week?.match(/^\d$/)) {
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
    const dayName = dayNames[parseInt(week, 10)] ?? week;
    return `每周${dayName} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }

  return cron;
}

export function matchSkillByMessage(message: string, skills: Skill[]): Skill | null {
  const lowerMessage = message.toLowerCase();

  for (const skill of skills) {
    if (skill.disable_model_invocation) continue;

    const keywords = skill.description
      .toLowerCase()
      .split(/[,\uff0c\u3001\s]+/)
      .filter(Boolean);
    for (const keyword of keywords) {
      if (keyword.length > 2 && lowerMessage.includes(keyword)) {
        return skill;
      }
    }
  }

  return null;
}

export function parseToolCalls(
  response: any,
): { tool: string; args: Record<string, unknown> }[] {
  if (typeof response !== "string") return [];

  const toolCalls: { tool: string; args: Record<string, unknown> }[] = [];

  const patterns = [
    /\[TOOL_CALL\]\s*(\w+)\s*:\s*(\{[\s\S]*?\})\s*\[\/TOOL_CALL\]/g,
    /<tool_call>\s*<tool>\s*(\w+)\s*<\/tool>\s*<args>\s*(\{[\s\S]*?\})\s*<\/args>\s*<\/tool_call>/g,
  ];

  for (const pattern of patterns) {
    const matches = response.matchAll(pattern);
    for (const match of matches) {
      try {
        const toolName = match[1];
        const toolArgs = match[2];
        if (!toolName || !toolArgs) continue;
        toolCalls.push({ tool: toolName, args: JSON.parse(toolArgs) });
      } catch {
        // skip malformed
      }
    }
  }

  return toolCalls;
}
