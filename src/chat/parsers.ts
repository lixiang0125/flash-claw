import type { Skill } from "../skills";

/**
 * 任务解析结果
 */
export interface ParsedTask {
  name: string;
  message: string;
  schedule?: string;      // cron 表达式（循环任务）
  executeAfter?: number; // 毫秒（一次性任务）
  type: "once" | "recurring";
}

/**
 * 解析用户消息中的任务创建请求
 */
export function parseTaskFromMessage(message: string): ParsedTask | null {
  const lowerMessage = message.toLowerCase();
  
  const minuteMatch = message.match(/(\d+)\s*分钟/);
  const hourMatch = message.match(/(\d+)\s*小时/);
  const dayMatch = message.match(/(\d+)\s*天/);
  
  // 一次性任务：X分钟后/小时后/天后（不带"每"字）
  if (minuteMatch) {
    const minutes = parseInt(minuteMatch[1]);
    const executeAfter = minutes * 60 * 1000; // 转换为毫秒
    return {
      name: `${minutes}分钟后提醒`,
      message: extractTaskContent(message),
      executeAfter,
      type: "once",
    };
  }
  
  if (hourMatch) {
    const hours = parseInt(hourMatch[1]);
    const executeAfter = hours * 60 * 60 * 1000;
    return {
      name: `${hours}小时后提醒`,
      message: extractTaskContent(message),
      executeAfter,
      type: "once",
    };
  }
  
  if (dayMatch) {
    const days = parseInt(dayMatch[1]);
    const executeAfter = days * 24 * 60 * 60 * 1000;
    return {
      name: `${days}天后提醒`,
      message: extractTaskContent(message),
      executeAfter,
      type: "once",
    };
  }
  
  // 循环任务：每X分钟/每小时/每天
  if (lowerMessage.includes("每")) {
    const everyMinuteMatch = message.match(/每\s*(\d+)\s*分钟/);
    const everyHourMatch = message.match(/每\s*(\d+)\s*小时/);
    
    if (everyMinuteMatch) {
      const minutes = parseInt(everyMinuteMatch[1]);
      return {
        name: `每${minutes}分钟提醒`,
        message: extractTaskContent(message),
        schedule: `*/${minutes} * * * *`,
        type: "recurring",
      };
    }
    
    if (everyHourMatch) {
      const hours = parseInt(everyHourMatch[1]);
      return {
        name: `每${hours}小时提醒`,
        message: extractTaskContent(message),
        schedule: `0 */${hours} * * *`,
        type: "recurring",
      };
    }
    
    if (lowerMessage.includes("每天") || lowerMessage.includes("每天早上") || lowerMessage.includes("每天晚上")) {
      const hourMatch2 = message.match(/(?:早上|晚上|上午|下午)?\s*(\d{1,2})\s*点/);
      const hour = hourMatch2 ? parseInt(hourMatch2[1]) : 8;
      return {
        name: `每天${hour}点提醒`,
        message: extractTaskContent(message),
        schedule: `0 ${hour} * * *`,
        type: "recurring",
      };
    }
  }
  
  return null;
}

/**
 * 从消息中提取任务内容
 */
function extractTaskContent(message: string): string {
  return message
    .replace(/(\d+)\s*分钟/g, "")
    .replace(/(\d+)\s*小时/g, "")
    .replace(/(\d+)\s*天/g, "")
    .replace(/每|循环|定时|提醒|后|给我|发|条|消息/g, "")
    .trim() || "提醒消息";
}

/**
 * 检查消息是否匹配 skill 描述关键词
 */

/**
 * 将 cron 表达式转换为人类可读格式
 */
export function cronToHumanReadable(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;

  const [minute, hour, day, month, week] = parts;

  if (minute.startsWith("*/")) {
    const interval = minute.slice(2);
    if (hour === "*" && day === "*" && month === "*" && week === "*") {
      return `每 ${interval} 分钟`;
    }
  }

  if (minute === "*" && hour === "*" && day === "*" && month === "*" && week === "*") {
    return "每分钟";
  }

  if (minute.match(/^\d+$/) && hour.match(/^\d+$/)) {
    return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }

  return cron;
}
export function matchSkillByMessage(message: string, skills: Skill[]): Skill | null {
  const lowerMessage = message.toLowerCase();
  
  for (const skill of skills) {
    if (skill.disable_model_invocation) continue;
    
    const keywords = skill.description.toLowerCase().split(/[,，、\s]+/).filter(Boolean);
    for (const keyword of keywords) {
      if (keyword.length > 2 && lowerMessage.includes(keyword)) {
        return skill;
      }
    }
  }
  
  return null;
}

/**
 * 解析模型响应中的工具调用
 */
export function parseToolCalls(response: any): { tool: string; args: Record<string, unknown> }[] {
  if (typeof response !== "string") {
    return [];
  }
  
  const toolCalls: { tool: string; args: Record<string, unknown> }[] = [];
  
  const patterns = [
    /\[TOOL_CALL\]\s*(\w+)\s*:\s*(\{[\s\S]*?\})\s*\[\/TOOL_CALL\]/g,
    /<tool_call>\s*<tool>\s*(\w+)\s*<\/tool>\s*<args>\s*(\{[\s\S]*?\})\s*<\/args>\s*<\/tool_call>/g,
  ];

  for (const pattern of patterns) {
    const matches = response.matchAll(pattern);
    for (const match of matches) {
      try {
        toolCalls.push({
          tool: match[1],
          args: JSON.parse(match[2]),
        });
      } catch {
        // Continue to next pattern
      }
    }
  }

  return toolCalls;
}
