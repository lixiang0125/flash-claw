import * as fs from "fs/promises";
import * as path from "path";
import type { Logger } from "./embedding/embedding-service";

export interface MarkdownMemoryConfig {
  workspacePath: string;
  enableDailyLogs: boolean;
  enableMemoryFile: boolean;
}

const DEFAULT_CONFIG: MarkdownMemoryConfig = {
  workspacePath: "",
  enableDailyLogs: true,
  enableMemoryFile: true,
};

export interface MemoryFileResult {
  path: string;
  lines: { start: number; end: number; content: string }[];
}

export class MarkdownMemory {
  private config: MarkdownMemoryConfig;
  private logger: Logger;

  constructor(logger: Logger, config?: Partial<MarkdownMemoryConfig>) {
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

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

  async appendDailyLog(content: string): Promise<string> {
    if (!this.config.workspacePath || !this.config.enableDailyLogs) {
      return "";
    }

    const today = new Date().toISOString().split("T")[0];
    const logPath = path.join(this.config.workspacePath, "memory", `${today}.md`);

    const header = `# ${today}\n\n`;
    const existing = await fs.readFile(logPath, "utf-8").catch(() => "");

    await fs.writeFile(logPath, existing + content + "\n");
    this.logger.debug(`Appended to daily log: ${logPath}`);

    return logPath;
  }

  async appendToMemory(content: string, section?: string): Promise<string> {
    if (!this.config.workspacePath || !this.config.enableMemoryFile) {
      return "";
    }

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
  }

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

        results.push({
          path: memoryFile,
          lines: matches.slice(0, 3),
        });
      } catch {
        // MEMORY.md may not exist
      }
    } catch {
      // memory directory may not exist
    }

    return results.slice(0, limit);
  }

  async getMemoryContent(section?: string): Promise<string> {
    if (!this.config.workspacePath) return "";

    const memoryPath = path.join(this.config.workspacePath, "MEMORY.md");
    const content = await fs.readFile(memoryPath, "utf-8").catch(() => "");
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

  get workspacePath(): string {
    return this.config.workspacePath;
  }
}
