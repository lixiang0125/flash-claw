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
  instructions: string;
  references: string[];
  scripts: Record<string, string>;
}

const SKILLS_DIR = path.join(process.cwd(), "skills");

/**
 * 解析 YAML frontmatter
 */
function parseFrontmatter(content: string): { meta: SkillMeta; content: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
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
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const skill = loadSkill(dir.name);
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * 加载指定 Skill
 */
export function getSkill(name: string): Skill | null {
  return loadSkill(name);
}

/**
 * 加载 Skill 及其资源
 */
function loadSkill(name: string): Skill | null {
  const skillPath = path.join(SKILLS_DIR, name);
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
  const skillPath = path.join(SKILLS_DIR, skillName, "scripts", scriptName);

  if (!fs.existsSync(skillPath)) {
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
