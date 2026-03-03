import { chatEngine } from "../chat";

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export interface SubAgentConfig {
  task: string;
  label?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  cleanup?: "delete" | "keep";
}

export interface SubAgentRun {
  id: string;
  label?: string;
  sessionId: string;
  parentSessionId: string;
  task: string;
  status: "running" | "completed" | "failed" | "timeout";
  result?: string;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
  runtime?: string;
  tokens?: { input: number; output: number; total: number };
}

class SubAgentSystem {
  private runs: Map<string, SubAgentRun> = new Map();
  private abortControllers = new Map<string, AbortController>();
  private maxConcurrent = 8;
  private maxSpawnDepth = 1;
  private maxChildrenPerAgent = 5;

  async spawn(config: SubAgentConfig, parentSessionId: string): Promise<{ status: string; runId: string; childSessionKey: string }> {
    const runId = generateId();
    const childSessionId = `subagent:${runId}`;
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);

    const run: SubAgentRun = {
      id: runId,
      label: config.label,
      sessionId: childSessionId,
      parentSessionId,
      task: config.task,
      status: "running",
      startedAt: new Date(),
    };

    this.runs.set(runId, run);

    this.executeSubAgent(run, config, controller.signal).catch(console.error);

    return {
      status: "accepted",
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
    };
  }

  private async executeSubAgent(run: SubAgentRun, config: SubAgentConfig, signal: AbortSignal): Promise<void> {
    try {
      const timeoutMs = config.runTimeoutSeconds ? config.runTimeoutSeconds * 1000 : undefined;
      
      const result = await Promise.race([
        chatEngine.chat({
          message: run.task,
          sessionId: run.sessionId,
        }),
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new Error("Aborted"));
          });
          if (timeoutMs) {
            setTimeout(() => reject(new Error("Timeout")), timeoutMs);
          }
        }),
      ]);

      if (signal.aborted) {
        throw new Error("Aborted");
      }

      run.status = "completed";
      run.result = result.response;
      run.finishedAt = new Date();
      run.runtime = this.formatRuntime(run.startedAt, run.finishedAt);

      this.runs.set(run.id, run);

      this.announceToParent(run);
    } catch (error) {
      if (error instanceof Error && error.message === "Aborted") {
        run.status = "failed";
        run.error = "Killed by user";
      } else {
        run.status = "failed";
        run.error = error instanceof Error ? error.message : "Unknown error";
      }
      run.finishedAt = new Date();
      run.runtime = this.formatRuntime(run.startedAt, run.finishedAt);

      this.runs.set(run.id, run);

      this.announceToParent(run);
    } finally {
      this.abortControllers.delete(run.id);
    }
  }

  private announceToParent(run: SubAgentRun): void {
    const parentHistory = chatEngine.getHistoryMessages(run.parentSessionId);
    
    const statusText = run.status === "completed" ? "success" : run.status;
    const announceMessage = `## Sub-agent Result: ${run.label || run.id}

**Status:** ${statusText}
**Result:** ${run.result || "(not available)"}
**Notes:** ${run.error || "None"}
**Runtime:** ${run.runtime || "N/A"}
**Session:** ${run.sessionId}`;

    console.log(`[SubAgent] Announcing result to parent ${run.parentSessionId}:`, run.status);
  }

  private formatRuntime(start: Date, end: Date): string {
    const ms = end.getTime() - start.getTime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m${remainingSeconds}s`;
    }
    return `${seconds}s`;
  }

  getRun(runId: string): SubAgentRun | undefined {
    return this.runs.get(runId);
  }

  listRuns(parentSessionId?: string): SubAgentRun[] {
    const allRuns = Array.from(this.runs.values());
    if (parentSessionId) {
      return allRuns.filter(r => r.parentSessionId === parentSessionId);
    }
    return allRuns;
  }

  killRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
    }

    run.status = "failed";
    run.error = "Killed by user";
    run.finishedAt = new Date();
    
    this.runs.set(runId, run);
    return true;
  }

  killAll(parentSessionId: string): number {
    const runs = this.listRuns(parentSessionId);
    let count = 0;
    
    for (const run of runs) {
      if (this.killRun(run.id)) {
        count++;
      }
    }
    
    return count;
  }

  setMaxConcurrent(value: number): void {
    this.maxConcurrent = Math.min(Math.max(value, 1), 20);
  }

  setMaxSpawnDepth(value: number): void {
    this.maxSpawnDepth = Math.min(Math.max(value, 1), 5);
  }

  getConfig() {
    return {
      maxConcurrent: this.maxConcurrent,
      maxSpawnDepth: this.maxSpawnDepth,
      maxChildrenPerAgent: this.maxChildrenPerAgent,
    };
  }
}

export const subAgentSystem = new SubAgentSystem();
