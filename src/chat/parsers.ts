import type { Skill } from "../skills";

/**
 * 解析用户消息中的任务创建请求
 */
export function parseTaskFromMessage(message: string): { name: string; message: string; schedule: string } | null {
  const lowerMessage = message.toLowerCase();
  
  const minuteMatch = message.match(/(\d+)\s*分钟/);
  const hourMatch = message.match(/(\d+)\s*小时/);
  const dayMatch = message.match(/(\d+)\s*天/);
  
  let cronExpression = "";
  let taskName = "";
  
  if (minuteMatch) {
    const minutes = parseInt(minuteMatch[1]);
    // cron-parser doesn't support */X, convert to * with appropriate range
    cronExpression = `*/${minutes} * * * *`;
    // For cron-parser, we need to use a workaround for intervals
    if (minutes > 1) {
      cronExpression = `*/${minutes} * * * *`;
    } else {
      cronExpression = `* * * * *`; // every minute
    }
    taskName = `${minutes}分钟后提醒`;
  } else if (hourMatch) {
    const hours = parseInt(hourMatch[1]);
    cronExpression = `0 */${hours} * * *`;
    taskName = `${hours}小时后提醒`;
  } else if (dayMatch) {
    const days = parseInt(dayMatch[1]);
    cronExpression = `0 0 */${days} * *`;
    taskName = `${days}天后提醒`;
  } else if (lowerMessage.includes("每") || lowerMessage.includes("循环") || lowerMessage.includes("定时")) {
    const everyHourMatch = message.match(/每\s*(\d+)\s*小时/);
    if (everyHourMatch) {
      cronExpression = `0 */${everyHourMatch[1]} * * *`;
      taskName = `每${everyHourMatch[1]}小时任务`;
    }
  }
  
  if (!cronExpression) return null;
  
  let taskMessage = message
    .replace(/(\d+)\s*分钟/g, "")
    .replace(/(\d+)\s*小时/g, "")
    .replace(/(\d+)\s*天/g, "")
    .replace(/每|循环|定时|提醒|后|给我|发|条|消息/g, "")
    .trim();
  
  if (!taskMessage) {
    taskMessage = "提醒消息";
  }
  
  return {
    name: taskName || "定时任务",
    message: taskMessage,
    schedule: cronExpression
  };
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
export function parseToolCalls(response: string): { tool: string; args: Record<string, unknown> }[] {
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
