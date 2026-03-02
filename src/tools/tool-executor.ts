import type {
  FlashClawToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";
import type { ISandboxManager } from "./sandbox/sandbox-manager.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventBus {
  emit(event: string, payload: unknown): void;
}

export interface SecurityLayer {
  checkPath(path: string, mode: "read" | "write"): { allowed: boolean; reason?: string };
  checkCommand(command: string): { allowed: boolean; reason?: string };
}

export class ToolExecutor {
  constructor(
    private tools: Map<string, FlashClawToolDefinition<any, any>>,
    private sandboxManager: ISandboxManager,
    private securityLayer: SecurityLayer,
    private logger: Logger,
  ) {}

  async execute(
    toolName: string,
    rawInput: unknown,
    sessionId: string,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    const toolDef = this.tools.get(toolName);
    if (!toolDef) {
      return this.buildErrorResult(
        toolName,
        rawInput,
        startTime,
        `Unknown tool: "${toolName}". Available: ${Array.from(this.tools.keys()).join(", ")}`
      );
    }

    let validatedInput: unknown;
    try {
      const result = toolDef.inputSchema.safeParse(rawInput);
      if (!result.success) {
        return this.buildErrorResult(
          toolName,
          rawInput,
          startTime,
          `Invalid input: ${result.error.message}`
        );
      }
      validatedInput = result.data;
    } catch (err) {
      return this.buildErrorResult(
        toolName,
        rawInput,
        startTime,
        `Validation error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const authResult = this.authorize(toolDef, validatedInput);
    if (!authResult.allowed) {
      return this.buildErrorResult(
        toolName,
        validatedInput,
        startTime,
        `Authorization denied: ${authResult.reason}`
      );
    }

    let sandbox = null;
    try {
      if (toolDef.requiresSandbox) {
        sandbox = await this.sandboxManager.acquire(sessionId);
      }

      const context: ToolExecutionContext = {
        sessionId,
        workingDirectory: sandbox?.workDir ?? process.cwd(),
        sandbox,
        securityPolicy: this.securityLayer,
        eventBus: { emit: () => {} },
        logger: this.logger,
      };

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Tool timed out after ${toolDef.timeoutMs}ms`)),
          toolDef.timeoutMs
        );
      });

      const rawResult = await Promise.race([
        toolDef.execute(validatedInput as never, context),
        timeoutPromise,
      ]);

      const output = toolDef.toModelOutput
        ? toolDef.toModelOutput(rawResult as never)
        : typeof rawResult === "string"
          ? rawResult
          : JSON.stringify(rawResult, null, 2);

      return {
        success: true,
        data: rawResult,
        error: null,
        durationMs: Date.now() - startTime,
        output: typeof output === "string" ? output : JSON.stringify(output),
        metadata: {
          toolName,
          inputSummary: JSON.stringify(validatedInput).substring(0, 200),
          sandboxUsed: toolDef.requiresSandbox,
          approvalRequired: typeof toolDef.needsApproval === "boolean"
            ? toolDef.needsApproval
            : false,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.buildErrorResult(toolName, validatedInput, startTime, errorMsg);
    }
  }

  async executeBatch(
    calls: Array<{ toolName: string; input: unknown }>,
    sessionId: string,
  ): Promise<ToolExecutionResult[]> {
    return Promise.all(
      calls.map((call) => this.execute(call.toolName, call.input, sessionId))
    );
  }

  private authorize(
    toolDef: FlashClawToolDefinition<any, any>,
    input: unknown,
  ): { allowed: boolean; reason?: string } {
    if (toolDef.name === "bash" && typeof (input as { command?: string })?.command === "string") {
      const cmdCheck = this.securityLayer.checkCommand((input as { command: string }).command);
      if (!cmdCheck.allowed) return cmdCheck;
    }

    const fileTools = ["read_file", "write_file", "glob", "grep"];
    if (fileTools.includes(toolDef.name)) {
      const path = (input as { path?: string })?.path;
      if (path) {
        const mode = toolDef.permissionLevel === "read" ? "read" : "write";
        const pathCheck = this.securityLayer.checkPath(path, mode);
        if (!pathCheck.allowed) return pathCheck;
      }
    }

    return { allowed: true };
  }

  private buildErrorResult(
    toolName: string,
    input: unknown,
    startTime: number,
    error: string,
  ): ToolExecutionResult {
    return {
      success: false,
      data: null,
      error,
      durationMs: Date.now() - startTime,
      output: `Error: ${error}`,
      metadata: {
        toolName,
        inputSummary: JSON.stringify(input).substring(0, 200),
        sandboxUsed: false,
        approvalRequired: false,
      },
    };
  }
}
