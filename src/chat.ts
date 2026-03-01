import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { listSkills, getSkill, type Skill } from "./skills";
import { TOOLS, executeTool, type ToolResult } from "./tools";
import { taskScheduler } from "./tasks";
import { userProfileStore } from "./profiles";

export interface ChatRequest {
  message: string;
  sessionId?: string;
  skill?: string;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
  skills?: Skill[];
  autoMatched?: string;
}

const useQwen = !!process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL?.includes("dashscope");

/**
 * 解析用户消息中的任务创建请求
 */
function parseTaskFromMessage(message: string): { name: string; message: string; schedule: string } | null {
  const lowerMessage = message.toLowerCase();
  
  // 匹配 "X分钟后/小时后/天"
  const minuteMatch = message.match(/(\d+)\s*分钟/);
  const hourMatch = message.match(/(\d+)\s*小时/);
  const dayMatch = message.match(/(\d+)\s*天/);
  
  let cronExpression = "";
  let taskName = "";
  
  if (minuteMatch) {
    const minutes = parseInt(minuteMatch[1]);
    cronExpression = `*/${minutes} * * * *`;
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
    // 尝试解析更复杂的定时表达式
    const everyHourMatch = message.match(/每\s*(\d+)\s*小时/);
    if (everyHourMatch) {
      cronExpression = `0 */${everyHourMatch[1]} * * *`;
      taskName = `每${everyHourMatch[1]}小时任务`;
    }
  }
  
  if (!cronExpression) return null;
  
  // 提取任务内容
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
 * 检查消息是否包含任务创建意图
 */
 * 检查消息是否匹配 skill 描述关键词
 */
function matchSkillByMessage(message: string, skills: Skill[]): Skill | null {
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
function parseToolCalls(response: string): { tool: string; args: Record<string, any> }[] {
  const toolCalls: { tool: string; args: Record<string, any> }[] = [];
  
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

class ChatEngine {
  private llm: ChatOpenAI;
  private sessions: Map<string, (HumanMessage | AIMessage)[]> = new Map();
  private sessionSkills: Map<string, Skill[]> = new Map();

  constructor() {
    const model = useQwen ? (process.env.MODEL || "qwen-plus") : (process.env.MODEL || "gpt-4o-mini");
    const baseURL = useQwen ? process.env.OPENAI_BASE_URL! : process.env.OPENAI_BASE_URL;
    const apiKey = useQwen ? process.env.OPENAI_API_KEY! : process.env.OPENAI_API_KEY;

    console.log("Using model:", model);
    console.log("Using baseURL:", baseURL);

    this.llm = new ChatOpenAI({
      model,
      temperature: 0.7,
      baseURL,
      apiKey,
    });
  }

  private getHistory(sessionId: string): (HumanMessage | AIMessage)[] {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    return this.sessions.get(sessionId)!;
  }

  private getSessionSkills(sessionId: string): Skill[] {
    if (!this.sessionSkills.has(sessionId)) {
      this.sessionSkills.set(sessionId, []);
    }
    return this.sessionSkills.get(sessionId)!;
  }

  private canUseSkill(skill: Skill, explicit: boolean): boolean {
    if (explicit && skill.disable_user_invocation) {
      return false;
    }
    if (!explicit && skill.disable_model_invocation) {
      return false;
    }
    return true;
  }

  private buildSystemMessage(sessionId: string): string {
    const skills = this.getSessionSkills(sessionId);
    const availableSkills = listSkills().filter(s => !s.disable_model_invocation);
    
    // 获取用户画像
    const profile = userProfileStore.get(sessionId);
    const profileMarkdown = userProfileStore.toMarkdown(profile);
    
    let systemPrompt = "You are a helpful AI assistant.";
    
    // 添加用户画像
    systemPrompt += "\n\n## User Profile\n";
    systemPrompt += "这是当前用户的画像信息，请根据这些信息提供更个性化的服务：\n";
    systemPrompt += profileMarkdown + "\n";
    
    systemPrompt += "\n\n## Available Tools\n";
    systemPrompt += "You can use tools to help with tasks. When you need to use a tool, respond with:\n";
    systemPrompt += "[TOOL_CALL]<tool_name>:{<args>}[/TOOL_CALL]\n\n";
    
    for (const tool of TOOLS) {
      systemPrompt += `### ${tool.name}\n`;
      systemPrompt += `${tool.description}\n`;
      systemPrompt += `Parameters: ${JSON.stringify(tool.parameters.properties)}\n\n`;
    }
    
    if (availableSkills.length > 0) {
      systemPrompt += "\n## Available Skills\n";
      systemPrompt += "When user asks about these topics, you can activate the relevant skill.\n";
      
      for (const skill of availableSkills) {
        systemPrompt += `\n### ${skill.name}\n`;
        systemPrompt += `${skill.description}\n`;
      }
    }
    
    if (skills.length > 0) {
      systemPrompt += "\n\n## Active Skills\n";
      for (const skill of skills) {
        systemPrompt += `\n### ${skill.name}\n`;
        systemPrompt += `${skill.instructions}\n`;
        if (skill.references?.length) {
          systemPrompt += `\n### References\n`;
          systemPrompt += skill.references.join("\n\n") + "\n";
        }
      }
    }
    
    return systemPrompt;
  }

  /**
   * 处理工具调用
   */
  private async processToolCalls(
    response: string,
    sessionId: string
  ): Promise<{ response: string; toolCalls: ToolResult[] }> {
    const toolCalls = parseToolCalls(response);
    if (toolCalls.length === 0) {
      return { response, toolCalls: [] };
    }

    const results: ToolResult[] = [];
    let finalResponse = response;
    const toolResults: string[] = [];

    for (const tc of toolCalls) {
      console.log(`Executing tool: ${tc.tool}`, tc.args);
      const result = await executeTool(tc.tool, tc.args);
      results.push(result);

      if (result.error) {
        toolResults.push(`工具执行失败: ${tc.tool} - ${result.error}`);
      } else {
        const output = result.output.length > 10000 
          ? result.output.substring(0, 10000) + "\n\n[内容过长，已截断...]" 
          : result.output;
        toolResults.push(`${tc.tool}: ${JSON.stringify(tc.args)} => ${output}`);
      }

      finalResponse = finalResponse.replace(
        /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/,
        ""
      );
    }

    const cleanedResponse = finalResponse.replace(/\[TOOL_RESULT\][\s\S]*?\[\/TOOL_RESULT\]/g, "").trim();

    const summaryPrompt = this.buildToolSummaryPrompt(cleanedResponse, toolResults);
    const summaryResponse = await this.llm.invoke([
      new HumanMessage(summaryPrompt)
    ]);

    return { response: summaryResponse.content as string, toolCalls: results };
  }

  /**
   * 构建工具执行总结的提示
   */
  private buildToolSummaryPrompt(originalResponse: string, toolResults: string[]): string {
    let prompt = "请用自然、友好的语言总结以下工具执行结果，并结合用户的原始请求给出回复。\n\n";
    
    if (originalResponse) {
      prompt += `原始回复:\n${originalResponse}\n\n`;
    }
    
    prompt += "工具执行结果:\n";
    for (const r of toolResults) {
      prompt += `- ${r}\n`;
    }
    
    prompt += "\n请用中文回复，语气友好自然，像和用户聊天一样。不要提及你是 AI 或模型。";
    
    return prompt;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const sessionId = request.sessionId || "default";
    
    // 检查是否需要创建任务
    const taskInfo = parseTaskFromMessage(request.message);
    if (taskInfo) {
      try {
        const task = taskScheduler.createTask({
          name: taskInfo.name,
          message: taskInfo.message,
          schedule: taskInfo.schedule,
          enabled: true,
        });
        
        return {
          response: `好的！我已经创建了定时任务「${task.name}」，将在 ${taskInfo.schedule} 执行。\n\n任务 ID: ${task.id}\n\n你可以说"取消任务"来删除它。`,
          sessionId,
        };
      } catch (error: any) {
        return {
          response: `创建任务失败: ${error.message}`,
          sessionId,
        };
      }
    }
    
    const history = this.getHistory(sessionId);
    const sessionSkills = this.getSessionSkills(sessionId);
    const availableSkills = listSkills();
    let autoMatched: string | undefined;
    
    if (request.skill) {
      const skill = getSkill(request.skill);
      if (skill && this.canUseSkill(skill, true)) {
        if (!sessionSkills.find(s => s.name === skill.name)) {
          sessionSkills.push(skill);
        }
      }
    } else {
      const matchedSkill = matchSkillByMessage(request.message, availableSkills);
      if (matchedSkill && !sessionSkills.find(s => s.name === matchedSkill.name)) {
        sessionSkills.push(matchedSkill);
        autoMatched = matchedSkill.name;
      }
    }

    const systemMessage = new SystemMessage(this.buildSystemMessage(sessionId));
    const messages = [systemMessage, ...history, new HumanMessage(request.message)];

    const response = await this.llm.invoke(messages);
    const responseText = response.content as string;

    const { response: finalResponse, toolCalls } = await this.processToolCalls(responseText, sessionId);

    history.push(new HumanMessage(request.message));
    history.push(new AIMessage(finalResponse));

    return {
      response: finalResponse,
      sessionId,
      skills: this.getSessionSkills(sessionId),
      autoMatched,
    };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionSkills.delete(sessionId);
  }

  getHistoryMessages(sessionId: string): (HumanMessage | AIMessage)[] {
    return this.getHistory(sessionId);
  }
}

export const chatEngine = new ChatEngine();
