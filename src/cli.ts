#!/usr/bin/env bun

function printHelp() {
  console.log(`
Flash Claw CLI

用法: flashclaw <command> [options]

命令:
  run                   启动 Flash Claw 服务器
  tasks                 列出所有任务
  tasks --cleanall      清除所有任务
  tasks --run <id>      手动触发任务
  skills                列出所有 Skills
  skills <name>         获取指定 Skill 详情
  help                  显示此帮助信息

示例:
  flashclaw run
  flashclaw tasks
  flashclaw tasks --cleanall
  flashclaw tasks --run 1
  flashclaw skills
`.trim());
}

async function cmdRun() {
  console.log("Starting Flash Claw server...");
  const { default: server } = await import("./index.js");
  await server.fetch(new Request("http://localhost:3000"));
}

async function cmdTasks(args: string[]) {
  const { taskScheduler } = await import("./tasks/index.js");

  if (args.includes("--cleanall")) {
    const tasks = taskScheduler.listTasks();
    for (const task of tasks) {
      await taskScheduler.deleteTask(task.id);
    }
    console.log(`已清除 ${tasks.length} 个任务`);
    process.exit(0);
    return;
  }

  const runIndex = args.indexOf("--run");
  if (runIndex !== -1 && args[runIndex + 1]) {
    const id = parseInt(args[runIndex + 1]);
    await taskScheduler.runTask(id);
    console.log(`任务 ${id} 已触发执行`);
    process.exit(0);
    return;
  }

  const tasks = taskScheduler.listTasks();
  if (tasks.length === 0) {
    console.log("暂无任务");
    process.exit(0);
    return;
  }

  console.log("任务列表:");
  for (const task of tasks) {
    console.log(`  ${task.id}. ${task.name} (${task.schedule || "一次性"})`);
  }
  process.exit(0);
}

async function cmdSkills(args: string[]) {
  const { listSkills, getSkill } = await import("./skills/index.js");

  if (args.length > 0) {
    const skillName = args[0];
    const skill = getSkill(skillName);
    if (!skill) {
      console.error(`Skill "${skillName}" 不存在`);
      process.exit(1);
    }
    console.log(`# ${skill.name}`);
    console.log(`\n${skill.description}\n`);
    console.log(`## 指令\n${skill.instructions}`);
    process.exit(0);
  }

  const skills = listSkills();
  if (skills.length === 0) {
    console.log("暂无 Skills");
    process.exit(0);
  }

  console.log("Skills 列表:");
  for (const skill of skills) {
    console.log(`  ${skill.name}: ${skill.description}`);
  }
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "run":
      await cmdRun();
      break;
    case "tasks":
      await cmdTasks(args.slice(1));
      break;
    case "skills":
      await cmdSkills(args.slice(1));
      break;
    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(console.error);
