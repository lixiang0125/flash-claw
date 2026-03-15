import {
  describe, it, expect, mock, beforeEach, afterEach,
} from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TaskScheduler } from "../src/tasks/index";

let tmpDir: string;
let counter = 0;

function freshPath(): string {
  counter++;
  return path.join(tmpDir, `tasks_${counter}_${Date.now()}.json`);
}

function makeTempScheduler(): TaskScheduler {
  return new TaskScheduler(freshPath());
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-scheduler-test-"));
  counter = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TaskScheduler", () => {
  describe("constructor", () => {
    it("文件不存在时创建空数据", () => {
      const ts = makeTempScheduler();
      expect(ts.listTasks()).toEqual([]);
    });

    it("从文件加载已有数据", () => {
      const fp = freshPath();
      const existing = {
        version: 1,
        jobs: [{
          id: "existing-1", name: "Pre-existing", enabled: true,
          createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
          schedule: { kind: "every", everyMs: 60000 }, message: "hello",
          state: { lastRunAt: null, lastStatus: null, lastDurationMs: null, consecutiveErrors: 0 },
          runs: [],
        }],
      };
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(existing));
      const ts = new TaskScheduler(fp);
      expect(ts.listTasks()).toHaveLength(1);
      expect(ts.listTasks()[0].id).toBe("existing-1");
    });
  });

  describe("DI", () => {
    it("setLastChatId / getLastChatId 往返", () => {
      const ts = makeTempScheduler();
      expect(ts.getLastChatId()).toBeNull();
      ts.setLastChatId("chat_123");
      expect(ts.getLastChatId()).toBe("chat_123");
    });
  });

  describe("createTask", () => {
    it("创建 cron 任务", () => {
      const ts = makeTempScheduler();
      const task = ts.createTask({ name: "Cron", message: "m", schedule: "*/5 * * * *", enabled: true });
      expect(task.id).toBeDefined();
      expect(task.schedule).toBe("*/5 * * * *");
    });

    it("创建 every 间隔任务", () => {
      const ts = makeTempScheduler();
      const task = ts.createTask({ name: "Interval", message: "m", schedule: "every:60000", enabled: true });
      expect(task.schedule).toBe("every:60000");
    });

    it("无效 cron 抛出错误", () => {
      const ts = makeTempScheduler();
      expect(() => ts.createTask({ name: "Bad", message: "m", schedule: "not-cron", enabled: true })).toThrow(/[Ii]nvalid cron/);
    });

    it("持久化到磁盘", () => {
      const fp = freshPath();
      const ts1 = new TaskScheduler(fp);
      const task = ts1.createTask({ name: "P", message: "m", schedule: "every:30000", enabled: true });
      const ts2 = new TaskScheduler(fp);
      expect(ts2.getTask(task.id)).not.toBeNull();
    });
  });

  describe("createOneTimeTask", () => {
    it("创建一次性任务", () => {
      const ts = makeTempScheduler();
      const task = ts.createOneTimeTask({ name: "Once", message: "m", executeAfter: 60000 });
      expect(task.schedule).toBe("once");
    });
  });

  describe("listTasks / getTask", () => {
    it("空列表", () => { expect(makeTempScheduler().listTasks()).toEqual([]); });

    it("按 createdAt DESC 排序", async () => {
      const ts = makeTempScheduler();
      ts.createTask({ name: "First", message: "m", schedule: "every:10000", enabled: true });
      await new Promise(r => setTimeout(r, 15));
      ts.createTask({ name: "Second", message: "m", schedule: "every:20000", enabled: true });
      expect(ts.listTasks()[0].name).toBe("Second");
    });

    it("按 id 查找", () => {
      const ts = makeTempScheduler();
      const task = ts.createTask({ name: "Find", message: "m", schedule: "every:10000", enabled: true });
      expect(ts.getTask(task.id)!.name).toBe("Find");
    });

    it("不存在 → null", () => { expect(makeTempScheduler().getTask("x")).toBeNull(); });
  });

  describe("updateTask", () => {
    it("更新 name", () => {
      const ts = makeTempScheduler();
      const t = ts.createTask({ name: "Old", message: "m", schedule: "every:10000", enabled: true });
      expect(ts.updateTask(t.id, { name: "New" })!.name).toBe("New");
    });

    it("无效 cron 更新抛出", () => {
      const ts = makeTempScheduler();
      const t = ts.createTask({ name: "T", message: "m", schedule: "every:10000", enabled: true });
      expect(() => ts.updateTask(t.id, { schedule: "bad" })).toThrow(/[Ii]nvalid cron/);
    });

    it("不存在 → null", () => { expect(makeTempScheduler().updateTask("x", { name: "Y" })).toBeNull(); });
  });

  describe("deleteTask", () => {
    it("删除 → true", () => {
      const ts = makeTempScheduler();
      const t = ts.createTask({ name: "D", message: "m", schedule: "every:10000", enabled: true });
      expect(ts.deleteTask(t.id)).toBe(true);
      expect(ts.getTask(t.id)).toBeNull();
    });
    it("不存在 → false", () => { expect(makeTempScheduler().deleteTask("x")).toBe(false); });
  });

  describe("runTask", () => {
    it("成功路径", async () => {
      const ts = makeTempScheduler();
      ts.setExecutor(mock(() => Promise.resolve("output")));
      const t = ts.createTask({ name: "R", message: "m", schedule: "every:60000", enabled: true });
      const run = await ts.runTask(t.id);
      expect(run.status).toBe("success");
      expect(run.output).toBe("output");
    });

    it("失败路径", async () => {
      const ts = makeTempScheduler();
      ts.setExecutor(mock(() => Promise.reject(new Error("boom"))));
      const t = ts.createTask({ name: "F", message: "m", schedule: "every:60000", enabled: true });
      const run = await ts.runTask(t.id);
      expect(run.status).toBe("failed");
      expect(run.error).toBe("boom");
    });

    it("already running", async () => {
      const ts = makeTempScheduler();
      let resolve: () => void;
      ts.setExecutor(mock(() => new Promise<string>(r => (resolve = () => r("ok")))));
      const t = ts.createTask({ name: "B", message: "m", schedule: "every:60000", enabled: true });
      const p = ts.runTask(t.id);
      try { await ts.runTask(t.id); expect(true).toBe(false); }
      catch (e: any) { expect(e.message).toContain("already running"); }
      resolve!(); await p;
    });

    it("无 executor 抛出", async () => {
      const ts = makeTempScheduler();
      const t = ts.createTask({ name: "N", message: "m", schedule: "every:60000", enabled: true });
      try { await ts.runTask(t.id); expect(true).toBe(false); }
      catch (e: any) { expect(e.message).toContain("executor"); }
    });

    it("不存在 → not found", async () => {
      const ts = makeTempScheduler();
      ts.setExecutor(mock(() => Promise.resolve("x")));
      try { await ts.runTask("x"); expect(true).toBe(false); }
      catch (e: any) { expect(e.message).toContain("not found"); }
    });

    it("多次执行积累 runs", async () => {
      const ts = makeTempScheduler();
      ts.setExecutor(mock(() => Promise.resolve("ok")));
      const t = ts.createTask({ name: "M", message: "m", schedule: "every:60000", enabled: true });
      await ts.runTask(t.id);
      await ts.runTask(t.id);
      expect(ts.getTaskRuns(t.id).length).toBe(2);
    });
  });

  describe("getTaskRuns", () => {
    it("返回运行历史", async () => {
      const ts = makeTempScheduler();
      ts.setExecutor(mock(() => Promise.resolve("ok")));
      const t = ts.createTask({ name: "R", message: "m", schedule: "every:60000", enabled: true });
      await ts.runTask(t.id);
      expect(ts.getTaskRuns(t.id).length).toBe(1);
    });

    it("limit 参数", async () => {
      const ts = makeTempScheduler();
      ts.setExecutor(mock(() => Promise.resolve("ok")));
      const t = ts.createTask({ name: "L", message: "m", schedule: "every:60000", enabled: true });
      for (let i = 0; i < 5; i++) await ts.runTask(t.id);
      expect(ts.getTaskRuns(t.id, 3).length).toBe(3);
    });

    it("不存在 → 空数组", () => { expect(makeTempScheduler().getTaskRuns("x")).toEqual([]); });
  });

  describe("start / stop", () => {
    it("start 幂等", () => { const ts = makeTempScheduler(); ts.start(); ts.start(); ts.stop(); });
    it("stop 清除定时器", () => {
      const ts = makeTempScheduler();
      ts.createTask({ name: "T", message: "m", schedule: "every:9999000", enabled: true });
      ts.start(); ts.stop();
    });
    it("未 start 直接 stop", () => { makeTempScheduler().stop(); });
  });
});
