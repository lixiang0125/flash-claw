import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  allowed_tools?: string[];
  disable_user_invocation?: boolean;
  disable_model_invocation?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  version?: string;
  allowed_tools?: string[];
  disable_user_invocation?: boolean;
  disable_model_invocation?: boolean;
  instructions: string;
  references: string[];
  scripts: Record<string, string>;
}

/**
 * 搜索 Skills 的目录列表
 * 优先级从高到低：
 * 1. .flashclaw/skills/ (项目级)
 * 2. .agents/skills/ (项目级)
 * 3. 向上查找父目录的相同路径
 */
function findSkillsDirs(): string[] {
  const dirs: string[] = [];
  const candidates = [".flashclaw/skills", ".agents/skills"];
  
  let currentDir = process.cwd();
  
  while (currentDir && currentDir !== path.dirname(currentDir)) {
    for (const candidate of candidates) {
      const fullPath = path.join(currentDir, candidate);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        dirs.push(fullPath);
      }
    }
    currentDir = path.dirname(currentDir);
  }
  
  return dirs;
}

const SKILLS_BASE_DIRS = findSkillsDirs();

/**
 * 解析 YAML frontmatter
 */
function parseFrontmatter(content: string): { meta: SkillMeta; content: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match || !match[1] || !match[2]) {
    return {
      meta: { name: "", description: "" },
      content,
    };
  }

  const frontmatter = match[1];
  const body = match[2];
  const meta: SkillMeta = { name: "", description: "" };

  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key === "name") meta.name = value;
    else if (key === "description") meta.description = value;
    else if (key === "version") meta.version = value;
    else if (key === "allowed_tools") meta.allowed_tools = value.split(",").map((t) => t.trim());
    else if (key === "disable_user_invocation") meta.disable_user_invocation = value === "true";
    else if (key === "disable_model_invocation") meta.disable_model_invocation = value === "true";
  }

  return { meta, content: body };
}

/**
 * 列出所有可用的 Skills
 */
export function listSkills(): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const baseDir of SKILLS_BASE_DIRS) {
    if (!fs.existsSync(baseDir)) continue;

    const dirs = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (seen.has(dir.name)) continue;

      const skill = loadSkillFromDir(baseDir, dir.name);
      if (skill) {
        seen.add(dir.name);
        skills.push(skill);
      }
    }
  }

  return skills;
}

/**
 * 加载指定 Skill
 */
export function getSkill(name: string): Skill | null {
  for (const baseDir of SKILLS_BASE_DIRS) {
    const skill = loadSkillFromDir(baseDir, name);
    if (skill) return skill;
  }
  return null;
}

/**
 * 从指定目录加载 Skill
 */
function loadSkillFromDir(baseDir: string, name: string): Skill | null {
  const skillPath = path.join(baseDir, name);
  const skillFile = path.join(skillPath, "SKILL.md");

  if (!fs.existsSync(skillFile)) {
    return null;
  }

  const content = fs.readFileSync(skillFile, "utf-8");
  const { meta, content: instructions } = parseFrontmatter(content);

  const references: string[] = [];
  const refsPath = path.join(skillPath, "references");
  if (fs.existsSync(refsPath)) {
    const files = fs.readdirSync(refsPath);
    for (const file of files) {
      if (file.endsWith(".md")) {
        const refContent = fs.readFileSync(path.join(refsPath, file), "utf-8");
        references.push(`## ${file}\n\n${refContent}`);
      }
    }
  }

  const scripts: Record<string, string> = {};
  const scriptsPath = path.join(skillPath, "scripts");
  if (fs.existsSync(scriptsPath)) {
    const files = fs.readdirSync(scriptsPath);
    for (const file of files) {
      const scriptPath = path.join(scriptsPath, file);
      scripts[file] = fs.readFileSync(scriptPath, "utf-8");
    }
  }

  return {
    name: meta.name || name,
    description: meta.description,
    version: meta.version,
    allowed_tools: meta.allowed_tools,
    disable_user_invocation: meta.disable_user_invocation,
    disable_model_invocation: meta.disable_model_invocation,
    instructions: instructions.trim(),
    references,
    scripts,
  };
}

/**
 * 搜索 Skills
 */
export function searchSkills(query: string): Skill[] {
  const allSkills = listSkills();
  const lowerQuery = query.toLowerCase();

  return allSkills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(lowerQuery) ||
      skill.description.toLowerCase().includes(lowerQuery)
  );
}

/**
 * 执行 Skill 脚本
 */
export function executeScript(
  skillName: string,
  scriptName: string,
  args: string[] = []
): { stdout: string; stderr: string } | null {
  let skillPath: string | null = null;

  for (const baseDir of SKILLS_BASE_DIRS) {
    const p = path.join(baseDir, skillName, "scripts", scriptName);
    if (fs.existsSync(p)) {
      skillPath = p;
      break;
    }
  }

  if (!skillPath) {
    return null;
  }

  try {
    const ext = path.extname(scriptName);
    let stdout = "";
    let stderr = "";

    if (ext === ".sh" || ext === ".bash") {
      stdout = execSync(`bash ${skillPath} ${args.join(" ")}`, {
        encoding: "utf-8",
        cwd: path.dirname(skillPath),
      });
    } else if (ext === ".py") {
      stdout = execSync(`python ${skillPath} ${args.join(" ")}`, {
        encoding: "utf-8",
        cwd: path.dirname(skillPath),
      });
    } else if (ext === ".js") {
      stdout = execSync(`node ${skillPath} ${args.join(" ")}`, {
        encoding: "utf-8",
        cwd: path.dirname(skillPath),
      });
    }

    return { stdout, stderr };
  } catch (error: any) {
    return { stdout: "", stderr: error.message };
  }
}
