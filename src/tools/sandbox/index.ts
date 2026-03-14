export { SandboxManager } from "./sandbox-manager.js";
export type { ISandboxManager } from "./sandbox-manager.js";
export type { SandboxConfig, SandboxInstance, ExecResult, PoolStats } from "./sandbox-types.js";
export { DEFAULT_SANDBOX_CONFIG } from "./sandbox-types.js";

import { SandboxManager } from "./sandbox-manager.js";
import type { SandboxConfig } from "./sandbox-types.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 创建沙箱管理器。
 * DockerSandboxManager 使用动态 import 延迟加载，避免在未安装 dockerode 的
 * 环境（CI / 本地开发）中因顶层 import 而报错。
 */
export function createSandboxManager(
  config: Partial<SandboxConfig> & { useDocker?: boolean } = {},
  logger: Logger = console,
) {
  if (config.useDocker) {
    // 延迟加载 DockerSandboxManager，仅在 useDocker 时才 require dockerode
    const { DockerSandboxManager } = require("./docker-sandbox.js");
    return new DockerSandboxManager(config, logger);
  }
  return new SandboxManager(config, logger);
}
