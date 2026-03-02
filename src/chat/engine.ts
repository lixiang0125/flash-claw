import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { listSkills, getSkill, type Skill } from "../skills";
import { TOOLS, executeTool, type ToolResult } from "../tools";
import { taskScheduler } from "../tasks";
import { userProfileStore } from "../profiles";
import { readUser, readSoul, readMemory, updateMemory, updateUser, extractInfoToRemember } from "../memory";
import { subAgentSystem } from "../subagents";
import { analyzeComplexity } from "../subagents/analyzer";
import { analyzeFeedback, evolve } from "../evolution";
import type { ChatRequest, ChatResponse } from "./types";
import { parseTaskFromMessage, matchSkillByMessage, parseToolCalls, cronToHumanReadable } from "./parsers";
import { parseTaskWithLLM } from "./llm-parser";

const useQwen = !!process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL?.includes("dashscope");

const MAX_TOOL_RETRIES = 3;
const MAX_ITERATIONS = 3;
const ENABLE_SELF_REVIEW = true;
const ENABLE_AUTO_SUBAGENT = true;

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

    const llmConfig: any = {
      modelName: model,
      temperature: 0.7,
    };
    
    if (baseURL) {
      llmConfig.configuration = {
        baseURL,
      };
    }
    if (apiKey) {
      llmConfig.apiKey = apiKey;
    }
    
    this.llm = new ChatOpenAI(llmConfig);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { message, sessionId = "default" } = request;

    const history = this.getHistory(sessionId);
    const skills = this.getSessionSkills(sessionId);

    try {
      const { user, soul, memory } = this.loadContext(sessionId);
      const taskResult = await this.parseAndScheduleTask(message, sessionId);

      let context = this.buildContext(user, soul, memory, skills);
      let messages = [...context, ...history, new HumanMessage(message)];

      let iterations = 0;
      let lastResponse = "";

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await this.llm.invoke(messages);

        const content = response.content as string;
        lastResponse = content;

        if (typeof content !== "string") {
          break;
        }

        messages.push(new AIMessage(content));

        const toolCalls = parseToolCalls(response);
        if (toolCalls.length === 0) {
          break;
        }

        for (const toolCall of toolCalls) {
          let retries = 0;
          let toolResult: ToolResult | undefined;

          while (retries < MAX_TOOL_RETRIES) {
            try {
              toolResult = await executeTool(toolCall.name, toolCall.args);
              break;
            } catch (error) {
              retries++;
              console.error(`Tool ${toolCall.name} failed (retry ${retries}):`, error);
            }
          }

          if (toolResult) {
            const resultContent = toolResult.error || JSON.stringify(toolResult.result);
            messages.push(new AIMessage({
              content: "",
              tool_calls: [{
                id: toolCall.id || toolCall.name,
                name: toolCall.name,
                args: toolCall.args,
              }],
            }));
            messages.push(new HumanMessage(resultContent));
          }
        }

        if (iterations >= MAX_ITERATIONS - 1) {
          break;
        }
      }

      this.saveContext(sessionId, message, lastResponse);
      history.push(new HumanMessage(message));
      history.push(new AIMessage(lastResponse));

      return {
        response: lastResponse,
        sessionId,
        task: taskResult,
      };
    } catch (error: any) {
      console.error("Chat error:", error);
      return {
        response: `处理消息时出错: ${error.message}`,
        sessionId,
      };
    }
  }

  private loadContext(sessionId: string) {
    const user = readUser(sessionId);
    const soul = readSoul();
    const memory = readMemory(sessionId);
    return { user, soul, memory };
  }

  private saveContext(sessionId: string, message: string, response: string) {
    const info = extractInfoToRemember(message);
    if (info) {
      updateUser(sessionId, info);
    }
  }

  private buildContext(user: any, soul: any, memory: any, skills: Skill[]) {
    const messages: (HumanMessage | SystemMessage)[] = [];

    let systemPrompt = soul?.prompt || "You are a helpful AI assistant.";
    if (skills.length > 0) {
      const skillDescriptions = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
      systemPrompt += `\n\nAvailable skills:\n${skillDescriptions}`;
    }

    messages.push(new SystemMessage(systemPrompt));

    if (user?.name) {
      messages.push(new HumanMessage(`User's name: ${user.name}`));
    }

    if (memory) {
      messages.push(new HumanMessage(`User memory: ${memory}`));
    }

    return messages;
  }

  private async parseAndScheduleTask(message: string, sessionId: string) {
    const task = parseTaskFromMessage(message);
    if (task) {
      const schedule = task.cron || cronToHumanReadable(task.cron || "");
      await taskScheduler.createTask({
        name: task.name,
        message: task.message,
        schedule,
      });
      return `已创建任务: ${task.name} - ${schedule}`;
    }

    try {
      const result = await parseTaskWithLLM(message);
      if (result) {
        await taskScheduler.createTask({
          name: result.name,
          message: result.message,
          schedule: result.schedule,
        });
        return `已创建任务: ${result.name}`;
      }
    } catch (error) {
      console.error("Task parsing error:", error);
    }

    return null;
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

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionSkills.delete(sessionId);
  }

  getHistoryMessages(sessionId: string): (HumanMessage | AIMessage)[] {
    return this.getHistory(sessionId);
  }
}

export const chatEngine = new ChatEngine();
