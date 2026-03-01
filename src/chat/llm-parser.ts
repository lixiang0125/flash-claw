import { HumanMessage } from "@langchain/core/messages";

export interface ParsedTask {
  name: string;
  message: string;
  schedule?: string;
  executeAfter?: number;
  type: "once" | "recurring" | null;
}

const TASK_EXTRACTION_PROMPT = `你需要从用户消息中提取任务信息。

用户可能请求创建以下类型的任务：
1. 一次性任务：在指定时间后执行一次
2. 循环任务：按固定周期重复执行

分析用户消息，判断是否包含任务创建请求。

用户消息: "{message}"

请以 JSON 格式返回分析结果：
{
  "isTask": true/false,
  "taskType": "once/recurring/null",
  "timeValue": 数字（分钟/小时/天数，如果是循环任务则是周期）,
  "timeUnit": "minute/hour/day",
  "taskContent": "从消息中提取的任务内容",
  "cronExpression": "如果是循环任务，给出 cron 表达式",
  "executeAfterMs": "如果是一次性任务，给出毫秒数"
}

注意事项：
- "每X分钟" -> cron: */X * * * *
- "每X小时" -> cron: 0 */X * * *
- "每X天" -> cron: 0 0 */X * *
- "每天早上8点" -> cron: 0 8 * * *
- "每天晚上9点" -> cron: 0 21 * * *
- "1分钟后" -> executeAfterMs = 60000
- "2小时后" -> executeAfterMs = 7200000

请只返回 JSON，不要有其他内容。`;

export async function parseTaskWithLLM(message: string, llm: any): Promise<ParsedTask | null> {
  const prompt = TASK_EXTRACTION_PROMPT.replace("{message}", message);
  
  try {
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const content = response.content as string;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (!parsed.isTask) {
      return null;
    }
    
    let name = "";
    let executeAfter: number | undefined;
    let schedule: string | undefined;
    
    if (parsed.taskType === "once" && parsed.executeAfterMs) {
      executeAfter = parsed.executeAfterMs;
      const minutes = Math.round(executeAfter / 60000);
      name = `${minutes}分钟后提醒`;
    } else if (parsed.taskType === "recurring" && parsed.cronExpression) {
      schedule = parsed.cronExpression;
      name = scheduleToName(schedule);
    }
    
    return {
      name,
      message: parsed.taskContent || message,
      schedule,
      executeAfter,
      type: parsed.taskType as "once" | "recurring",
    };
  } catch (error) {
    console.error("[TaskParser] LLM parsing failed:", error);
    return null;
  }
}

function scheduleToName(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return "定时任务";
  
  const [minute, hour] = parts;
  
  if (minute.startsWith("*/")) {
    const interval = minute.slice(2);
    return `每${interval}分钟提醒`;
  }
  
  if (hour.startsWith("*/")) {
    const interval = hour.slice(2);
    return `每${interval}小时提醒`;
  }
  
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/)) {
    return `每天${hour.padStart(2, "0")}:${minute.padStart(2, "0")}提醒`;
  }
  
  return "定时任务";
}
