/**
 * @module evolution/strategy-planner
 * @description 进化策略规划器。
 *
 * 根据累积的反馈分析结果，使用 LLM 生成或更新进化策略。
 * 策略以 Markdown 文件（EVOLUTION.md）持久化到 data/workspace 目录，
 * 符合项目 "文件即真相" 的设计理念。
 */

import OpenAI from "openai";
import * as fs from "fs/promises";
import * as path from "path";
import type { Logger, AppConfig } from "../core/container/tokens";
import type { FeedbackAnalysis, EvolutionStrategy } from "./types";

/** EVOLUTION.md 文件的默认路径 */
const EVOLUTION_FILENAME = "EVOLUTION.md";

/**
 * 策略规划器。
 * 负责根据反馈生成/更新进化策略，并将策略持久化到 Markdown 文件。
 *
 * @class StrategyPlanner
 */
export class StrategyPlanner {
  private client: OpenAI;
  private logger: Logger;
  private evolutionFilePath: string;

  constructor(logger: Logger, config: AppConfig) {
    this.logger = logger;
    this.evolutionFilePath = path.resolve(config.workspacePath, EVOLUTION_FILENAME);
    this.client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.OPENAI_API_KEY || "",
    });
  }

  /**
   * 根据累积反馈生成新的进化策略。
   * 使用 LLM 分析反馈模式，生成可操作的策略列表。
   *
   * @param feedbacks - 待分析的反馈列表
   * @param existingStrategies - 当前已存在的策略列表
   * @returns 新生成的策略列表
   */
  async planStrategies(
    feedbacks: FeedbackAnalysis[],
    existingStrategies: EvolutionStrategy[],
  ): Promise<EvolutionStrategy[]> {
    if (feedbacks.length === 0) {
      this.logger.debug("[StrategyPlanner] 无反馈，跳过策略规划");
      return [];
    }

    try {
      return await this.planWithLLM(feedbacks, existingStrategies);
    } catch (err) {
      this.logger.error("[StrategyPlanner] LLM 策略规划失败，使用规则降级", { err });
      return this.planWithRules(feedbacks, existingStrategies);
    }
  }

  /**
   * 使用 LLM 进行策略规划。
   */
  private async planWithLLM(
    feedbacks: FeedbackAnalysis[],
    existingStrategies: EvolutionStrategy[],
  ): Promise<EvolutionStrategy[]> {
    const feedbackSummary = feedbacks.map((f) => ({
      signal: f.signal,
      category: f.category,
      confidence: f.confidence,
      suggestion: f.suggestion,
    }));

    const existingSummary = existingStrategies.map((s) => ({
      id: s.id,
      category: s.category,
      description: s.description,
      priority: s.priority,
    }));

    const systemPrompt = `你是一个 AI 系统自我改进规划专家。根据用户反馈分析结果，生成改进策略。

现有策略：
${JSON.stringify(existingSummary, null, 2)}

请以 JSON 数组格式输出新策略，每个策略包含：
- category: 策略类别（tool_usage / response_quality / memory_recall / task_understanding / general）
- description: 策略描述（简洁明了）
- promptAdjustment: system prompt 补充指令（具体可操作的行为指导，中文）
- priority: 优先级 1-10

规则：
1. 不要重复已有策略的内容
2. 每条策略必须有具体可执行的 promptAdjustment
3. 最多输出 3 条新策略
4. 优先处理高频出现的负面反馈

仅输出 JSON 数组，不要有其他文字。`;

    const response = await this.client.chat.completions.create({
      model: process.env.MODEL || "qwen-plus",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `反馈分析结果：\n${JSON.stringify(feedbackSummary, null, 2)}` },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });

    const raw = response.choices[0]?.message?.content?.trim() || "[]";
    const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed: Array<{
      category?: string;
      description?: string;
      promptAdjustment?: string;
      priority?: number;
    }>;
    try {
      parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) parsed = [];
    } catch {
      this.logger.warn("[StrategyPlanner] LLM 输出解析失败", { raw: raw.slice(0, 100) });
      return this.planWithRules(feedbacks, existingStrategies);
    }

    const now = Date.now();
    const feedbackIds = feedbacks.map((f) => f.id);

    return parsed.slice(0, 3).map((item) => ({
      id: `strat_${now}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      category: item.category || "general",
      description: item.description || "自动生成的改进策略",
      promptAdjustment: item.promptAdjustment,
      priority: Math.max(1, Math.min(10, item.priority ?? 5)),
      status: "active" as const,
      appliedCount: 0,
      feedbackIds,
    }));
  }

  /**
   * 规则降级策略规划：当 LLM 不可用时，基于简单规则生成策略。
   */
  private planWithRules(
    feedbacks: FeedbackAnalysis[],
    existingStrategies: EvolutionStrategy[],
  ): EvolutionStrategy[] {
    const now = Date.now();
    const feedbackIds = feedbacks.map((f) => f.id);
    const strategies: EvolutionStrategy[] = [];

    // 统计各类反馈信号数量
    const signalCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    for (const f of feedbacks) {
      signalCounts[f.signal] = (signalCounts[f.signal] || 0) + 1;
      categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
    }

    // 已有策略的类别集合，避免重复
    const existingCategories = new Set(existingStrategies.map((s) => s.category));

    // 如果存在较多困惑信号，生成回复清晰度策略
    if ((signalCounts["confused"] || 0) >= 2 && !existingCategories.has("response_quality")) {
      strategies.push({
        id: `strat_${now}_rule_clarity`,
        createdAt: now,
        category: "response_quality",
        description: "提升回复清晰度：用户多次表现出困惑",
        promptAdjustment: "回复时请使用更简洁清晰的语言，避免技术术语，必要时分步骤说明。",
        priority: 7,
        status: "active",
        appliedCount: 0,
        feedbackIds,
      });
    }

    // 如果存在重复请求信号，生成任务理解策略
    if ((signalCounts["repeated_request"] || 0) >= 2 && !existingCategories.has("task_understanding")) {
      strategies.push({
        id: `strat_${now}_rule_understanding`,
        createdAt: now,
        category: "task_understanding",
        description: "加强任务理解：用户多次重复请求",
        promptAdjustment: "在执行任务前，先确认理解用户意图，必要时复述要求再执行。",
        priority: 8,
        status: "active",
        appliedCount: 0,
        feedbackIds,
      });
    }

    // 如果工具使用类反馈较多，生成工具优化策略
    if ((categoryCounts["tool_usage"] || 0) >= 2 && !existingCategories.has("tool_usage")) {
      strategies.push({
        id: `strat_${now}_rule_tools`,
        createdAt: now,
        category: "tool_usage",
        description: "优化工具调用：工具使用相关反馈较多",
        promptAdjustment: "调用工具前先分析是否必要，优先使用最简单有效的工具组合，避免不必要的工具链。",
        priority: 6,
        status: "active",
        appliedCount: 0,
        feedbackIds,
      });
    }

    return strategies;
  }

  /**
   * 将策略列表和统计信息写入 EVOLUTION.md 文件。
   *
   * @param strategies - 所有策略列表
   * @param totalFeedbacks - 累计反馈总数
   * @param feedbackStats - 各信号类型的统计计数
   * @param historyEntries - 进化历史记录
   */
  async writeEvolutionFile(
    strategies: EvolutionStrategy[],
    totalFeedbacks: number,
    feedbackStats: Record<string, number>,
    historyEntries: Array<{ time: string; event: string; description: string }>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const activeStrategies = strategies.filter((s) => s.status === "active");

    let md = `# FlashClaw 进化策略\n\n`;
    md += `> 自动生成，请勿手动编辑。最后更新: ${now}\n\n`;

    // 活跃策略
    md += `## 活跃策略\n\n`;
    if (activeStrategies.length === 0) {
      md += `_暂无活跃策略_\n\n`;
    } else {
      for (const s of activeStrategies.sort((a, b) => b.priority - a.priority)) {
        md += `### ${s.description}\n`;
        md += `- **类别**: ${s.category}\n`;
        md += `- **优先级**: ${s.priority}/10\n`;
        md += `- **状态**: ${s.status}\n`;
        md += `- **应用次数**: ${s.appliedCount}\n`;
        if (s.promptAdjustment) {
          md += `- **Prompt 调整**: ${s.promptAdjustment}\n`;
        }
        if (s.effectiveness !== undefined) {
          md += `- **效果评分**: ${(s.effectiveness * 100).toFixed(0)}%\n`;
        }
        md += `- **创建时间**: ${new Date(s.createdAt).toISOString()}\n`;
        md += `\n`;
      }
    }

    // 反馈统计
    md += `## 反馈统计\n\n`;
    md += `- 总反馈数: ${totalFeedbacks}\n`;
    md += `- 正面: ${feedbackStats["positive"] || 0} | 负面: ${feedbackStats["negative"] || 0} | 中性: ${feedbackStats["neutral"] || 0}\n`;
    md += `- 困惑: ${feedbackStats["confused"] || 0} | 沮丧: ${feedbackStats["frustrated"] || 0} | 重复请求: ${feedbackStats["repeated_request"] || 0}\n\n`;

    // 进化历史
    md += `## 进化历史\n\n`;
    md += `| 时间 | 事件 | 描述 |\n`;
    md += `|------|------|------|\n`;
    for (const entry of historyEntries.slice(-20)) {
      md += `| ${entry.time} | ${entry.event} | ${entry.description} |\n`;
    }
    md += `\n`;

    // 确保目录存在
    const dir = path.dirname(this.evolutionFilePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(this.evolutionFilePath, md, "utf-8");
    this.logger.info("[StrategyPlanner] EVOLUTION.md 已更新", {
      strategies: activeStrategies.length,
      totalFeedbacks,
    });
  }

  /**
   * 从 EVOLUTION.md 文件读取现有策略列表。
   * 如果文件不存在则返回空数组。
   */
  async readStrategies(): Promise<EvolutionStrategy[]> {
    try {
      const content = await fs.readFile(this.evolutionFilePath, "utf-8");
      return this.parseStrategiesFromMarkdown(content);
    } catch {
      // 文件不存在或读取失败
      return [];
    }
  }

  /**
   * 从 Markdown 内容解析策略列表。
   * 解析 "活跃策略" 部分的 h3 标题和属性列表。
   */
  private parseStrategiesFromMarkdown(content: string): EvolutionStrategy[] {
    const strategies: EvolutionStrategy[] = [];

    // 提取 "## 活跃策略" 到下一个 "##" 之间的内容
    const sectionMatch = content.match(/## 活跃策略\n\n([\s\S]*?)(?=\n## |$)/);
    if (!sectionMatch) return [];

    const section = sectionMatch[1] ?? "";
    // 按 h3 标题分割
    const blocks = section.split(/(?=### )/);

    for (const block of blocks) {
      if (!block.trim().startsWith("###")) continue;

      const description = block.match(/^### (.+)/)?.[1]?.trim() || "";
      const category = block.match(/\*\*类别\*\*:\s*(.+)/)?.[1]?.trim() || "general";
      const priority = parseInt(block.match(/\*\*优先级\*\*:\s*(\d+)/)?.[1] || "5", 10);
      const status = block.match(/\*\*状态\*\*:\s*(\w+)/)?.[1]?.trim() as "active" | "deprecated" | "testing" || "active";
      const appliedCount = parseInt(block.match(/\*\*应用次数\*\*:\s*(\d+)/)?.[1] || "0", 10);
      const promptAdjustment = block.match(/\*\*Prompt 调整\*\*:\s*(.+)/)?.[1]?.trim();
      const createdAtStr = block.match(/\*\*创建时间\*\*:\s*(.+)/)?.[1]?.trim();
      const createdAt = createdAtStr ? new Date(createdAtStr).getTime() : Date.now();

      strategies.push({
        id: `strat_parsed_${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        category,
        description,
        promptAdjustment,
        priority,
        status,
        appliedCount,
        feedbackIds: [],
      });
    }

    return strategies;
  }
}
