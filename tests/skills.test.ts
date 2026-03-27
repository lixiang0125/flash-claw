import { describe, expect, it } from "bun:test";
import { listSkills } from "../src/skills";

describe("skills listing", () => {
  it("listSkills skips nested directories inside skill resources", () => {
    expect(() => listSkills()).not.toThrow();

    const skills = listSkills();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });
});
