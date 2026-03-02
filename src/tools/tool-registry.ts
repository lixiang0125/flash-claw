import type {
  FlashClawToolDefinition,
  IToolRegistry,
  ToolCategory,
  ToolPermissionLevel,
} from "./types.js";

const PERMISSION_HIERARCHY: Record<ToolPermissionLevel, number> = {
  read: 1,
  write: 2,
  execute: 3,
  admin: 4,
};

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, FlashClawToolDefinition<any, any>>();
  private logger: { info: (msg: string) => void } | null;

  constructor(logger: { info: (msg: string) => void } | null = null) {
    this.logger = logger;
  }

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

  registerAll(tools: FlashClawToolDefinition<any, any>[]): void {
    for (const t of tools) {
      this.register(t);
    }
  }

  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      this.logger?.info(`Tool unregistered: ${name}`);
    }
    return deleted;
  }

  get(name: string): FlashClawToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  getAll(): FlashClawToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  getByCategory(category: ToolCategory): FlashClawToolDefinition<any, any>[] {
    return this.getAll().filter(t => t.category === category);
  }

  getByPermissionLevel(maxLevel: ToolPermissionLevel): FlashClawToolDefinition<any, any>[] {
    const maxRank = PERMISSION_HIERARCHY[maxLevel];
    return this.getAll().filter(
      t => PERMISSION_HIERARCHY[t.permissionLevel] <= maxRank
    );
  }

  toAISDKTools(): Record<string, any> {
    const aiTools: Record<string, any> = {};

    for (const [name, def] of this.tools) {
      aiTools[name] = def.inputSchema;
    }

    return aiTools;
  }

  get size(): number {
    return this.tools.size;
  }

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
