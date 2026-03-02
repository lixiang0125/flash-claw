import { z, ZodType } from "zod";

export type ToolPermissionLevel = "read" | "write" | "execute" | "admin";

export type ToolCategory = "filesystem" | "shell" | "web" | "search" | "utility";

export interface ToolExecutionContext {
  sessionId: string;
  workingDirectory: string;
  sandbox: SandboxInstance | null;
  securityPolicy: any;
  eventBus: any;
  logger: any;
}

export interface SandboxInstance {
  containerId: string;
  workDir: string;
  createdAt: number;
  lastUsedAt: number;
  status: "creating" | "idle" | "busy" | "stopping" | "stopped";
  sessionId: string | null;
}

export interface FlashClawToolDefinition<
  TInput extends ZodType<any> = ZodType<any>,
  TOutput = unknown,
> {
  name: string;
  description: string;
  inputSchema: TInput;
  execute: (
    input: z.infer<TInput>,
    context: ToolExecutionContext,
  ) => Promise<TOutput>;
  permissionLevel: ToolPermissionLevel;
  category: ToolCategory;
  requiresSandbox: boolean;
  timeoutMs: number;
  needsApproval: boolean | ((input: z.infer<TInput>) => Promise<boolean>);
  inputExamples?: Array<{ input: z.infer<TInput> }>;
  toModelOutput?: (output: TOutput) => string | object;
  strict?: boolean;
}

export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  data: T | null;
  error: string | null;
  durationMs: number;
  output: string;
  metadata: {
    toolName: string;
    inputSummary: string;
    sandboxUsed: boolean;
    approvalRequired: boolean;
  };
}

export interface IToolRegistry {
  register(tool: FlashClawToolDefinition<any, any>): void;
  registerAll(tools: FlashClawToolDefinition<any, any>[]): void;
  unregister(name: string): boolean;
  get(name: string): FlashClawToolDefinition<any, any> | undefined;
  getAll(): FlashClawToolDefinition<any, any>[];
  getByCategory(category: ToolCategory): FlashClawToolDefinition<any, any>[];
  getByPermissionLevel(maxLevel: ToolPermissionLevel): FlashClawToolDefinition<any, any>[];
  toAISDKTools(): Record<string, any>;
  readonly size: number;
}
