export interface ParsedTask {
  name: string;
  message: string;
  schedule?: string;
  executeAfter?: number;
  type: "once" | "recurring" | null;
}

export async function parseTaskWithLLM(message: string): Promise<ParsedTask | null> {
  const taskKeywords = ["提醒", "定时", "schedule", "提醒我", "每天", "每周", "每小时"];
  const hasTaskKeyword = taskKeywords.some(k => message.includes(k));
  
  if (!hasTaskKeyword) {
    return null;
  }

  return null;
}
