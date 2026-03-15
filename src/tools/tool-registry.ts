/**
 * @module tool-registry
 * @description 工具注册表模块，提供工具定义的集中注册、查询和管理功能。
 *
 * 该模块实现了 {@link IToolRegistry} 接口，支持按名称、分类和权限等级
 * 对工具进行注册、注销和检索。所有工具名称必须唯一，注册时会进行严格的
 * 定义验证，确保工具名称格式、描述长度和超时时间均符合规范。
 */

import type {
  FlashClawToolDefinition,
  IToolRegistry,
  ToolCategory,
  ToolPermissionLevel,
} from "./types.js";

/**
 * 权限等级层级映射表。
 *
 * 将工具权限等级字符串映射为数值，用于权限比较和过滤。
 * 数值越大表示权限越高：read(1) < write(2) < execute(3) < admin(4)。
 *
 * @type {Record<ToolPermissionLevel, number>}
 */
const PERMISSION_HIERARCHY: Record<ToolPermissionLevel, number> = {
  read: 1,
  write: 2,
  execute: 3,
  admin: 4,
};

/**
 * 工具注册表类，负责管理所有已注册工具的生命周期。
 *
 * 提供工具的注册、注销、查询和过滤等核心功能。每个工具通过唯一名称标识，
 * 注册时会验证工具定义的合法性（名称格式、描述长度、超时范围）。
 * 支持按分类（{@link ToolCategory}）和权限等级（{@link ToolPermissionLevel}）
 * 进行工具过滤。
 *
 * @implements {IToolRegistry}
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry(console);
 *
 * // 注册单个工具
 * registry.register(myToolDefinition);
 *
 * // 按分类查询工具
 * const fileTools = registry.getByCategory("filesystem");
 *
 * // 按权限等级过滤
 * const readOnlyTools = registry.getByPermissionLevel("read");
 *
 * // 获取工具总数
 * console.log(`已注册 ${registry.size} 个工具`);
 * ```
 */
export class ToolRegistry implements IToolRegistry {
  /**
   * 内部工具存储映射表，以工具名称为键。
   * @private
   */
  private tools = new Map<string, FlashClawToolDefinition<any, any>>();
  /**
   * 可选的日志记录器，用于记录注册和注销事件。
   * @private
   */
  private logger: { info: (msg: string) => void } | null;

  /**
   * 创建 ToolRegistry 实例。
   *
   * @param {Object|null} logger - 可选的日志记录器对象，需包含 info 方法。
   *   传入 null 时将静默运行，不输出任何日志。
   */
  constructor(logger: { info: (msg: string) => void } | null = null) {
    this.logger = logger;
  }

  /**
   * 注册一个新的工具定义到注册表中。
   *
   * 注册前会检查工具名称是否已存在，以及工具定义是否合法。
   * 如果需要替换已有工具，请先调用 {@link unregister} 方法。
   *
   * @param {FlashClawToolDefinition} toolDef - 要注册的工具定义对象
   * @throws {Error} 当同名工具已注册时抛出错误
   * @throws {Error} 当工具定义验证失败时抛出错误（名称格式、描述长度、超时范围不合规）
   */
  register(toolDef: FlashClawToolDefinition<any, any>): void {
    if (this.tools.has(toolDef.name)) {
      throw new Error(
        `Tool "${toolDef.name}" is already registered. ` +
        `Use unregister() first if you want to replace it.`
      );
    }
    this.validateToolDefinition(toolDef);
    this.tools.set(toolDef.name, toolDef);
    this.logger?.info(`Tool registered: ${toolDef.name} [${toolDef.category}/${toolDef.permissionLevel}]`);
  }

  /**
   * 批量注册多个工具定义。
   *
   * 按数组顺序依次调用 {@link register} 方法。如果某个工具注册失败，
   * 后续工具将不会被注册（不提供事务性保证）。
   *
   * @param {FlashClawToolDefinition[]} tools - 要注册的工具定义数组
   * @throws {Error} 当任一工具注册失败时抛出错误
   */
  registerAll(tools: FlashClawToolDefinition<any, any>[]): void {
    for (const t of tools) {
      this.register(t);
    }
  }

  /**
   * 从注册表中注销指定名称的工具。
   *
   * @param {string} name - 要注销的工具名称
   * @returns {boolean} 如果成功注销返回 true，如果工具不存在返回 false
   */
  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      this.logger?.info(`Tool unregistered: ${name}`);
    }
    return deleted;
  }

  /**
   * 根据名称获取已注册的工具定义。
   *
   * @param {string} name - 工具名称
   * @returns {FlashClawToolDefinition|undefined} 匹配的工具定义，未找到时返回 undefined
   */
  get(name: string): FlashClawToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册的工具定义列表。
   *
   * @returns {FlashClawToolDefinition[]} 所有已注册工具定义的数组副本
   */
  getAll(): FlashClawToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * 按工具分类过滤并返回匹配的工具定义列表。
   *
   * @param {ToolCategory} category - 工具分类，例如 "filesystem"、"network" 等
   * @returns {FlashClawToolDefinition[]} 属于指定分类的工具定义数组
   */
  getByCategory(category: ToolCategory): FlashClawToolDefinition<any, any>[] {
    return this.getAll().filter(t => t.category === category);
  }

  /**
   * 按最大权限等级过滤并返回不超过该等级的工具定义列表。
   *
   * 使用 {@link PERMISSION_HIERARCHY} 进行等级比较。例如传入 "write"
   * 时，将返回所有权限等级为 "read" 或 "write" 的工具。
   *
   * @param {ToolPermissionLevel} maxLevel - 最大允许的权限等级
   * @returns {FlashClawToolDefinition[]} 权限等级不超过指定值的工具定义数组
   */
  getByPermissionLevel(maxLevel: ToolPermissionLevel): FlashClawToolDefinition<any, any>[] {
    const maxRank = PERMISSION_HIERARCHY[maxLevel];
    return this.getAll().filter(
      t => PERMISSION_HIERARCHY[t.permissionLevel] <= maxRank
    );
  }

  /**
   * 将所有已注册的工具转换为 AI SDK 兼容的工具格式。
   *
   * 返回一个以工具名称为键、输入模式（inputSchema）为值的映射对象，
   * 可直接用于 AI 模型的工具调用配置。
   *
   * @returns {Record<string, any>} AI SDK 格式的工具映射对象
   */
  toAISDKTools(): Record<string, any> {
    const aiTools: Record<string, any> = {};

    for (const [name, def] of this.tools) {
      aiTools[name] = def.inputSchema;
    }

    return aiTools;
  }

  /**
   * 获取当前已注册工具的数量。
   *
   * @type {number}
   * @readonly
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 验证工具定义的合法性。
   *
   * 检查内容包括：
   * - 工具名称必须匹配 `/^[a-z_][a-z0-9_]*$/`（小写字母、下划线，不能以数字开头）
   * - 工具描述长度不得少于 10 个字符
   * - 超时时间必须在 1000ms 至 300000ms（5分钟）之间
   *
   * @param {FlashClawToolDefinition} def - 待验证的工具定义
   * @throws {Error} 当工具名称格式不合规时抛出错误
   * @throws {Error} 当描述长度不足时抛出错误
   * @throws {Error} 当超时时间超出允许范围时抛出错误
   * @private
   */
  private validateToolDefinition(def: FlashClawToolDefinition<any, any>): void {
    if (!def.name || !/^[a-z_][a-z0-9_]*$/.test(def.name)) {
      throw new Error(
        `Invalid tool name "${def.name}". ` +
        `Must match /^[a-z_][a-z0-9_]*$/ (lowercase, underscores, no leading digits)`
      );
    }
    if (!def.description || def.description.length < 10) {
      throw new Error(
        `Tool "${def.name}" description too short. ` +
        `A clear description is critical for LLM tool selection quality.`
      );
    }
    if (def.timeoutMs < 1000 || def.timeoutMs > 300_000) {
      throw new Error(
        `Tool "${def.name}" timeout ${def.timeoutMs}ms out of range [1000, 300000].`
      );
    }
  }
}
