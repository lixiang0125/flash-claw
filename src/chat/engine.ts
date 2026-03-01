import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { listSkills, getSkill, type Skill } from "../skills";
import { TOOLS, executeTool, type ToolResult } from "../tools";
import { taskScheduler } from "../tasks";
import { userProfileStore } from "../profiles";
import { readUser, readSoul, readMemory, updateMemory, updateUser, extractInfoToRemember } from "../memory";
import { subAgentSystem } from "../subagents";
import { analyzeComplexity } from "../subagents/analyzer";
import type { ChatRequest, ChatResponse } from "./types";
import { parseTaskFromMessage, matchSkillByMessage, parseToolCalls, cronToHumanReadable } from "./parsers";

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
    
    const soulContent = readSoul();
    const userContent = readUser();
    const memoryContent = readMemory();
    
    let systemPrompt = soulContent + "\n\n";
    
    systemPrompt += "## User Information (USER.md)\n";
    systemPrompt += "这是用户的个人信息，请根据这些信息提供更个性化的服务：\n";
    systemPrompt += userContent + "\n";
    
    systemPrompt += "## Long-term Memory (MEMORY.md)\n";
    systemPrompt += "这是用户的长期记忆，重要的事情会被记录：\n";
    systemPrompt += memoryContent + "\n";
    
    systemPrompt += "\n\n## Available Tools\n";
    systemPrompt += "You can use tools to help with tasks. When you need to use a tool, respond with:\n";
    systemPrompt += "[TOOL_CALL]<tool_name>:{<args>}[/TOOL_CALL]\n\n";
    
    for (const tool of TOOLS) {
      systemPrompt += `### ${tool.name}\n`;
      systemPrompt += `${tool.description}\n`;
      systemPrompt += `Parameters: ${JSON.stringify(tool.parameters.properties)}\n\n`;
    }

    systemPrompt += `
## SubAgent 使用指南

对于复杂耗时的任务，你可以考虑使用 SubAgent 工具启动子智能体并行处理：

**建议使用子智能体的场景**:
- 多文件操作: 涉及 3 个以上文件的读写/编辑
- 多个独立任务: 任务可分解为多个并行执行的子任务
- 耗时长命令: npm install、docker build、编译等
- 批量处理: 批量修改文件、批量搜索等

**调用方式**:
[TOOL_CALL]<SubAgent>:{"task": "子任务描述", "label": "任务标签"}[/TOOL_CALL]

子智能体会在后台独立运行，完成后自动向主会话报告结果。

`;
    
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

  private async processToolCalls(
    response: string,
    sessionId: string
  ): Promise<{ response: string; toolCalls: ToolResult[] }> {
    const toolCalls = parseToolCalls(response);
    if (toolCalls.length === 0) {
      return { response, toolCalls: [] };
    }

    let results: ToolResult[] = [];
    let finalResponse = response;

    for (const tc of toolCalls) {
      let lastError: string | undefined;
      
      for (let retry = 0; retry < MAX_TOOL_RETRIES; retry++) {
        console.log(`Executing tool: ${tc.tool} (attempt ${retry + 1}/${MAX_TOOL_RETRIES})`, tc.args);
        const result = await executeTool(tc.tool, tc.args);
        results.push(result);

        if (result.error) {
          lastError = result.error;
          console.log(`Tool ${tc.tool} failed: ${result.error}, retrying...`);
          
          const retryPrompt = this.buildRetryPrompt(tc.tool, tc.args, result.error, retry + 1);
          const retryResponse = await this.llm.invoke([new HumanMessage(retryPrompt)]);
          
          const newToolCalls = parseToolCalls(retryResponse.content as string);
          if (newToolCalls.length > 0) {
            const newTc = newToolCalls[0]!;
            tc.tool = newTc.tool;
            tc.args = newTc.args;
            results.pop();
          }
        } else {
          lastError = undefined;
          break;
        }
      }

      if (lastError) {
        console.log(`Tool ${tc.tool} failed after ${MAX_TOOL_RETRIES} retries`);
      }

      const result = results[results.length - 1];
      if (!result) {
        continue;
      }
      
      if (result.error) {
        finalResponse = finalResponse.replace(
          /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/,
          ""
        );
      } else {
        const output = result.output.length > 10000 
          ? result.output.substring(0, 10000) + "\n\n[内容过长，已截断...]" 
          : result.output;
        finalResponse = finalResponse.replace(
          /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/,
          `[TOOL_RESULT]${tc.tool}: ${JSON.stringify(tc.args)} => ${output}[/TOOL_RESULT]`
        );
      }
    }

    return { response: finalResponse, toolCalls: results };
  }

  private buildRetryPrompt(tool: string, args: Record<string, unknown>, error: string, attempt: number): string {
    return `工具执行失败，需要你修复参数或换一种方式执行。

失败的工具: ${tool}
参数: ${JSON.stringify(args, null, 2)}
错误信息: ${error}
尝试次数: ${attempt}/${MAX_TOOL_RETRIES}

请重新分析任务，选择正确的工具和参数。如果原来的工具不适合，请选择其他合适的工具。
请直接输出新的工具调用格式，不要添加任何解释。

如果是文件相关错误，可能需要：
1. 先用 Glob 或 Grep 查找正确的文件路径
2. 用 Read 查看文件内容确认格式
3. 确保 oldString 完全匹配文件中的内容（注意空格和缩进）

请给出修复后的工具调用:`;
  }

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
    
    const taskInfo = parseTaskFromMessage(request.message);
    if (taskInfo) {
      try {
        let taskPrompt: string;
        
        if (taskInfo.type === "once") {
          // 一次性任务：立即调度，到期后自动删除
          const task = taskScheduler.createOneTimeTask({
            name: taskInfo.name,
            message: taskInfo.message,
            executeAfter: taskInfo.executeAfter!,
          });
          
          const minutes = Math.round(taskInfo.executeAfter! / 60000);
          const timeText = minutes >= 60 ? `${Math.round(minutes / 60)}小时` : `${minutes}分钟`;
          
          taskPrompt = `用户请求创建一个一次性任务。
任务名称: ${task.name}
任务内容: ${taskInfo.message}
将在: ${timeText}后执行

请用友好、自然的方式告诉用户任务已创建。用中文回复。`;
        } else {
          // 循环任务
          const task = taskScheduler.createTask({
            name: taskInfo.name,
            message: taskInfo.message,
            schedule: taskInfo.schedule!,
            enabled: true,
          });
          
          const scheduleText = cronToHumanReadable(taskInfo.schedule!);
          
          taskPrompt = `用户请求创建定时任务。
任务名称: ${task.name}
任务内容: ${taskInfo.message}
执行计划: ${scheduleText}

请用友好、自然的方式告诉用户任务已创建。不要提及任务 ID。用中文回复。`;
        }
        
        const llmResponse = await this.llm.invoke([new HumanMessage(taskPrompt)]);
        
        return {
          response: llmResponse.content as string,
          sessionId,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          response: `创建任务失败: ${message}`,
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

    let response = await this.llm.invoke(messages);
    let responseText = response.content as string;

    const toolCalls = parseToolCalls(responseText);

    if (toolCalls.length > 0) {
      const analysis = this.analyzeBeforeExecution(toolCalls, request.message);
      
      if (analysis.shouldSpawn) {
        console.log(`[AutoSubAgent] Task complexity detected: ${analysis.reason}`);
        
        const existingRuns = subAgentSystem.listRuns(sessionId);
        if (existingRuns.length < 5) {
          for (const subTask of analysis.subTasks) {
            await subAgentSystem.spawn({
              task: subTask,
              label: "auto-subagent",
              mode: "run",
              cleanup: "keep",
            }, sessionId);
            console.log(`[AutoSubAgent] Spawned sub-agent for: ${subTask.substring(0, 50)}...`);
          }
        }
      }
    }

    let { response: processedResponse, toolCalls: executedToolCalls } = await this.processToolCalls(responseText, sessionId);

    if (ENABLE_SELF_REVIEW && executedToolCalls.length > 0) {
      const hasFailures = executedToolCalls.some(tc => tc.error);
      if (hasFailures) {
        processedResponse = await this.selfReviewLoop(request.message, processedResponse, executedToolCalls, sessionId);
      }
    }

    history.push(new HumanMessage(request.message));
    history.push(new AIMessage(processedResponse));

    this.maybeUpdateMemory(request.message, processedResponse);

    return {
      response: processedResponse,
      sessionId,
      skills: this.getSessionSkills(sessionId),
      autoMatched,
    };
  }

  private async selfReviewLoop(
    userMessage: string,
    currentResponse: string,
    toolCalls: ToolResult[],
    sessionId: string
  ): Promise<string> {
    let bestResponse = currentResponse;
    let hasFailures = toolCalls.some(tc => tc.error);

    if (!hasFailures) {
      return bestResponse;
    }

    console.log(`[Self-Iteration] Starting self-review loop (max ${MAX_ITERATIONS} iterations)`);

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      console.log(`[Self-Iteration] Iteration ${iteration + 1}/${MAX_ITERATIONS}`);

      const failedTools = toolCalls.filter(tc => tc.error);
      const reviewPrompt = this.buildSelfReviewPrompt(userMessage, bestResponse, failedTools);

      const reviewResponse = await this.llm.invoke([new HumanMessage(reviewPrompt)]);
      const reviewText = reviewResponse.content as string;

      const { response: newResponse, toolCalls: newToolCalls } = await this.processToolCalls(reviewText, sessionId);

      const newHasFailures = newToolCalls.some(tc => tc.error);
      
      if (!newHasFailures) {
        console.log(`[Self-Iteration] All tools succeeded, accepting new response`);
        bestResponse = newResponse;
        break;
      }

      const allFailedBefore = failedTools.length;
      const allFailedNow = newToolCalls.filter(tc => tc.error).length;
      
      if (allFailedNow >= allFailedBefore) {
        console.log(`[Self-Iteration] No improvement, stopping`);
        break;
      }

      bestResponse = newResponse;
      toolCalls = newToolCalls;
    }

    return bestResponse;
  }

  private buildSelfReviewPrompt(userMessage: string, currentResponse: string, failedTools: ToolResult[]): string {
    let prompt = `你需要审查并改进你对用户请求的回复。

用户原始请求: "${userMessage}"

当前回复:
${currentResponse}

工具执行失败:
`;
    for (const tc of failedTools) {
      prompt += `- ${tc.tool}: ${tc.error}\n`;
    }

    prompt += `
请分析失败原因，并尝试修复。你可以选择：
1. 修正工具参数后重试
2. 使用其他工具替代
3. 调整执行顺序（如先读取文件确认内容再编辑）
4. 改变方法来完成用户的任务

请直接输出修复后的回复，包含必要的工具调用。不要添加任何解释。`;

    return prompt;
  }

  /**
   * 检查并更新记忆（USER.md 和 MEMORY.md）
   */
  private async maybeUpdateMemory(userMessage: string, _assistantResponse: string): Promise<void> {
    const infoToRemember = extractInfoToRemember(userMessage);
    if (!infoToRemember) return;

    try {
      if (infoToRemember.type === "user") {
        // 更新 USER.md
        const updatePrompt = `用户告诉你了一些个人信息，需要更新到 USER.md 中。

当前 USER.md 内容:
${readUser()}

用户说的信息: "${userMessage}"

请提取并更新 USER.md 中对应的信息。只更新相关部分，保留其他内容。
请直接回复更新后的完整 USER.md 内容，不要添加任何解释。`;

        const llmResponse = await this.llm.invoke([new HumanMessage(updatePrompt)]);
        const content = llmResponse.content as string;

        if (content.includes("#") && content.length > 50) {
          updateUser(content);
          console.log("[USER.md] Updated from conversation");
        }
      } else {
        // 更新 MEMORY.md
        const updatePrompt = `用户告诉你了一些重要的事情，需要决定是否要更新到 MEMORY.md 中。

当前 MEMORY.md 内容:
${readMemory()}

用户说的信息: "${userMessage}"

请判断这条信息是否值得永久记住。如果是，请给出更新后的 MEMORY.md 内容。如果不是，请回复"不需要记住"。
请直接回复更新后的内容，不要添加任何解释。`;

        const llmResponse = await this.llm.invoke([new HumanMessage(updatePrompt)]);
        const content = llmResponse.content as string;

        if (!content.includes("不需要记住") && content.length > 20) {
          updateMemory(content);
          console.log("[MEMORY.md] Updated from conversation");
        }
      }
    } catch (error) {
      console.error("[Memory] Update failed:", error);
    }
  }

  private analyzeBeforeExecution(
    toolCalls: { tool: string; args: Record<string, unknown> }[],
    userMessage: string
  ): { shouldSpawn: boolean; reason: string; subTasks: string[] } {
    const uniqueTools = new Set(toolCalls.map(tc => tc.tool));
    const toolCount = toolCalls.length;
    
    let subTasks: string[] = [];
    let reason = "";
    let shouldSpawn = false;

    if (toolCount >= 3 || uniqueTools.size >= 3) {
      shouldSpawn = true;
      reason = `检测到 ${toolCount} 个工具调用，涉及 ${uniqueTools.size} 种工具`;
      
      for (const tc of toolCalls) {
        if (tc.tool === "Write" || tc.tool === "Edit") {
          subTasks.push(`${tc.tool}: ${tc.args.filePath || "未知文件"}`);
        } else if (tc.tool === "Bash") {
          subTasks.push(`执行命令: ${tc.args.command}`);
        } else if (tc.tool === "Glob" || tc.tool === "Grep") {
          subTasks.push(`搜索: ${tc.args.pattern || tc.args.filePath}`);
        } else {
          subTasks.push(`${tc.tool}: ${JSON.stringify(tc.args).substring(0, 50)}`);
        }
      }
    }

    const userMessageLower = userMessage.toLowerCase();
    const complexKeywords = ["批量", "多个", "所有", "批量处理", "批量修改", "转换", "refactor", "batch"];
    const hasComplexKeyword = complexKeywords.some(k => userMessageLower.includes(k));
    
    if (hasComplexKeyword && toolCount >= 2) {
      shouldSpawn = true;
      reason = "检测到复杂任务模式";
      
      if (subTasks.length === 0) {
        subTasks = [userMessage];
      }
    }

    const longCommands = ["npm install", "yarn", "pip install", "docker build", "docker run", "make"];
    const hasLongCommand = toolCalls.some(tc => 
      tc.tool === "Bash" && longCommands.some(cmd => (tc.args.command as string || "").toLowerCase().includes(cmd))
    );
    
    if (hasLongCommand) {
      shouldSpawn = true;
      reason = "包含耗时较长的命令执行";
    }

    return { shouldSpawn, reason, subTasks };
  }

  private async maybeSpawnSubAgents(
    userMessage: string,
    toolCalls: ToolResult[],
    sessionId: string
  ): Promise<void> {
    const parsedToolCalls = toolCalls.map(tc => ({ tool: tc.tool, args: tc as unknown as Record<string, unknown> }));
    const analysis = analyzeComplexity(parsedToolCalls, userMessage);

    if (!analysis.shouldUseSubAgent) {
      return;
    }

    console.log(`[AutoSubAgent] Task complexity detected: ${analysis.reason}`);
    console.log(`[AutoSubAgent] Estimated files: ${analysis.estimatedFiles}, time: ${analysis.estimatedTime}s`);

    const existingRuns = subAgentSystem.listRuns(sessionId);
    if (existingRuns.length >= 5) {
      console.log("[AutoSubAgent] Too many active sub-agents, skipping");
      return;
    }

    for (const subTask of analysis.subTasks) {
      const taskDescription = subTask.description || userMessage;

      await subAgentSystem.spawn({
        task: taskDescription,
        label: subTask.tool,
        mode: "run",
        cleanup: "keep",
      }, sessionId);

      console.log(`[AutoSubAgent] Spawned sub-agent for: ${taskDescription.substring(0, 50)}...`);
    }
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
