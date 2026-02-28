import fs from "fs";
import path from "path";

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  examples?: string[];
  scripts?: Record<string, string>;
}

const SKILLS_DIR = path.join(process.cwd(), "skills");

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
    
    const skillPath = path.join(SKILLS_DIR, dir.name);
    const skillFile = path.join(skillPath, "skill.json");
    
    if (fs.existsSync(skillFile)) {
      const content = fs.readFileSync(skillFile, "utf-8");
      const skill = JSON.parse(content) as Skill;
      skill.name = dir.name;
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * 根据名称获取 Skill
 */
export function getSkill(name: string): Skill | null {
  const skillPath = path.join(SKILLS_DIR, name, "skill.json");
  
  if (!fs.existsSync(skillPath)) {
    return null;
  }

  const content = fs.readFileSync(skillPath, "utf-8");
  return JSON.parse(content) as Skill;
}

/**
 * 搜索 Skills
 */
export function searchSkills(query: string): Skill[] {
  const allSkills = listSkills();
  const lowerQuery = query.toLowerCase();
  
  return allSkills.filter(skill => 
    skill.name.toLowerCase().includes(lowerQuery) ||
    skill.description.toLowerCase().includes(lowerQuery)
  );
}
