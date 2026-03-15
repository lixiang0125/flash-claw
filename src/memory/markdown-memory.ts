/**
 * @module MarkdownMemory
 * @description Markdown 记忆模块 —— 四级记忆体系中的第三级。
 *
 * 通过文件系统提供持久化的结构化记忆存储，包括：
 * - **MEMORY.md**：按分区组织的长期事实记忆（人物、偏好等）
 * - **每日日志**：按日期组织的对话摘要和交互记录
 *
 * 与短期记忆（数据库存储、会话级别）不同，Markdown 记忆以人类可读的
 * Markdown 文件形式持久存储，支持用户直接查看和编辑。
 *
 * 四级记忆体系：
 * 1. **工作记忆**（WorkingMemory）—— 当前请求的上下文窗口
 * 2. **短期记忆**（ShortTermMemory）—— 会话级数据库持久化
 * 3. **Markdown 记忆**（MarkdownMemory）—— 文件系统持久化 ← 本模块
 * 4. **长期记忆**（向量嵌入）—— 语义检索
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { Logger } from "./embedding/embedding-service";

/**
 * Markdown 记忆配置选项。
 */
export interface MarkdownMemoryConfig {
  /** 工作区根路径。为空字符串时禁用所有文件操作。 */
  workspacePath: string;
  /** 是否启用每日日志功能。默认 `true`。 */
  enableDailyLogs: boolean;
  /** 是否启用 MEMORY.md 记忆文件功能。默认 `true`。 */
  enableMemoryFile: boolean;
}

/**
 * Markdown 记忆的默认配置。
 *
 * 默认工作区路径为空（需由调用方指定），每日日志和记忆文件均启用。
 */
const DEFAULT_CONFIG: MarkdownMemoryConfig = {
  workspacePath: "",
  enableDailyLogs: true,
  enableMemoryFile: true,
};

/**
 * 文件搜索结果。
 *
 * 表示在单个 Markdown 文件中匹配到的搜索结果及其行号范围。
 */
export interface MemoryFileResult {
  /** 匹配文件的完整路径。 */
  path: string;
  /** 匹配的行范围列表，每项包含起始行号、结束行号和匹配内容。 */
  lines: { start: number; end: number; content: string }[];
}

/**
 * Markdown 记忆管理器 —— 四级记忆体系中的第三级。
 *
 * 通过文件系统管理两类持久化记忆：
 * - **MEMORY.md**：分区结构化的事实记忆（人物、偏好、项目信息等）
 * - **每日日志**（`memory/YYYY-MM-DD.md`）：按日期归档的对话摘要
 *
 * 所有写操作通过内部写锁（{@link withLock}）串行化，防止并发写入导致数据损坏。
 *
 * @example
 * ```typescript
 * const mm = new MarkdownMemory(logger, { workspacePath: "/data/agent" });
 * await mm.initialize();
 *
 * // 追加每日日志
 * await mm.appendDailyLog("- 用户询问了天气信息");
 *
 * // 向 MEMORY.md 的指定分区追加内容
 * await mm.appendToMemory("- 喜欢喝美式咖啡", "Preferences");
 *
 * // 搜索记忆文件
 * const results = await mm.searchInFiles("咖啡");
 * ```
 */
export class MarkdownMemory {
  /** 当前生效的配置。 */
  private config: MarkdownMemoryConfig;
  /** 日志记录器。 */
  private logger: Logger;
  /** 写操作串行化锁，确保并发写入不会导致文件损坏。 */
  private writeLock = Promise.resolve();

  /**
   * 以串行化方式执行异步写操作。
   *
   * 通过链式 Promise 实现简易的互斥锁，保证同一时刻只有一个写操作
   * 在执行，避免并发写入同一文件导致内容损坏。
   *
   * @typeParam T - 回调函数的返回类型
   * @param fn - 需要在锁保护下执行的异步操作
   * @returns 回调函数的返回值
   * @private
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>(r => (release = r));
    const prev = this.writeLock;
    this.writeLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  /**
   * 创建 Markdown 记忆实例。
   *
   * @param logger - 日志记录器实例
   * @param config - 可选的配置项，将与默认配置合并
   */
  constructor(logger: Logger, config?: Partial<MarkdownMemoryConfig>) {
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化 Markdown 记忆的文件系统结构。
   *
   * 创建工作区目录和 `memory/` 子目录（如不存在），
   * 并初始化 `MEMORY.md` 文件（包含默认的 People 和 Preferences 分区）。
   * 若 `workspacePath` 为空则跳过所有操作。
   */
  async initialize(): Promise<void> {
    if (!this.config.workspacePath) return;

    await fs.mkdir(this.config.workspacePath, { recursive: true });
    await fs.mkdir(path.join(this.config.workspacePath, "memory"), { recursive: true });

    const memoryFile = path.join(this.config.workspacePath, "MEMORY.md");
    try {
      await fs.access(memoryFile);
    } catch {
      await fs.writeFile(memoryFile, "# Memory\n\n## People\n\n## Preferences\n\n");
    }
  }

  /**
   * 向当天的每日日志文件追加内容。
   *
   * 日志文件路径为 `{workspacePath}/memory/{YYYY-MM-DD}.md`。
   * 若文件不存在则自动创建。内容追加在文件末尾并添加换行符。
   *
   * @param content - 要追加的日志内容（Markdown 格式）
   * @returns 日志文件路径；若功能未启用则返回空字符串
   */
  async appendDailyLog(content: string): Promise<string> {
    if (!this.config.workspacePath || !this.config.enableDailyLogs) {
      return "";
    }

    return this.withLock(async () => {
      const today = new Date().toISOString().split("T")[0];
      const logPath = path.join(this.config.workspacePath, "memory", `${today}.md`);

      const existing = await fs.readFile(logPath, "utf-8").catch(() => "");

      await fs.writeFile(logPath, existing + content + "\n");
      this.logger.debug(`Appended to daily log: ${logPath}`);

      return logPath;
    });
  }

  /**
   * 向 MEMORY.md 追加内容。
   *
   * 支持两种模式：
   * - **无分区**：直接追加到文件末尾
   * - **指定分区**：在对应的 `## {section}` 标题下追加；若分区不存在则新建
   *
   * @param content - 要追加的内容（Markdown 格式）
   * @param section - 可选的目标分区名称（对应 `## ` 级别的标题）
   * @returns MEMORY.md 文件路径；若功能未启用则返回空字符串
   */
  async appendToMemory(content: string, section?: string): Promise<string> {
    if (!this.config.workspacePath || !this.config.enableMemoryFile) {
      return "";
    }

    return this.withLock(async () => {
      const memoryPath = path.join(this.config.workspacePath, "MEMORY.md");

      if (!section) {
        const existing = await fs.readFile(memoryPath, "utf-8").catch(() => "");
        await fs.writeFile(memoryPath, existing + content + "\n");
        return memoryPath;
      }

      const content_1 = await fs.readFile(memoryPath, "utf-8").catch(() => "");
      const lines = content_1.split("\n");
      let sectionStart = -1;
      let sectionEnd = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").trim();
        if (line === `## ${section}`) {
          sectionStart = i;
        } else if (sectionStart >= 0 && line.startsWith("## ")) {
          sectionEnd = i;
          break;
        }
      }

      if (sectionStart < 0) {
        await fs.writeFile(memoryPath, content_1 + `\n## ${section}\n${content}\n`);
      } else {
        const endIdx = sectionEnd > 0 ? sectionEnd : lines.length;
        lines.splice(endIdx, 0, content);
        await fs.writeFile(memoryPath, lines.join("\n"));
      }

      this.logger.debug(`Appended to memory section: ${section}`);
      return memoryPath;
    });
  }


  /**
   * 写入（或覆盖）指定日期的每日摘要。
   *
   * 与 appendDailyLog 不同，此方法会用 LLM 生成的摘要
   * 替换文件的全部内容，生成整洁可读的每日总结。
   *
   * @param date - 日期字符串，格式为 `YYYY-MM-DD`
   * @param summary - LLM 生成的每日摘要内容
   * @returns 日志文件路径；若功能未启用则返回空字符串
   */
  async writeDailySummary(date: string, summary: string): Promise<string> {
    if (!this.config.workspacePath || !this.config.enableDailyLogs) {
      return "";
    }

    return this.withLock(async () => {
      const logPath = path.join(this.config.workspacePath, "memory", `${date}.md`);
      const content = `# ${date} Daily Summary

${summary}
`;

      await fs.writeFile(logPath, content);
      this.logger.debug(`Daily summary written: ${logPath}`);

      return logPath;
    });
  }

  /**
   * 在所有记忆文件中搜索匹配内容。
   *
   * 扫描 `memory/` 目录下所有 `.md` 文件以及根目录的 `MEMORY.md`，
   * 执行大小写不敏感的子串匹配。每个文件最多返回 3 个匹配片段。
   *
   * @param query - 搜索关键词
   * @param limit - 最多返回的文件数量，默认 10
   * @returns 匹配结果数组，每项包含文件路径和匹配行信息
   */
  async searchInFiles(query: string, limit = 10): Promise<MemoryFileResult[]> {
    if (!this.config.workspacePath) return [];

    const results: MemoryFileResult[] = [];
    const memoryDir = path.join(this.config.workspacePath, "memory");

    try {
      const files = await fs.readdir(memoryDir);
      const mdFiles = files.filter((f) => f.endsWith(".md"));

      for (const file of mdFiles) {
        const filePath = path.join(memoryDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        const matches: { start: number; end: number; content: string }[] = [];
        let matchStart = -1;
        let currentContent: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = (lines[i] ?? "").toLowerCase();
          const queryLower = query.toLowerCase();

          if (line.includes(queryLower)) {
            if (matchStart < 0) matchStart = i;
            currentContent.push(lines[i] ?? "");
          } else if (matchStart >= 0) {
            matches.push({
              start: matchStart + 1,
              end: i,
              content: currentContent.join(" "),
            });
            matchStart = -1;
            currentContent = [];
          }
        }

        if (matchStart >= 0) {
          matches.push({
            start: matchStart + 1,
            end: lines.length,
            content: currentContent.join(" "),
          });
        }

        if (matches.length === 0) continue;

        results.push({
          path: filePath,
          lines: matches.slice(0, 3),
        });
      }

      const memoryFile = path.join(this.config.workspacePath, "MEMORY.md");
      try {
        const content = await fs.readFile(memoryFile, "utf-8");
        const lines = content.split("\n");
        const matches: { start: number; end: number; content: string }[] = [];
        let matchStart = -1;
        let currentContent: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = (lines[i] ?? "").toLowerCase();
          const queryLower = query.toLowerCase();

          if (line.includes(queryLower)) {
            if (matchStart < 0) matchStart = i;
            currentContent.push(lines[i] ?? "");
          } else if (matchStart >= 0) {
            matches.push({
              start: matchStart + 1,
              end: i,
              content: currentContent.join(" "),
            });
            matchStart = -1;
            currentContent = [];
          }
        }

        if (matchStart >= 0) {
          matches.push({
            start: matchStart + 1,
            end: lines.length,
            content: currentContent.join(" "),
          });
        }

        if (matches.length > 0) {
          results.push({
            path: memoryFile,
            lines: matches.slice(0, 3),
          });
        }
      } catch {
        // MEMORY.md may not exist
      }
    } catch {
      // memory directory may not exist
    }

    return results.slice(0, limit);
  }

  /**
   * 读取 MEMORY.md 的内容。
   *
   * 支持两种模式：
   * - **无分区参数**：返回整个文件内容
   * - **指定分区**：仅返回对应 `## {section}` 下的内容
   *
   * @param section - 可选的分区名称；省略则返回全部内容
   * @returns 文件/分区的 Markdown 文本内容；若文件不存在或分区未找到则返回空字符串
   */
  async getMemoryContent(section?: string): Promise<string> {
    if (!this.config.workspacePath) return "";

    const memoryPath = path.join(this.config.workspacePath, "MEMORY.md");
    const content = await fs.readFile(memoryPath, "utf-8").catch(() => "");

    if (!section) return content;

    const lines = content.split("\n");
    let sectionStart = -1;
    let sectionEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      if (line === `## ${section}`) {
        sectionStart = i;
      } else if (sectionStart >= 0 && line.startsWith("## ")) {
        sectionEnd = i;
        break;
      }
    }

    if (sectionStart < 0) return "";
    return lines.slice(sectionStart, sectionEnd > 0 ? sectionEnd : lines.length).join("\n");
  }

  /**
   * 获取最近若干天的每日日志内容。
   *
   * 从今天开始向前回溯，读取每天对应的日志文件。
   * 若某天的日志文件不存在则跳过。
   *
   * @param days - 回溯的天数，默认 2（今天和昨天）
   * @returns 日志内容数组，按从近到远的顺序排列
   */
  async getDailyLogs(days = 2): Promise<string[]> {
    if (!this.config.workspacePath) return [];

    const memoryDir = path.join(this.config.workspacePath, "memory");
    const logs: string[] = [];

    const now = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      const logPath = path.join(memoryDir, `${dateStr}.md`);

      try {
        const content = await fs.readFile(logPath, "utf-8");
        logs.push(content);
      } catch {
        // File doesn't exist
      }
    }

    return logs;
  }


  /**
   * 获取指定日期之后的每日日志（不包含该日期）。
   *
   * 用于增量整合 —— 仅读取上次整合之后创建的日志，
   * 避免重复处理已整合过的内容。从今天向前回溯，
   * 最多不超过 `maxDays` 天。
   *
   * @param sinceDate - ISO 日期字符串（`YYYY-MM-DD`），不包含该日期的日志。若为 `null`，则回退到 getDailyLogs(maxDays)
   * @param maxDays - 最多回溯的天数，默认 7
   * @returns 日志内容数组，按从近到远的顺序排列
   */
  async getDailyLogsSince(sinceDate: string | null, maxDays = 7): Promise<string[]> {
    if (!sinceDate) return this.getDailyLogs(maxDays);
    if (!this.config.workspacePath) return [];

    const memoryDir = path.join(this.config.workspacePath, "memory");
    const logs: string[] = [];
    const now = new Date();

    for (let i = 0; i < maxDays; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0]!;

      // Skip dates at or before the last consolidation
      if (dateStr <= sinceDate) break;

      const logPath = path.join(memoryDir, `${dateStr}.md`);
      try {
        const content = await fs.readFile(logPath, "utf-8");
        logs.push(content);
      } catch {
        // File does not exist for this date
      }
    }

    return logs;
  }

  /**
   * 读取 MEMORY.md 文件的完整内容。
   *
   * 与 getMemoryContent 不同，此方法始终返回完整文件内容，
   * 不支持按分区过滤。主要用于记忆整合（consolidation）流程。
   *
   * @returns MEMORY.md 的完整文本内容；若文件不存在则返回空字符串
   */
  async readMemoryFile(): Promise<string> {
    if (!this.config.workspacePath) return "";
    const memoryPath = path.join(this.config.workspacePath, "MEMORY.md");
    return fs.readFile(memoryPath, "utf-8").catch(() => "");
  }

  /**
   * 将整合后的记忆内容追加到 MEMORY.md。
   *
   * 在文件末尾添加带有日期标记的分隔符（`<!-- Consolidated: YYYY-MM-DD -->`），
   * 然后追加整合后的内容。合并新内容到已有分区或追加新分区。
   *
   * @param content - 整合后的记忆内容（Markdown 格式）
   * @returns MEMORY.md 文件路径；若功能未启用则返回空字符串
   */
  async appendConsolidatedMemory(content: string): Promise<string> {
    if (!this.config.workspacePath || !this.config.enableMemoryFile) return "";

    return this.withLock(async () => {
      const memoryPath = path.join(this.config.workspacePath, "MEMORY.md");
      const existing = await fs.readFile(memoryPath, "utf-8").catch(() => "# Memory\n");
      
      const timestamp = new Date().toISOString().split("T")[0];
      const separator = `\n\n<!-- Consolidated: ${timestamp} -->\n`;
      
      await fs.writeFile(memoryPath, existing.trimEnd() + separator + content + "\n");
      this.logger.debug(`Consolidated memory appended to ${memoryPath}`);
      return memoryPath;
    });
  }

  /**
   * 获取最后一次记忆整合的日期。
   *
   * 从 MEMORY.md 中解析 `<!-- Consolidated: YYYY-MM-DD -->` 标记，
   * 返回最近一次整合的日期字符串。用于增量整合时确定起始日期。
   *
   * @returns 最后整合日期字符串（`YYYY-MM-DD` 格式），若未找到标记则返回 `null`
   */
  async getLastConsolidationDate(): Promise<string | null> {
    if (!this.config.workspacePath) return null;
    const memoryPath = path.join(this.config.workspacePath, "MEMORY.md");
    const content = await fs.readFile(memoryPath, "utf-8").catch(() => "");
    
    // Find the last <!-- Consolidated: YYYY-MM-DD --> marker
    const matches = content.match(/<!-- Consolidated: (\d{4}-\d{2}-\d{2}) -->/g);
    if (!matches || matches.length === 0) return null;
    
    const lastMatch = matches[matches.length - 1]!;
    const dateMatch = lastMatch.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch ? dateMatch[1]! : null;
  }

  /**
   * 获取当前工作区路径。
   *
   * @returns 配置中的工作区根路径
   */
  get workspacePath(): string {
    return this.config.workspacePath;
  }
}
