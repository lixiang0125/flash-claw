import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { chatEngine } from "../chat";
import type { EvolutionPlan } from "./evolution_planner";

const EVOLUTION_LOG = join(process.cwd(), "evolution.log");

interface EvolutionResult {
  success: boolean;
  message: string;
  planId: string;
}

export async function executeEvolutionPlan(plan: EvolutionPlan): Promise<EvolutionResult> {
  console.log(`[Evolution] Executing plan: ${plan.description}`);

  try {
    const targetPath = join(process.cwd(), plan.targetPath);

    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(targetPath)) {
      const backupPath = `${targetPath}.backup.${Date.now()}`;
      writeFileSync(backupPath, readFileSync(targetPath));
      console.log(`[Evolution] Backed up: ${targetPath}`);
    }

    writeFileSync(targetPath, plan.newContent, "utf-8");
    console.log(`[Evolution] Written: ${plan.targetPath}`);

    const log = `${new Date().toISOString()} | ${plan.planId} | ${plan.type} | ${plan.description} | success\n`;
    writeFileSync(EVOLUTION_LOG, log, { flag: "a" });

    return {
      success: true,
      message: `进化成功：${plan.description}`,
      planId: plan.planId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Evolution] Failed:`, errorMessage);

    const log = `${new Date().toISOString()} | ${plan.planId} | ${plan.type} | ${plan.description} | failed: ${errorMessage}\n`;
    writeFileSync(EVOLUTION_LOG, log, { flag: "a" });

    return {
      success: false,
      message: `进化失败：${errorMessage}`,
      planId: plan.planId,
    };
  }
}

export async function verifyEvolution(plan: EvolutionPlan): Promise<boolean> {
  console.log(`[Evolution] Verifying: ${plan.type}`);

  try {
    switch (plan.type) {
      case "skill_optimize":
      case "skill_add": {
        const { listSkills } = await import("../skills");
        const skillName = plan.targetPath.split("/").slice(-2)[0];
        const skills = listSkills();
        return skills.some(s => s.name === skillName);
      }
      case "tool_fix": {
        return true;
      }
      default:
        return true;
    }
  } catch (error) {
    console.error("[Evolution] Verification failed:", error);
    return false;
  }
}

export async function evolve(analysis: any): Promise<EvolutionResult> {
  const { generateEvolutionPlan } = await import("./evolution_planner");
  const plan = await generateEvolutionPlan(analysis);

  if (!plan) {
    return {
      success: false,
      message: "无需进化",
      planId: "",
    };
  }

  if (plan.riskLevel === "high") {
    console.log(`[Evolution] High risk plan requires user confirmation: ${plan.description}`);
  }

  const result = await executeEvolutionPlan(plan);

  if (result.success) {
    const verified = await verifyEvolution(plan);
    if (!verified) {
      return {
        success: false,
        message: "进化验证失败",
        planId: plan.planId,
      };
    }
  }

  return result;
}
