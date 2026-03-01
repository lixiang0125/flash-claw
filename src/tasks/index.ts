import { Database } from "bun:sqlite";
import { CronExpressionParser } from "cron-parser";
import path from "path";
import { chatEngine } from "../chat";
import { feishuBot } from "../integrations/feishu";

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

class TaskScheduler {
  private db: ReturnType<Database>;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastChatId: string | null = null;

  /**
   * 设置最后活跃的飞书聊天 ID
   */
  setLastChatId(chatId: string): void {
    this.lastChatId = chatId;
  }

  /**
   * 获取最后活跃的飞书聊天 ID
   */
  getLastChatId(): string | null {
    return this.lastChatId;
  }
  private isRunning: boolean = false;

  constructor() {
    const dbPath = path.join(process.cwd(), "data", "tasks.db");
    
    const fs = require("fs");
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initTables();
    this.startScheduler();
  }

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
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  }

  createTask(task: Omit<Task, "id" | "createdAt" | "lastRun" | "nextRun">): Task {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nextRun = this.calculateNextRun(task.schedule);
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO tasks (id, name, message, schedule, enabled, next_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, task.name, task.message, task.schedule, task.enabled ? 1 : 0, nextRun, now);
    
    if (task.enabled) {
      this.scheduleTask(id, nextRun);
    }
    
    return {
      id,
      ...task,
      createdAt: now,
      nextRun
    };
  }

  /**
   * 创建一次性任务
   */
  createOneTimeTask(task: { name: string; message: string; executeAfter: number }): Task {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const executeAt = new Date(Date.now() + task.executeAfter).toISOString();
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO tasks (id, name, message, schedule, enabled, next_run, created_at)
      VALUES (?, ?, ?, 'once', ?, ?, ?)
    `).run(id, task.name, task.message, 1, executeAt, now);
    
    // 立即调度
    setTimeout(() => {
      this.executeTask(id);
    }, task.executeAfter);
    
    return {
      id,
      name: task.name,
      message: task.message,
      schedule: "once",
      enabled: true,
      nextRun: executeAt,
      createdAt: now
    };
  }

  listTasks(): Task[] {
    const rows = this.db.prepare(`
      SELECT id, name, message, schedule, enabled, last_run as lastRun, next_run as nextRun, created_at as createdAt
      FROM tasks
      ORDER BY created_at DESC
    `).all() as any[];
    
    return rows.map(row => ({
      ...row,
      enabled: row.enabled === 1
    }));
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare(`
      SELECT id, name, message, schedule, enabled, last_run as lastRun, next_run as nextRun, created_at as createdAt
      FROM tasks
      WHERE id = ?
    `).get(id) as any;
    
    if (!row) return null;
    
    return {
      ...row,
      enabled: row.enabled === 1
    };
  }

  updateTask(id: string, updates: Partial<Pick<Task, "name" | "message" | "schedule" | "enabled">>): Task | null {
    const task = this.getTask(id);
    if (!task) return null;

    const newTask = { ...task, ...updates };
    this.cancelTask(id);
    
    const nextRun = this.calculateNextRun(newTask.schedule);
    
    this.db.prepare(`
      UPDATE tasks SET name = ?, message = ?, schedule = ?, enabled = ?, next_run = ?
      WHERE id = ?
    `).run(newTask.name, newTask.message, newTask.schedule, newTask.enabled ? 1 : 0, nextRun, id);
    
    if (newTask.enabled) {
      this.scheduleTask(id, nextRun);
    }
    
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    this.cancelTask(id);
    
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async runTask(id: string): Promise<TaskRun> {
    const task = this.getTask(id);
    if (!task) {
      throw new Error("Task not found");
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO task_runs (id, task_id, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(runId, id, now);

    try {
      const result = await chatEngine.chat({
        message: task.message,
        sessionId: `task_${id}`,
      });

      const finishedAt = new Date().toISOString();

      // 一次性任务执行后删除
      if (task.schedule === "once") {
        this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      } else {
        const nextRun = this.calculateNextRun(task.schedule);
        this.db.prepare(`
          UPDATE tasks SET last_run = ?, next_run = ? WHERE id = ?
        `).run(now, nextRun, id);
      }

      this.db.prepare(`
        UPDATE task_runs SET status = 'success', output = ?, finished_at = ?
        WHERE id = ?
      `).run(result.response, finishedAt, runId);

      // 发送任务结果到飞书（如果有飞书配置）
      if (feishuBot.isConfigured()) {
        try {
          const lastChatId = this.getLastChatId();
          if (lastChatId) {
            await feishuBot.sendMessage(lastChatId, undefined, `⏰ 任务提醒: ${result.response}`);
          }
        } catch (e) {
          console.error("[TaskScheduler] Failed to send to Feishu:", e);
        }
      }

      if (task.enabled) {
        this.cancelTask(id);
        this.scheduleTask(id, nextRun);
      }

      return {
        id: runId,
        taskId: id,
        status: "success",
        output: result.response,
        startedAt: now,
        finishedAt
      };
    } catch (error: any) {
      const finishedAt = new Date().toISOString();

      this.db.prepare(`
        UPDATE task_runs SET status = 'failed', error = ?, finished_at = ?
        WHERE id = ?
      `).run(error.message, finishedAt, runId);

      return {
        id: runId,
        taskId: id,
        status: "failed",
        error: error.message,
        startedAt: now,
        finishedAt
      };
    }
  }

  getTaskRuns(taskId: string, limit: number = 10): TaskRun[] {
    return this.db.prepare(`
      SELECT id, task_id as taskId, status, output, error, started_at as startedAt, finished_at as finishedAt
      FROM task_runs
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(taskId, limit) as TaskRun[];
  }

  private calculateNextRun(schedule: string): string | null {
    try {
      const interval = CronExpressionParser.parse(schedule);
      return interval.next().toDate().toISOString();
    } catch {
      return null;
    }
  }

  private scheduleTask(id: string, nextRun: string | null): void {
    if (!nextRun) return;

    const delay = new Date(nextRun).getTime() - Date.now();
    
    if (delay <= 0) {
      this.executeTask(id);
      const task = this.getTask(id);
      if (task?.enabled) {
        const newNextRun = this.calculateNextRun(task.schedule);
        if (newNextRun) {
          this.scheduleTask(id, newNextRun);
        }
      }
      return;
    }

    const timer = setTimeout(() => {
      this.executeTask(id);
    }, delay);

    this.timers.set(id, timer);
  }

  private cancelTask(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private async executeTask(id: string): Promise<void> {
    console.log(`[TaskScheduler] Executing task: ${id}`);
    
    try {
      await this.runTask(id);
    } catch (error) {
      console.error(`[TaskScheduler] Task execution failed:`, error);
    }
  }

  private startScheduler(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const tasks = this.listTasks().filter(t => t.enabled);
    
    for (const task of tasks) {
      if (task.nextRun) {
        this.scheduleTask(task.id, task.nextRun);
      }
    }

    setInterval(() => {
      const tasks = this.listTasks().filter(t => t.enabled);
      
      for (const task of tasks) {
        if (!task.nextRun || new Date(task.nextRun).getTime() <= Date.now()) {
          const nextRun = this.calculateNextRun(task.schedule);
          if (nextRun) {
            this.scheduleTask(task.id, nextRun);
          }
        }
      }
    }, 60000);

    console.log("[TaskScheduler] Started");
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.isRunning = false;
  }
}

export const taskScheduler = new TaskScheduler();
