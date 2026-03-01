import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";
import { chatEngine } from "../chat";
import { taskScheduler } from "../tasks";
import { feishuBot } from "../integrations/feishu";

export interface HeartbeatCheck {
  name: string;
  description: string;
  interval: number; // minutes
  timeWindow?: { start: number; end: number }; // hours, e.g., 9-21
  lastRun?: string;
  enabled: boolean;
}

export interface HeartbeatResult {
  check: string;
  action: string;
  message?: string;
  severity?: "info" | "warning" | "error";
}

interface HealthCheckResult {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

class HeartbeatSystem {
  private db: ReturnType<Database>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private heartbeatFile: string;

  constructor() {
    const dbPath = path.join(process.cwd(), "data", "heartbeat.db");
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.heartbeatFile = path.join(process.cwd(), "HEARTBEAT.md");
    this.initTables();
    this.start();
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS heartbeat_state (
        check_name TEXT PRIMARY KEY,
        last_run TEXT,
        enabled INTEGER DEFAULT 1
      )
    `);
  }

  /**
   * 获取或创建心跳文件
   */
  getHeartbeatFile(): string {
    if (!fs.existsSync(this.heartbeatFile)) {
      const template = `# Heartbeat Checklist

每 30 分钟检查一次

## 主动检查
- 检查是否有待办任务需要处理

## 自定义检查
在这里添加你需要的检查项...

## 格式示例
- 检查生产环境 API 是否正常: every 30 min
- 检查错误日志: every 30 min, 9-21
`;
      fs.writeFileSync(this.heartbeatFile, template, "utf-8");
    }
    return this.heartbeatFile;
  }

  /**
   * 读取并解析 HEARTBEAT.md
   */
  parseHeartbeatFile(): HeartbeatCheck[] {
    const content = this.getHeartbeatFile();
    const lines = content.split("\n");
    const checks: HeartbeatCheck[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

      const everyMatch = trimmed.match(/(.+):\s*every\s+(\d+)\s*min/i);
      if (everyMatch) {
        const name = everyMatch[1].trim();
        const interval = parseInt(everyMatch[2]);

        let timeWindow: { start: number; end: number } | undefined;
        const windowMatch = trimmed.match(/(\d+)-(\d+)/);
        if (windowMatch) {
          timeWindow = {
            start: parseInt(windowMatch[1]),
            end: parseInt(windowMatch[2]),
          };
        }

        checks.push({
          name,
          description: name,
          interval,
          timeWindow,
          enabled: true,
        });
      }
    }

    return checks;
  }

  /**
   * 检查是否在时间窗口内
   */
  private isInTimeWindow(timeWindow?: { start: number; end: number }): boolean {
    if (!timeWindow) return true;
    const now = new Date();
    const hour = now.getHours();
    return hour >= timeWindow.start && hour <= timeWindow.end;
  }

  /**
   * 获取下次检查时间
   */
  private getNextCheckInterval(check: HeartbeatCheck): number {
    return check.interval * 60 * 1000;
  }

  /**
   * 获取检查的最后运行时间
   */
  private getLastRun(checkName: string): Date | null {
    const row = this.db.prepare(
      "SELECT last_run FROM heartbeat_state WHERE check_name = ?"
    ).get(checkName) as { last_run: string } | undefined;
    return row ? new Date(row.last_run) : null;
  }

  /**
   * 更新最后运行时间
   */
  private updateLastRun(checkName: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO heartbeat_state (check_name, last_run)
      VALUES (?, ?)
    `).run(checkName, now);
  }

  /**
   * 检查是否需要运行
   */
  private shouldRun(check: HeartbeatCheck): boolean {
    if (!check.enabled) return false;
    if (!this.isInTimeWindow(check.timeWindow)) return false;

    const lastRun = this.getLastRun(check.name);
    if (!lastRun) return true;

    const interval = this.getNextCheckInterval(check);
    return Date.now() - lastRun.getTime() >= interval;
  }

  /**
   * 运行心跳检查
   */
  async runCheck(check: HeartbeatCheck): Promise<HeartbeatResult | null> {
    console.log(`[Heartbeat] Running check: ${check.name}`);

    try {
      const result = await chatEngine.chat({
        message: check.description,
        sessionId: "heartbeat",
      });

      this.updateLastRun(check.name);

      const response = result.response.toLowerCase();
      if (response.includes("heartbeat_ok") || response.includes("一切正常") || response.includes("没有")) {
        console.log(`[Heartbeat] ${check.name}: OK (no action needed)`);
        return null;
      }

      console.log(`[Heartbeat] ${check.name}: Action needed`);
      return {
        check: check.name,
        action: "notify",
        message: result.response,
      };
    } catch (error) {
      console.error(`[Heartbeat] ${check.name} failed:`, error);
      return null;
    }
  }

  /**
   * 执行所有需要的心跳检查
   */
  async tick(): Promise<HeartbeatResult[]> {
    const checks = this.parseHeartbeatFile();
    const results: HeartbeatResult[] = [];

    for (const check of checks) {
      if (this.shouldRun(check)) {
        const result = await this.runCheck(check);
        if (result) {
          results.push(result);
        }
      }
    }

    return results;
  }

  /**
   * 启动心跳系统
   */
  start(intervalMinutes: number = 5): void {
    if (this.intervalId) return;

    console.log("[Heartbeat] Starting heartbeat system...");
    this.intervalId = setInterval(async () => {
      try {
        const results = await this.tick();
        if (results.length > 0) {
          console.log(`[Heartbeat] ${results.length} checks need attention`);
        }
      } catch (error) {
        console.error("[Heartbeat] Error:", error);
      }
    }, intervalMinutes * 60 * 1000);

    console.log(`[Heartbeat] Running every ${intervalMinutes} minutes`);
  }

  /**
   * 内置健康检查
   */
  async runHealthChecks(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    // 检查 Feishu 连接状态
    try {
      const feishuStatus = feishuBot?.getStatus?.();
      if (!feishuStatus?.connected) {
        results.push({
          name: "Feishu连接",
          status: "error",
          message: "飞书 WebSocket 未连接",
        });
      } else {
        results.push({
          name: "Feishu连接",
          status: "ok",
          message: "飞书连接正常",
        });
      }
    } catch (error: any) {
      results.push({
        name: "Feishu连接",
        status: "error",
        message: `飞书检查失败: ${error.message}`,
      });
    }

    // 检查最近任务执行情况
    try {
      const tasks = taskScheduler.listTasks();
      const now = new Date();
      const missedTasks = tasks.filter((t) => {
        if (!t.enabled || !t.nextRun) return false;
        return new Date(t.nextRun) < now;
      });
      if (missedTasks.length > 0) {
        results.push({
          name: "任务执行",
          status: "warning",
          message: `${missedTasks.length} 个任务错 过执行时间`,
        });
      } else {
        results.push({
          name: "任务执行",
          status: "ok",
          message: "所有任务执行正常",
        });
      }
    } catch (error: any) {
      results.push({
        name: "任务执行",
        status: "warning",
        message: `任务检查失败: ${error.message}`,
      });
    }

    // 检查服务器运行时间
    const uptime = process.uptime();
    if (uptime < 60) {
      results.push({
        name: "服务器运行",
        status: "info",
        message: `服务器刚启动 (${Math.floor(uptime)}秒)`,
      });
    } else {
      results.push({
        name: "服务器运行",
        status: "ok",
        message: `服务器运行正常 (${Math.floor(uptime / 60)}分钟)`,
      });
    }

    return results;
  }

  /**
   * 发送通知到 Feishu
   */
  async notify(results: HeartbeatResult[]): Promise<void> {
    if (results.length === 0) return;

    const lastChatId = taskScheduler.getLastChatId();
    if (!lastChatId) {
      console.log("[Heartbeat] No chat ID available for notification");
      return;
    }

    const errorResults = results.filter((r) => r.severity === "error" || r.severity === "warning");
    if (errorResults.length === 0) return;

    const message = this.formatNotification(errorResults);

    try {
      await feishuBot?.sendMessage?.(lastChatId, undefined, message);
      console.log("[Heartbeat] Notification sent to Feishu");
    } catch (error: any) {
      console.error("[Heartbeat] Failed to send notification:", error.message);
    }
  }

  /**
   * 格式化通知消息
   */
  private formatNotification(results: HeartbeatResult[]): string {
    const lines = ["⚠️ 心跳检查发现问题:\n"];
    for (const result of results) {
      const emoji = result.severity === "error" ? "❌" : "⚠️";
      lines.push(`${emoji} ${result.check}: ${result.message}`);
    }
    lines.push("\n请检查系统状态！");
    return lines.join("\n");
  }

  /**
   * 执行所有需要的心跳检查
   */
  async tick(): Promise<HeartbeatResult[]> {
    const results: HeartbeatResult[] = [];

    // 先运行内置健康检查
    const healthResults = await this.runHealthChecks();
    for (const hr of healthResults) {
      if (hr.status !== "ok") {
        results.push({
          check: hr.name,
          action: "notify",
          message: hr.message,
          severity: hr.status === "error" ? "error" : "warning",
        });
      }
    }

    // 再运行 HEARTBEAT.md 中的自定义检查
    const checks = this.parseHeartbeatFile();
    for (const check of checks) {
      if (this.shouldRun(check)) {
        const result = await this.runCheck(check);
        if (result) {
          results.push(result);
        }
      }
    }

    // 如果有问题，发送到 Feishu 通知
    if (results.length > 0) {
      await this.notify(results);
    }

    return results;
  }

  /**
   * 停止心跳系统
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 手动触发一次心跳
   */
  async trigger(): Promise<HeartbeatResult[]> {
    return this.tick();
  }

  /**
   * 获取心跳状态
   */
  getStatus(): { running: boolean; checks: HeartbeatCheck[] } {
    return {
      running: !!this.intervalId,
      checks: this.parseHeartbeatFile(),
    };
  }
}

export const heartbeatSystem = new HeartbeatSystem();
