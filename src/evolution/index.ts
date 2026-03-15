/**
 * @module evolution
 * @description 自进化系统模块的统一导出入口。
 *
 * 导出核心引擎、反馈分析器、策略规划器及所有类型定义，
 * 供 DI 容器注册和外部模块引用。
 */

export { EvolutionEngine } from "./evolution-engine";
export { FeedbackAnalyzer } from "./feedback-analyzer";
export { StrategyPlanner } from "./strategy-planner";

export type {
  FeedbackSignal,
  FeedbackAnalysis,
  EvolutionStrategy,
  EvolutionReport,
} from "./types";
