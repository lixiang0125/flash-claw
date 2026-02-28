import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { listSkills, getSkill, type Skill } from "./skills";

export interface ChatRequest {
  message: string;
  sessionId?: string;
  skill?: string;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
  skills?: Skill[];
}

const useQwen = !!process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL?.includes("dashscope");

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

  private buildSystemMessage(sessionId: string): string {
    const skills = this.getSessionSkills(sessionId);
    const availableSkills = listSkills();
    
    let systemPrompt = "You are a helpful AI assistant.";
    
    if (availableSkills.length > 0) {
      systemPrompt += "\n\n## Available Skills\n";
      systemPrompt += "You can use skills to help with specific tasks. Use the 'skill' parameter to load a skill.\n";
      
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
        if (skill.examples?.length) {
          systemPrompt += `\nExamples:\n${skill.examples.join("\n")}\n`;
        }
      }
    }
    
    return systemPrompt;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const sessionId = request.sessionId || "default";
    const history = this.getHistory(sessionId);
    
    if (request.skill) {
      const skill = getSkill(request.skill);
      if (skill) {
        const sessionSkills = this.getSessionSkills(sessionId);
        if (!sessionSkills.find(s => s.name === skill.name)) {
          sessionSkills.push(skill);
        }
      }
    }

    const systemMessage = new SystemMessage(this.buildSystemMessage(sessionId));
    const messages = [systemMessage, ...history, new HumanMessage(request.message)];

    const response = await this.llm.invoke(messages);

    history.push(new HumanMessage(request.message));
    history.push(new AIMessage(response.content as string));

    return {
      response: response.content as string,
      sessionId,
      skills: this.getSessionSkills(sessionId),
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
