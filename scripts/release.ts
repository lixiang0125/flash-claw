#!/usr/bin/env bun

import { execSync } from "child_process";

function getChangedFiles() {
  const status = execSync("git status --porcelain", { encoding: "utf-8" });
  return status
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.substring(3));
}

async function generateChangelog() {
  const changedFiles = getChangedFiles();
  const date = new Date().toISOString().split("T")[0];
  
  let content = `# Changelog\n\n## ${date}\n\n`;
  
  if (changedFiles.length === 0) {
    console.log("No changes to commit");
    return null;
  }

  content += `**Changed files:**\n`;
  changedFiles.forEach((file) => {
    content += `- ${file}\n`;
  });

  try {
    const existing = await Bun.file("CHANGELOG.md").text();
    const newContent = content + "\n" + existing;
    await Bun.write("CHANGELOG.md", newContent);
  } catch {
    await Bun.write("CHANGELOG.md", content);
  }

  return content;
}

async function main() {
  const changes = await generateChangelog();
  if (!changes) process.exit(0);

  try {
    execSync("git add -A");
    execSync('git commit -m "chore: update changelog"');
    console.log("Committed successfully");
    
    execSync("git push");
    console.log("Pushed successfully");
    
    console.log("Changelog generated, committed and pushed successfully");
  } catch (e) {
    console.error("Git error:", e);
  }
}

main();
