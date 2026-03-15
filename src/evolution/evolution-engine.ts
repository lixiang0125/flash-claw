/**
 * @module evolution/evolution-engine
 * @description 自进化引擎核心实现。
 *
 * 整合反馈分析器和策略规划器，提供完整的自进化生命周期管理。
 * 支持异步反馈分析（不阻塞主对话流程）、策略缓存、自动触发进化规划。
 * 实现 IEvolutionEngine 接口，通过 DI 容器注入到 ChatEngine。
 */

import type { Logger, AppConfig } from "../core/container/tokens";
import type { IEvolutionEngine } from "../core/container/tokens";
import type { FeedbackAnalysis, EvolutionStrategy, EvolutionReport } from "./types";
import { FeedbackAnalyzer } from "./feedback-analyzer";
import { StrategyPlanner } from "./strategy-planner";

/** 触发自动进化规划的反馈积累阈值 */
const AUTO_PLAN_THRESHOLD = 10;

/** 两次自动规划之间的最小间隔（毫秒），防止频繁触发 */
const PLAN_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 自进化引擎。
 * 核心协调器，管理反馈收集、策略生成和 prompt 增强的完整流程。
 *
 * @class EvolutionEngine
 * @implements {IEvolutionEngine}
 */
export class EvolutionEngine implements IEvolutionEngine {
  private logger: Logger;
  private analyzer: FeedbackAnalyzer;
  private planner: StrategyPlanner;

  /** 累积的反馈分析结果（未消费） */
  private pendingFeedbacks: FeedbackAnalysis[] = [];
  /** 所有历史反馈的信号统计 */
  private feedbackStats: Record<string, number> = {};
  /** 累计反馈总数 */
  private totalFeedbackCount = 0;

  /** 当前活跃的进化策略缓存 */
  private strategies: EvolutionStrategy[] = [];
  /** 策略是否已从文件加载 */
  private strategiesLoaded = false;

  /** 进化历史记录 */
  private historyEntries: Array<{ time: string; event: string; description: string }> = [];

  /** 上次自动规划的时间戳 */
  private lastPlanTime = 0;

  constructor(logger: Logger, config: AppConfig) {
    this.logger = logger.child({ module: "EvolutionEngine" });
    this.analyzer = new FeedbackAnalyzer(logger);
    this.planner = new StrategyPlanner(logger, config);

    // 启动时异步加载已有策略
    this.loadStrategies().catch((err) => {
      this.logger.error("[EvolutionEngine] 加载已有策略失败", { err });
    });

    this.logger.info("[EvolutionEngine] 自进化引擎已初始化");
  }

  /**
   * 分析一次对话的反馈（异步，不阻塞主流程）。
   * 使用 setTimeout 延迟 100ms 执行，确保不影响响应延迟。
   * 当累积反馈达到阈值时自动触发进化规划。
   *
   * @param userMessage - 用户消息
   * @param assistantResponse - 助手回复
   * @param sessionId - 会话 ID
   */
  async analyzeFeedback(
    userMessage: string,
    assistantResponse: string,
    sessionId: string,
  ): Promise<void> {
    // 延迟执行，不阻塞调用方
    await new Promise<void>((resolve) => {
      setTimeout(async () => {
        try {
          const analysis = await this.analyzer.analyze(
            userMessage,
            assistantResponse,
            sessionId,
          );

          this.pendingFeedbacks.push(analysis);
          this.totalFeedbackCount++;
          this.feedbackStats[analysis.signal] =
            (this.feedbackStats[analysis.signal] || 0) + 1;

          this.logger.debug("[EvolutionEngine] 反馈分析完成", {
            signal: analysis.signal,
            confidence: analysis.confidence,
            category: analysis.category,
            sessionId: sessionId.slice(0, 8),
          });

          // 检查是否需要自动触发进化规划
          if (this.shouldAutoplan()) {
            this.logger.info("[EvolutionEngine] 达到自动规划阈值，触发进化规划");
            await this.planEvolution();
          }

          resolve();
        } catch (err) {
          this.logger.error("[EvolutionEngine] 反馈分析异常", { err });
          resolve(); // 不抛出错误，保证不影响主流程
        }
      }, 100);
    });
  }

  /**
   * 获取当前活跃的进化策略列表。
   * 按优先级降序排列。
   *
   * @returns 活跃策略列表
   */
  getActiveStrategies(): EvolutionStrategy[] {
    return this.strategies
      .filter((s) => s.status === "active")
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取 prompt 补充指令。
   * 合并所有活跃策略的 promptAdjustment，按优先级排序后拼接。
   * 用于注入到 ChatEngine 的 system prompt 中。
   *
   * @returns 合并后的补充指令字符串，如无活跃策略则返回空字符串
   */
  getPromptEnhancements(): string {
    const active = this.getActiveStrategies();
    if (active.length === 0) return "";

    const enhancements = active
      .filter((s) => s.promptAdjustment)
      .map((s) => {
        // 标记应用次数递增
        s.appliedCount++;
        return `- ${s.promptAdjustment}`;
      });

    if (enhancements.length === 0) return "";

    return enhancements.join("\n");
  }

  /**
   * 获取进化报告。
   * 汇总当前系统的反馈统计和策略状态。
   *
   * @returns 进化报告
   */
  async getReport(): Promise<EvolutionReport> {
    await this.ensureStrategiesLoaded();

    return {
      generatedAt: Date.now(),
      totalFeedbacks: this.totalFeedbackCount,
      activeStrategies: this.getActiveStrategies().length,
      recentChanges: this.historyEntries.slice(-10).map(
        (e) => `[${e.time}] ${e.event}: ${e.description}`,
      ),
    };
  }

  /**
   * 手动触发进化规划。
   * 消费所有待处理反馈，生成新策略并持久化到 EVOLUTION.md。
   */
  async planEvolution(): Promise<void> {
    await this.ensureStrategiesLoaded();

    if (this.pendingFeedbacks.length === 0) {
      this.logger.debug("[EvolutionEngine] 无待处理反馈，跳过进化规划");
      return;
    }

    this.logger.info("[EvolutionEngine] 开始进化规划", {
      pendingFeedbacks: this.pendingFeedbacks.length,
      existingStrategies: this.strategies.length,
    });

    const newStrategies = await this.planner.planStrategies(
      this.pendingFeedbacks,
      this.strategies,
    );

    if (newStrategies.length > 0) {
      // 添加新策略
      this.strategies.push(...newStrategies);

      // 记录历史
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      for (const s of newStrategies) {
        this.historyEntries.push({
          time: now,
          event: "新策略生成",
          description: `[${s.category}] ${s.description}（优先级 ${s.priority}）`,
        });
      }

      this.logger.info("[EvolutionEngine] 生成新策略", {
        count: newStrategies.length,
        categories: newStrategies.map((s) => s.category),
      });
    }

    // 淘汰低效策略（应用次数 > 20 但无效果评分或效果 < 0.3）
    this.deprecateLowEffectiveness();

    // 持久化到 EVOLUTION.md
    await this.planner.writeEvolutionFile(
      this.strategies,
      this.totalFeedbackCount,
      this.feedbackStats,
      this.historyEntries,
    );

    // 清空待处理反馈
    this.pendingFeedbacks = [];
    this.lastPlanTime = Date.now();
  }

  /**
   * 判断是否需要自动触发进化规划。
   * 条件：待处理反馈 >= 阈值 且 距上次规划超过冷却时间。
   */
  private shouldAutoplan(): boolean {
    if (this.pendingFeedbacks.length < AUTO_PLAN_THRESHOLD) return false;
    if (Date.now() - this.lastPlanTime < PLAN_COOLDOWN_MS) return false;
    return true;
  }

  /**
   * 淘汰低效策略。
   * 将应用次数超过 20 次但效果评分低于 0.3 的策略标记为 deprecated。
   */
  private deprecateLowEffectiveness(): void {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    for (const s of this.strategies) {
      if (
        s.status === "active" &&
        s.appliedCount > 20 &&
        s.effectiveness !== undefined &&
        s.effectiveness < 0.3
      ) {
        s.status = "deprecated";
        this.historyEntries.push({
          time: now,
          event: "策略淘汰",
          description: `[${s.category}] ${s.description}（效果 ${(s.effectiveness * 100).toFixed(0)}%，已淘汰）`,
        });
        this.logger.info("[EvolutionEngine] 低效策略已淘汰", {
          id: s.id,
          category: s.category,
          effectiveness: s.effectiveness,
        });
      }
    }
  }

  /**
   * 从 EVOLUTION.md 加载已有策略。
   */
  private async loadStrategies(): Promise<void> {
    const loaded = await this.planner.readStrategies();
    if (loaded.length > 0) {
      this.strategies = loaded;
      this.logger.info("[EvolutionEngine] 已从 EVOLUTION.md 加载策略", {
        count: loaded.length,
      });
    }
    this.strategiesLoaded = true;
  }

  /**
   * 确保策略已加载（等待初始加载完成）。
   */
  private async ensureStrategiesLoaded(): Promise<void> {
    if (!this.strategiesLoaded) {
      await this.loadStrategies();
    }
  }
}
