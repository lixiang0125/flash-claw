import { Database } from "bun:sqlite";
import { CronExpressionParser } from "cron-parser";
import path from "path";

export interface Task {
  id: string;
  name: string;
  message: string;
  schedule: string;
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

/**
 * Task execution callback.
 * The scheduler no longer hard-imports chatEngine/feishuBot.
 * Instead, bootstrap.ts wires these at startup via setExecutor/setNotifier.
 */
type TaskExecutor = (taskMessage: string, taskId: string) => Promise<string>;
type TaskNotifier = (taskName: string, result: string) => Promise<void>;

class TaskScheduler {
  private db: InstanceType<typeof Database>;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private executor: TaskExecutor | null = null;
  private notifier: TaskNotifier | null = null;
  private executing = new Set<string>(); // guard against concurrent runs
  private lastChatId: string | null = null;

  constructor(db?: InstanceType<typeof Database>) {
    const customDbPath = process.env.TASKS_DB_PATH;
    const dbPath =
      customDbPath || path.join(process.cwd(), "data", "flashclaw.db");

    if (db) {
      this.db = db;
    } else {
      const fs = require("fs");
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbPath);
    }
    this.initTables();
    // NOTE: startScheduler() is no longer called in constructor.
    // Call start() explicitly after wiring executor/notifier.
  }

  // ---- Dependency injection (called from bootstrap.ts) ----

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

  // ---- Schema ----

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        schedule TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
  }

  // ---- CRUD ----

  createTask(
    task: Omit<Task, "id" | "createdAt" | "lastRun" | "nextRun">,
  ): Task {
    // Validate cron expression early (except "once")
    if (task.schedule !== "once") {
      try {
        CronExpressionParser.parse(task.schedule);
      } catch {
        throw new Error(
          `Invalid cron expression: "${task.schedule}". Use standard 5-field cron syntax.`,
        );
      }
    }

    const nextRun = this.calculateNextRun(task.schedule) ?? undefined;
    const now = new Date().toISOString();
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.db
      .prepare(
        `INSERT INTO tasks (id, name, message, schedule, enabled, next_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, task.name, task.message, task.schedule, task.enabled ? 1 : 0, nextRun ?? null, now);

    if (task.enabled && nextRun && this.isRunning) {
      this.scheduleTimer(id, nextRun);
    }

    return { id, ...task, createdAt: now, nextRun };
  }

  createOneTimeTask(task: {
    name: string;
    message: string;
    executeAfter: number;
  }): Task {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const executeAt = new Date(Date.now() + task.executeAfter).toISOString();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (id, name, message, schedule, enabled, next_run, created_at)
         VALUES (?, ?, ?, 'once', 1, ?, ?)`,
      )
      .run(id, task.name, task.message, executeAt, now);

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
    const rows = this.db
      .prepare(
        `SELECT id, name, message, schedule, enabled,
                last_run as lastRun, next_run as nextRun, created_at as createdAt
         FROM tasks ORDER BY created_at DESC`,
      )
      .all() as any[];

    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  getTask(id: string): Task | null {
    const row = this.db
      .prepare(
        `SELECT id, name, message, schedule, enabled,
                last_run as lastRun, next_run as nextRun, created_at as createdAt
         FROM tasks WHERE id = ?`,
      )
      .get(id) as any;

    if (!row) return null;
    return { ...row, enabled: row.enabled === 1 };
  }

  updateTask(
    id: string,
    updates: Partial<Pick<Task, "name" | "message" | "schedule" | "enabled">>,
  ): Task | null {
    const task = this.getTask(id);
    if (!task) return null;

    const merged = { ...task, ...updates };

    // Validate new cron if schedule changed
    if (updates.schedule && updates.schedule !== "once") {
      try {
        CronExpressionParser.parse(updates.schedule);
      } catch {
        throw new Error(`Invalid cron expression: "${updates.schedule}".`);
      }
    }

    this.cancelTimer(id);
    const nextRun = this.calculateNextRun(merged.schedule);

    this.db
      .prepare(
        `UPDATE tasks SET name = ?, message = ?, schedule = ?, enabled = ?, next_run = ?
         WHERE id = ?`,
      )
      .run(merged.name, merged.message, merged.schedule, merged.enabled ? 1 : 0, nextRun, id);

    if (merged.enabled && nextRun && this.isRunning) {
      this.scheduleTimer(id, nextRun);
    }

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    this.cancelTimer(id);
    // CASCADE will clean task_runs
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---- Execution ----

  async runTask(id: string): Promise<TaskRun> {
    const task = this.getTask(id);
    if (!task) throw new Error("Task not found");

    // Guard: prevent concurrent execution of the same task
    if (this.executing.has(id)) {
      throw new Error("Task is already running");
    }
    this.executing.add(id);

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO task_runs (id, task_id, status, started_at) VALUES (?, ?, 'running', ?)",
      )
      .run(runId, id, now);

    try {
      if (!this.executor) {
        throw new Error("Task executor not configured. Call setExecutor() first.");
      }

      const response = await this.executor(task.message, id);
      const finishedAt = new Date().toISOString();

      if (task.schedule === "once") {
        // One-time task: mark disabled, don't delete (keep history)
        this.db.prepare("UPDATE tasks SET enabled = 0, last_run = ? WHERE id = ?").run(finishedAt, id);
      } else {
        const nextRun = this.calculateNextRun(task.schedule);
        this.db
          .prepare("UPDATE tasks SET last_run = ?, next_run = ? WHERE id = ?")
          .run(now, nextRun, id);

        // Re-schedule for next cycle
        if (task.enabled && nextRun) {
          this.cancelTimer(id);
          this.scheduleTimer(id, nextRun);
        }
      }

      this.db
        .prepare(
          "UPDATE task_runs SET status = 'success', output = ?, finished_at = ? WHERE id = ?",
        )
        .run(response, finishedAt, runId);

      // Notify (non-blocking)
      if (this.notifier) {
        this.notifier(task.name, response).catch((e) =>
          console.error("[TaskScheduler] Notification failed:", e),
        );
      }

      return {
        id: runId,
        taskId: id,
        status: "success",
        output: response,
        startedAt: now,
        finishedAt,
      };
    } catch (error: any) {
      const finishedAt = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE task_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
        )
        .run(error.message, finishedAt, runId);

      return {
        id: runId,
        taskId: id,
        status: "failed",
        error: error.message,
        startedAt: now,
        finishedAt,
      };
    } finally {
      this.executing.delete(id);
    }
  }

  getTaskRuns(taskId: string, limit = 10): TaskRun[] {
    return this.db
      .prepare(
        `SELECT id, task_id as taskId, status, output, error,
                started_at as startedAt, finished_at as finishedAt
         FROM task_runs WHERE task_id = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as TaskRun[];
  }

  // ---- Scheduling internals ----

  private calculateNextRun(schedule: string): string | null {
    if (schedule === "once") return null;
    try {
      const interval = CronExpressionParser.parse(schedule);
      return interval.next().toDate().toISOString();
    } catch {
      return null;
    }
  }

  private scheduleTimer(id: string, nextRun: string): void {
    // Clear any existing timer for this task
    this.cancelTimer(id);

    const delay = new Date(nextRun).getTime() - Date.now();

    if (delay <= 0) {
      // Already past due — execute immediately, then schedule next
      this.executeTask(id);
      return;
    }

    // Cap setTimeout to 24 hours (avoid Node.js 2^31 ms overflow).
    // The poll loop will catch long-horizon tasks.
    const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
    const safeDelay = Math.min(delay, MAX_TIMEOUT);

    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (safeDelay < delay) {
        // We capped the delay — re-evaluate instead of executing
        const task = this.getTask(id);
        if (task?.enabled && task.nextRun) {
          this.scheduleTimer(id, task.nextRun);
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

  // ---- Lifecycle ----

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Schedule all enabled tasks from DB
    const tasks = this.listTasks().filter((t) => t.enabled);
    for (const task of tasks) {
      if (task.nextRun) {
        this.scheduleTimer(task.id, task.nextRun);
      } else if (task.schedule !== "once") {
        // Task has no nextRun calculated — fix it
        const nextRun = this.calculateNextRun(task.schedule);
        if (nextRun) {
          this.db
            .prepare("UPDATE tasks SET next_run = ? WHERE id = ?")
            .run(nextRun, task.id);
          this.scheduleTimer(task.id, nextRun);
        }
      }
    }

    // Safety-net poll: every 60s, check for missed tasks
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
    const tasks = this.listTasks().filter((t) => t.enabled && t.schedule !== "once");

    for (const task of tasks) {
      if (!task.nextRun) continue;
      const nextRunMs = new Date(task.nextRun).getTime();
      if (nextRunMs <= now && !this.timers.has(task.id) && !this.executing.has(task.id)) {
        console.log(`[TaskScheduler] Missed task detected: ${task.id}, executing now`);
        this.executeTask(task.id);
      }
    }
  }
}

export const taskScheduler = new TaskScheduler();
