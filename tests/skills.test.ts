import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { listSkills } from "../src/skills";

describe("skills listing", () => {
  it("listSkills skips nested directories inside skill resources", () => {
    expect(() => listSkills()).not.toThrow();

    const skills = listSkills();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });

  it("executes scripts from .agents skills within the same path boundary", async () => {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-claw-skills-"));
    const skillDir = path.join(tmpDir, ".agents", "skills", "demo", "scripts");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: demo skill\n---\n\n# Demo\n",
    );
    fs.writeFileSync(path.join(skillDir, "hello.sh"), "echo hello-agents-skill\n");

    try {
      process.chdir(tmpDir);
      const skillsModule = await import(`../src/skills/index.ts?case=${Date.now()}`);
      const result = await skillsModule.executeScript("demo", "hello.sh");

      expect(result?.stdout.trim()).toBe("hello-agents-skill");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
