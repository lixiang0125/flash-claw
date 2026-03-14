import { CronExpressionParser } from "cron-parser";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Public interfaces — kept compatible with the old SQLite-backed API
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  name: string;
  message: string;
  schedule: string;          // external-facing: cron expr, "once", or "every:<ms>"
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  status: "success" | "failed" | "running";
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal JSON-file types (OpenClaw-style jobs.json)
// ---------------------------------------------------------------------------

interface ScheduleCron  { kind: "cron";  expr: string }
interface ScheduleEvery { kind: "every"; everyMs: number }
interface ScheduleAt    { kind: "at";    at: string }
type Schedule = ScheduleCron | ScheduleEvery | ScheduleAt;

interface JobState {
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
}

interface RunRecord {
  id: string;
  status: "success" | "failed" | "running";
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

interface Job {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  schedule: Schedule;
  message: string;
  state: JobState;
  runs: RunRecord[];
}

interface JobsFile {
  version: number;
  jobs: Job[];
}

// ---------------------------------------------------------------------------
// DI callback types
// ---------------------------------------------------------------------------

type TaskExecutor = (taskMessage: string, taskId: string) => Promise<string>;
type TaskNotifier = (taskName: string, result: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_RUNS_PER_JOB = 50;

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// TaskScheduler — JSON-file backed, OpenClaw architecture
// ---------------------------------------------------------------------------

export class TaskScheduler {
  private filePath: string;
  private data: JobsFile;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private executor: TaskExecutor | null = null;
  private notifier: TaskNotifier | null = null;
  private executing = new Set<string>();
  private lastChatId: string | null = null;

  constructor(filePath?: string) {
    const custom = process.env.TASKS_JSON_PATH;
    this.filePath =
      filePath || custom || path.join(process.cwd(), "data", "cron", "jobs.json");

    this.data = this.readFile();
  }

  // ---- Dependency injection ------------------------------------------------

  setExecutor(fn: TaskExecutor): void {
    this.executor = fn;
  }

  setNotifier(fn: TaskNotifier): void {
    this.notifier = fn;
  }

  setLastChatId(chatId: string): void {
    this.lastChatId = chatId;
  }

  getLastChatId(): string | null {
    return this.lastChatId;
  }

  // ---- File I/O ------------------------------------------------------------

  private readFile(): JobsFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw) as JobsFile;
      }
    } catch (err) {
      console.error("[TaskScheduler] Failed to read jobs file, starting fresh:", err);
    }
    return { version: 1, jobs: [] };
  }

  private writeFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = JSON.stringify(this.data, null, 2);
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  // ---- Schedule helpers ----------------------------------------------------

  /**
   * Convert an internal Schedule object to the external `schedule` string
   * that the old API consumers expect.
   */
  private scheduleToString(s: Schedule): string {
    switch (s.kind) {
      case "cron":  return s.expr;
      case "every": return `every:${s.everyMs}`;
      case "at":    return "once";
    }
  }

  /**
   * Convert the external `schedule` string to an internal Schedule object.
   */
  private stringToSchedule(s: string): Schedule {
    if (s === "once") {
      // One-time tasks get their `at` filled in by the caller.
      // This path shouldn't normally be hit for new creation,
      // but handle it defensively.
      return { kind: "at", at: new Date().toISOString() };
    }
    if (s.startsWith("every:")) {
      return { kind: "every", everyMs: parseInt(s.slice(6), 10) };
    }
    return { kind: "cron", expr: s };
  }

  /**
   * Calculate next-run ISO string for a given schedule.
   */
  private calculateNextRun(schedule: Schedule): string | null {
    switch (schedule.kind) {
      case "cron": {
        try {
          const interval = CronExpressionParser.parse(schedule.expr);
          return interval.next().toDate().toISOString();
        } catch {
          return null;
        }
      }
      case "every": {
        return new Date(Date.now() + schedule.everyMs).toISOString();
      }
      case "at": {
        // For one-time tasks, nextRun is the `at` timestamp itself
        // (if it hasn't passed yet).
        const ts = new Date(schedule.at).getTime();
        return ts > Date.now() ? schedule.at : null;
      }
    }
  }

  // ---- Job <-> Task mapping ------------------------------------------------

  private jobToTask(job: Job): Task {
    const nextRun = this.calculateNextRun(job.schedule) ?? undefined;
    return {
      id: job.id,
      name: job.name,
      message: job.message,
      schedule: this.scheduleToString(job.schedule),
      enabled: job.enabled,
      lastRun: job.state.lastRunAt ?? undefined,
      nextRun,
      createdAt: job.createdAt,
    };
  }

  private findJob(id: string): Job | undefined {
    return this.data.jobs.find((j) => j.id === id);
  }

  // ---- CRUD ----------------------------------------------------------------

  createTask(
    task: Omit<Task, "id" | "createdAt" | "lastRun" | "nextRun">,
  ): Task {
    const schedule = this.stringToSchedule(task.schedule);

    // Validate cron expression early
    if (schedule.kind === "cron") {
      try {
        CronExpressionParser.parse(schedule.expr);
      } catch {
        throw new Error(
          `Invalid cron expression: "${task.schedule}". Use standard 5-field cron syntax.`,
        );
      }
    }

    const now = new Date().toISOString();
    const id = generateId("task");

    const job: Job = {
      id,
      name: task.name,
      enabled: task.enabled,
      createdAt: now,
      updatedAt: now,
      schedule,
      message: task.message,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastDurationMs: null,
        consecutiveErrors: 0,
      },
      runs: [],
    };

    this.data.jobs.push(job);
    this.writeFile();

    const nextRun = this.calculateNextRun(schedule);
    if (task.enabled && nextRun && this.isRunning) {
      this.scheduleTimer(id, nextRun);
    }

    return this.jobToTask(job);
  }

  createOneTimeTask(task: {
    name: string;
    message: string;
    executeAfter: number;
  }): Task {
    const id = generateId("task");
    const executeAt = new Date(Date.now() + task.executeAfter).toISOString();
    const now = new Date().toISOString();

    const schedule: ScheduleAt = { kind: "at", at: executeAt };

    const job: Job = {
      id,
      name: task.name,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      schedule,
      message: task.message,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastDurationMs: null,
        consecutiveErrors: 0,
      },
      runs: [],
    };

    this.data.jobs.push(job);
    this.writeFile();

    if (this.isRunning) {
      this.scheduleTimer(id, executeAt);
    }

    return {
      id,
      name: task.name,
      message: task.message,
      schedule: "once",
      enabled: true,
      nextRun: executeAt,
      createdAt: now,
    };
  }

  listTasks(): Task[] {
    // Return newest first, matching old SQLite ORDER BY created_at DESC
    return [...this.data.jobs]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((j) => this.jobToTask(j));
  }

  getTask(id: string): Task | null {
    const job = this.findJob(id);
    return job ? this.jobToTask(job) : null;
  }

  updateTask(
    id: string,
    updates: Partial<Pick<Task, "name" | "message" | "schedule" | "enabled">>,
  ): Task | null {
    const job = this.findJob(id);
    if (!job) return null;

    // Validate new cron if schedule changed
    if (updates.schedule !== undefined) {
      const newSchedule = this.stringToSchedule(updates.schedule);
      if (newSchedule.kind === "cron") {
        try {
          CronExpressionParser.parse(newSchedule.expr);
        } catch {
          throw new Error(`Invalid cron expression: "${updates.schedule}".`);
        }
      }
      job.schedule = newSchedule;
    }

    if (updates.name !== undefined) job.name = updates.name;
    if (updates.message !== undefined) job.message = updates.message;
    if (updates.enabled !== undefined) job.enabled = updates.enabled;
    job.updatedAt = new Date().toISOString();

    this.writeFile();

    this.cancelTimer(id);
    const nextRun = this.calculateNextRun(job.schedule);
    if (job.enabled && nextRun && this.isRunning) {
      this.scheduleTimer(id, nextRun);
    }

    return this.jobToTask(job);
  }

  deleteTask(id: string): boolean {
    this.cancelTimer(id);
    const idx = this.data.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.data.jobs.splice(idx, 1);
    this.writeFile();
    return true;
  }

  // ---- Execution -----------------------------------------------------------

  async runTask(id: string): Promise<TaskRun> {
    const job = this.findJob(id);
    if (!job) throw new Error("Task not found");

    if (this.executing.has(id)) {
      throw new Error("Task is already running");
    }
    this.executing.add(id);

    const runId = generateId("run");
    const startedAt = new Date().toISOString();

    // Insert a running record
    const runRecord: RunRecord = {
      id: runId,
      status: "running",
      startedAt,
    };
    job.runs.unshift(runRecord);
    this.pruneRuns(job);
    this.writeFile();

    try {
      if (!this.executor) {
        throw new Error("Task executor not configured. Call setExecutor() first.");
      }

      const response = await this.executor(job.message, id);
      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

      // Update run record
      runRecord.status = "success";
      runRecord.output = response;
      runRecord.finishedAt = finishedAt;

      // Update job state
      job.state.lastRunAt = finishedAt;
      job.state.lastStatus = "success";
      job.state.lastDurationMs = durationMs;
      job.state.consecutiveErrors = 0;
      job.updatedAt = finishedAt;

      if (job.schedule.kind === "at") {
        // One-time task: disable but keep for history
        job.enabled = false;
      } else {
        // Re-schedule for next cycle
        const nextRun = this.calculateNextRun(job.schedule);
        if (job.enabled && nextRun) {
          this.cancelTimer(id);
          this.scheduleTimer(id, nextRun);
        }
      }

      this.writeFile();

      // Notify (non-blocking)
      if (this.notifier) {
        this.notifier(job.name, response).catch((e) =>
          console.error("[TaskScheduler] Notification failed:", e),
        );
      }

      return {
        id: runId,
        taskId: id,
        status: "success",
        output: response,
        startedAt,
        finishedAt,
      };
    } catch (error: any) {
      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

      runRecord.status = "failed";
      runRecord.error = error.message;
      runRecord.finishedAt = finishedAt;

      job.state.lastRunAt = finishedAt;
      job.state.lastStatus = "failed";
      job.state.lastDurationMs = durationMs;
      job.state.consecutiveErrors += 1;
      job.updatedAt = finishedAt;

      this.writeFile();

      return {
        id: runId,
        taskId: id,
        status: "failed",
        error: error.message,
        startedAt,
        finishedAt,
      };
    } finally {
      this.executing.delete(id);
    }
  }

  getTaskRuns(taskId: string, limit = 10): TaskRun[] {
    const job = this.findJob(taskId);
    if (!job) return [];

    return job.runs
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        taskId,
        status: r.status,
        output: r.output,
        error: r.error,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      }));
  }

  // ---- Run-history pruning -------------------------------------------------

  private pruneRuns(job: Job): void {
    if (job.runs.length > MAX_RUNS_PER_JOB) {
      job.runs.length = MAX_RUNS_PER_JOB;
    }
  }

  // ---- Scheduling internals ------------------------------------------------

  private scheduleTimer(id: string, nextRun: string): void {
    this.cancelTimer(id);

    const delay = new Date(nextRun).getTime() - Date.now();

    if (delay <= 0) {
      this.executeTask(id);
      return;
    }

    // Cap setTimeout to 24 hours (avoid Node.js 2^31 ms overflow).
    const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
    const safeDelay = Math.min(delay, MAX_TIMEOUT);

    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (safeDelay < delay) {
        // We capped the delay — re-evaluate instead of executing
        const job = this.findJob(id);
        if (job?.enabled) {
          const nr = this.calculateNextRun(job.schedule);
          if (nr) this.scheduleTimer(id, nr);
        }
      } else {
        this.executeTask(id);
      }
    }, safeDelay);

    this.timers.set(id, timer);
  }

  private cancelTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private async executeTask(id: string): Promise<void> {
    try {
      await this.runTask(id);
    } catch (error) {
      console.error(`[TaskScheduler] Task ${id} execution failed:`, error);
    }
  }

  // ---- Lifecycle -----------------------------------------------------------

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Reload from disk in case of external edits
    this.data = this.readFile();

    const tasks = this.data.jobs.filter((j) => j.enabled);

    for (const job of tasks) {
      const nextRun = this.calculateNextRun(job.schedule);
      if (nextRun) {
        this.scheduleTimer(job.id, nextRun);
      } else if (job.schedule.kind !== "at") {
        // Shouldn't happen, but be defensive
        const nr = this.calculateNextRun(job.schedule);
        if (nr) {
          this.scheduleTimer(job.id, nr);
        }
      }
    }

    // Recover missed one-time tasks that never executed before downtime
    for (const job of this.data.jobs) {
      if (job.enabled && job.schedule.kind === "at") {
        const atTime = new Date(job.schedule.at).getTime();
        if (atTime <= Date.now() && job.state.lastStatus !== "success") {
          // Missed one-time task — execute now
          console.log(`[TaskScheduler] Recovering missed one-time task: ${job.name}`);
          this.runTask(job.id).catch(err =>
            console.error(`[TaskScheduler] Failed to recover task ${job.id}:`, err)
          );
        }
      }
    }

    // Safety-net poll: every 60s check for missed tasks
    this.pollTimer = setInterval(() => {
      this.pollMissedTasks();
    }, 60_000);

    console.log(`[TaskScheduler] Started with ${tasks.length} active tasks`);
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    console.log("[TaskScheduler] Stopped");
  }

  /**
   * Safety-net: find enabled tasks whose nextRun has passed
   * but that don't have an active timer (e.g., after long sleep).
   */
  private pollMissedTasks(): void {
    const now = Date.now();
    const enabledJobs = this.data.jobs.filter(
      (j) => j.enabled && j.schedule.kind !== "at",
    );

    for (const job of enabledJobs) {
      const nextRun = this.calculateNextRun(job.schedule);
      if (!nextRun) continue;
      const nextRunMs = new Date(nextRun).getTime();
      if (
        nextRunMs <= now &&
        !this.timers.has(job.id) &&
        !this.executing.has(job.id)
      ) {
        console.log(`[TaskScheduler] Missed task detected: ${job.id}, executing now`);
        this.executeTask(job.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export (matches old API surface)
// ---------------------------------------------------------------------------

export const taskScheduler = new TaskScheduler();
