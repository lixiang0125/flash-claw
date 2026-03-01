import { chatEngine } from "../chat";

export type FeedbackType = 
  | "skill_optimize"
  | "skill_add"
  | "prompt_optimize"
  | "config_adjust"
  | "tool_fix"
  | "normal_chat";

export interface FeedbackAnalysis {
  id: string;
  originalFeedback: string;
  type: FeedbackType;
  demand: string;
  priority: "high" | "medium" | "low";
  createTime: number;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const ANALYSIS_PROMPT = `你是 Flash Claw 的反馈分析助手，需要分析用户输入是否为进化类反馈。

规则：
1. 进化类型：
   - skill_optimize: 优化现有 Skill（如"你的代码审查 Skill 不好用"）
   - skill_add: 新增 Skill（如"希望你能帮我生成图表"）
   - prompt_optimize: 优化 AI 回复风格（如"回答太啰嗦了"）
   - config_adjust: 调整配置（如"超时时间太短"）
   - tool_fix: 修复工具问题（如"网页抓取总是失败"）
   - normal_chat: 普通对话，无进化价值

2. 判断标准：
   - 涉及功能问题、体验优化、新增能力 → 进化类
   - 纯问答、闲聊 → normal_chat

3. demand 要明确：需要优化什么、解决什么问题

4. 优先级：
   - high: 影响核心功能（如工具失败）
   - medium: 体验优化（如回答太长）
   - low: 非必要新增

输出 JSON 格式（无额外文字）：
{
  "id": "uuid",
  "type": "skill_optimize",
  "demand": "优化代码审查 Skill，增加更多检查规则",
  "priority": "high"
}`;

export async function analyzeFeedback(userInput: string): Promise<FeedbackAnalysis> {
  try {
    const response = await chatEngine.chat({
      message: `${ANALYSIS_PROMPT}\n\n用户输入：${userInput}`,
      sessionId: "system:feedback-analyzer",
    });

    const content = response.response;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        id: parsed.id || generateId(),
        originalFeedback: userInput,
        type: parsed.type || "normal_chat",
        demand: parsed.demand || "",
        priority: parsed.priority || "low",
        createTime: Date.now(),
      };
    }

    return createDefaultAnalysis(userInput);
  } catch (error) {
    console.error("[Evolution] Feedback analysis failed:", error);
    return createDefaultAnalysis(userInput);
  }
}

function createDefaultAnalysis(userInput: string): FeedbackAnalysis {
  return {
    id: generateId(),
    originalFeedback: userInput,
    type: "normal_chat",
    demand: "",
    priority: "low",
    createTime: Date.now(),
  };
}
