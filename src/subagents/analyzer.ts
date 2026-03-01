import type { ToolResult } from "../tools";

export interface SubTask {
  description: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface ComplexityAnalysis {
  shouldUseSubAgent: boolean;
  reason: string;
  estimatedFiles: number;
  estimatedTime: number;
  subTasks: SubTask[];
}

const COMPLEXITY_THRESHOLDS = {
  minFiles: 3,
  minIndependentTasks: 2,
  longCommandThreshold: 30,
  complexPatterns: [
    /\*\*\/.*\.\w+/g,
    /iterate.*files/gi,
    /batch.*process/gi,
    /convert.*files/gi,
    /refactor.*files/gi,
    /update.*files/gi,
  ],
};

export function analyzeComplexity(
  toolCalls: { tool: string; args: Record<string, unknown> }[],
  userMessage: string
): ComplexityAnalysis {
  const fileOperations = toolCalls.filter(tc =>
    ["Read", "Write", "Edit", "Glob"].includes(tc.tool)
  );

  const uniqueFiles = new Set<string>();
  for (const op of fileOperations) {
    if (op.args.filePath) {
      uniqueFiles.add(op.args.filePath as string);
    }
    if (op.args.pattern) {
      uniqueFiles.add(op.args.pattern as string);
    }
  }

  const estimatedFiles = uniqueFiles.size;
  const hasMultipleIndependentTasks = detectIndependentTasks(toolCalls);
  const hasComplexPattern = detectComplexPattern(userMessage);
  const hasLongCommands = detectLongRunningCommands(toolCalls);

  const estimatedTime = calculateEstimatedTime(toolCalls);

  const shouldUseSubAgent =
    estimatedFiles >= COMPLEXITY_THRESHOLDS.minFiles ||
    hasMultipleIndependentTasks ||
    hasLongCommands;

  const subTasks = splitIntoSubTasks(toolCalls, userMessage);

  let reason = "";
  if (estimatedFiles >= COMPLEXITY_THRESHOLDS.minFiles) {
    reason = `涉及 ${estimatedFiles} 个文件操作`;
  } else if (hasMultipleIndependentTasks) {
    reason = "任务可分解为多个独立子任务";
  } else if (hasLongCommands) {
    reason = "包含耗时较长的命令执行";
  } else if (hasComplexPattern) {
    reason = "检测到复杂任务模式";
  }

  return {
    shouldUseSubAgent,
    reason: reason || "任务复杂度较低",
    estimatedFiles,
    estimatedTime,
    subTasks,
  };
}

function detectIndependentTasks(
  toolCalls: { tool: string; args: Record<string, unknown> }[]
): boolean {
  if (toolCalls.length < COMPLEXITY_THRESHOLDS.minIndependentTasks) {
    return false;
  }

  const operationsByType = new Map<string, number>();
  for (const tc of toolCalls) {
    operationsByType.set(tc.tool, (operationsByType.get(tc.tool) || 0) + 1);
  }

  for (const count of operationsByType.values()) {
    if (count >= COMPLEXITY_THRESHOLDS.minIndependentTasks) {
      return true;
    }
  }

  return toolCalls.length >= 4;
}

function detectComplexPattern(message: string): boolean {
  for (const pattern of COMPLEXITY_THRESHOLDS.complexPatterns) {
    if (pattern.test(message)) {
      return true;
    }
  }
  return false;
}

function detectLongRunningCommands(
  toolCalls: { tool: string; args: Record<string, unknown> }[]
): boolean {
  const longCommands = [
    /npm\s+install/gi,
    /npm\s+run/gi,
    /bun\s+install/gi,
    /yarn\s+install/gi,
    /pip\s+install/gi,
    /make\s+build/gi,
    /docker\s+build/gi,
    /docker\s+run/gi,
    /git\s+clone/gi,
    /git\s+pull/gi,
    /rsync/gi,
    /curl.*-o/gi,
    /wget/gi,
    /chmod.*\+/gi,
    /chown/gi,
  ];

  for (const tc of toolCalls) {
    if (tc.tool === "Bash" && tc.args.command) {
      const cmd = tc.args.command as string;
      for (const pattern of longCommands) {
        if (pattern.test(cmd)) {
          return true;
        }
      }
    }
  }

  return false;
}

function calculateEstimatedTime(
  toolCalls: { tool: string; args: Record<string, unknown> }[]
): number {
  let time = 0;

  for (const tc of toolCalls) {
    switch (tc.tool) {
      case "Bash":
        const cmd = (tc.args.command as string || "").toLowerCase();
        if (cmd.includes("install") || cmd.includes("build")) {
          time += 60;
        } else if (cmd.includes("test")) {
          time += 30;
        } else {
          time += 5;
        }
        break;
      case "Glob":
      case "Grep":
        time += 3;
        break;
      case "Read":
      case "WebFetch":
        time += 5;
        break;
      case "Write":
      case "Edit":
        time += 2;
        break;
      default:
        time += 1;
    }
  }

  return time;
}

export function splitIntoSubTasks(
  toolCalls: { tool: string; args: Record<string, unknown> }[],
  userMessage: string
): SubTask[] {
  const subTasks: SubTask[] = [];

  const operationsByType = new Map<string, typeof toolCalls>();
  for (const tc of toolCalls) {
    const key = `${tc.tool}:${JSON.stringify(tc.args)}`;
    if (!operationsByType.has(tc.tool)) {
      operationsByType.set(tc.tool, []);
    }
    operationsByType.get(tc.tool)!.push(tc);
  }

  const fileOps = operationsByType.get("Write") || [];
  const editOps = operationsByType.get("Edit") || [];

  if (fileOps.length > 0) {
    const taskDescription = fileOps
      .map((op) => op.args.filePath)
      .filter(Boolean)
      .join(", ");

    subTasks.push({
      description: `创建/写入文件: ${taskDescription}`,
      tool: "Write",
      args: fileOps[0]?.args,
    });
  }

  if (editOps.length > 0) {
    const taskDescription = editOps
      .map((op) => op.args.filePath)
      .filter(Boolean)
      .join(", ");

    subTasks.push({
      description: `编辑文件: ${taskDescription}`,
      tool: "Edit",
      args: editOps[0]?.args,
    });
  }

  const bashOps = operationsByType.get("Bash") || [];
  for (const op of bashOps) {
    subTasks.push({
      description: `执行命令: ${op.args.command}`,
      tool: "Bash",
      args: op.args,
    });
  }

  const searchOps = [
    ...(operationsByType.get("Glob") || []),
    ...(operationsByType.get("Grep") || []),
  ];
  for (const op of searchOps) {
    subTasks.push({
      description: `${op.tool}: ${op.args.pattern || op.args.filePath}`,
      tool: op.tool,
      args: op.args,
    });
  }

  if (subTasks.length === 0 && toolCalls.length > 0) {
    subTasks.push({
      description: userMessage.substring(0, 100),
    });
  }

  return subTasks;
}
