import { chatEngine } from "../chat";
import type { FeedbackAnalysis } from "./feedback_analyzer";

export interface EvolutionPlan {
  planId: string;
  feedbackId: string;
  type: string;
  description: string;
  action: "update_skill" | "create_skill" | "update_prompt" | "update_config" | "update_tool";
  targetPath: string;
  newContent: string;
  riskLevel: "low" | "medium" | "high";
  createTime: number;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const PLANNER_PROMPT = `你是 Flash Claw 的进化方案生成助手。根据反馈需求，生成可执行的进化方案。

项目结构：
- Skills 路径：.flashclaw/skills/ 或 src/skills/
- 工具定义：src/tools/index.ts
- 配置：src/config.ts 或 .env
- System Prompt：src/chat/engine.ts

进化类型对应操作：
- skill_optimize: 更新现有 Skill（修改 .flashclaw/skills/{skill_name}/SKILL.md）
- skill_add: 新增 Skill（创建新目录和 SKILL.md）
- prompt_optimize: 更新 System Message 中的行为指南
- config_adjust: 更新配置参数
- tool_fix: 修复工具执行逻辑

输出 JSON 格式：
{
  "planId": "uuid",
  "feedbackId": "反馈ID",
  "type": "skill_optimize",
  "description": "优化代码审查 Skill，增加更多检查规则",
  "action": "update_skill",
  "targetPath": ".flashclaw/skills/code-review/SKILL.md",
  "newContent": "skill 的完整新内容（SKILL.md 格式）",
  "riskLevel": "medium"
}`;

export async function generateEvolutionPlan(analysis: FeedbackAnalysis): Promise<EvolutionPlan | null> {
  if (analysis.type === "normal_chat") {
    return null;
  }

  try {
    const response = await chatEngine.chat({
      message: `${PLANNER_PROMPT}\n\n反馈需求：${analysis.demand}\n反馈类型：${analysis.type}\n\n请生成进化方案。`,
      sessionId: "system:evolution-planner",
    });

    const content = response.response;
    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        planId: parsed.planId || generateId(),
        feedbackId: analysis.id,
        type: parsed.type || analysis.type,
        description: parsed.description || "",
        action: parsed.action || "update_skill",
        targetPath: parsed.targetPath || "",
        newContent: parsed.newContent || "",
        riskLevel: parsed.riskLevel || "medium",
        createTime: Date.now(),
      };
    }

    return null;
  } catch (error) {
    console.error("[Evolution] Generate plan failed:", error);
    return null;
  }
}
