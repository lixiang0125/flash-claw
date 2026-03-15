/**
 * @module evolution/types
 * @description 自进化系统的类型定义模块。
 *
 * 定义了反馈信号、反馈分析结果、进化策略和进化报告等核心数据结构，
 * 供反馈分析器、策略规划器和进化引擎共享使用。
 */

/** 反馈信号类型 —— 表示对话质量的隐式和显式信号 */
export type FeedbackSignal =
  | "positive"
  | "negative"
  | "neutral"
  | "confused"
  | "frustrated"
  | "repeated_request";

/**
 * 反馈分析结果。
 * 由 FeedbackAnalyzer 对一次对话交互进行分析后生成。
 *
 * @interface FeedbackAnalysis
 * @property {FeedbackSignal} signal - 识别到的反馈信号类型
 * @property {number} confidence - 分析置信度（0-1）
 * @property {string} category - 反馈所属类别，如 "tool_usage"、"response_quality"、"memory_recall"、"task_understanding"
 * @property {string} [suggestion] - LLM 给出的改进建议
 * @property {object} context - 触发该反馈分析的上下文信息
 */
export interface FeedbackAnalysis {
  /** 唯一标识 */
  id: string;
  /** 识别到的反馈信号 */
  signal: FeedbackSignal;
  /** 分析置信度（0-1） */
  confidence: number;
  /** 反馈类别，如 "tool_usage"、"response_quality"、"memory_recall"、"task_understanding" */
  category: string;
  /** LLM 给出的改进建议 */
  suggestion?: string;
  /** 触发分析的上下文信息 */
  context: {
    userMessage: string;
    assistantResponse: string;
    sessionId: string;
    timestamp: number;
  };
}

/**
 * 进化策略。
 * 由 StrategyPlanner 根据累积反馈生成，用于指导系统行为优化。
 *
 * @interface EvolutionStrategy
 * @property {string} id - 策略唯一标识
 * @property {number} createdAt - 创建时间戳
 * @property {string} category - 策略类别
 * @property {string} description - 策略描述
 * @property {string} [promptAdjustment] - system prompt 补充指令
 * @property {number} priority - 优先级（1-10），数值越大优先级越高
 * @property {"active" | "deprecated" | "testing"} status - 策略状态
 * @property {number} [effectiveness] - 效果评分（0-1）
 * @property {number} appliedCount - 被应用次数
 * @property {string[]} feedbackIds - 触发此策略的反馈 ID 列表
 */
export interface EvolutionStrategy {
  /** 策略唯一标识 */
  id: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 策略类别 */
  category: string;
  /** 策略描述 */
  description: string;
  /** system prompt 补充指令 */
  promptAdjustment?: string;
  /** 优先级（1-10），数值越大优先级越高 */
  priority: number;
  /** 策略状态 */
  status: "active" | "deprecated" | "testing";
  /** 效果评分（0-1） */
  effectiveness?: number;
  /** 被应用次数 */
  appliedCount: number;
  /** 触发此策略的反馈 ID 列表 */
  feedbackIds: string[];
}

/**
 * 进化报告。
 * 汇总当前进化系统的运行状态和关键指标。
 *
 * @interface EvolutionReport
 * @property {number} generatedAt - 报告生成时间戳
 * @property {number} totalFeedbacks - 累计反馈总数
 * @property {number} activeStrategies - 当前活跃策略数量
 * @property {string[]} recentChanges - 最近的变更记录列表
 */
export interface EvolutionReport {
  /** 报告生成时间戳 */
  generatedAt: number;
  /** 累计反馈总数 */
  totalFeedbacks: number;
  /** 当前活跃策略数量 */
  activeStrategies: number;
  /** 最近的变更记录列表 */
  recentChanges: string[];
}
