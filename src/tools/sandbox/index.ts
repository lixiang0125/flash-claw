export { SandboxManager } from "./sandbox-manager.js";
export { DockerSandboxManager } from "./docker-sandbox.js";
export type { ISandboxManager } from "./sandbox-manager.js";
export type { SandboxConfig, SandboxInstance, ExecResult, PoolStats } from "./sandbox-types.js";
export { DEFAULT_SANDBOX_CONFIG } from "./sandbox-types.js";

import { SandboxManager } from "./sandbox-manager.js";
import { DockerSandboxManager } from "./docker-sandbox.js";
import type { SandboxConfig } from "./sandbox-types.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createSandboxManager(
  config: Partial<SandboxConfig> & { useDocker?: boolean } = {},
  logger: Logger = console,
) {
  if (config.useDocker) {
    return new DockerSandboxManager(config, logger);
  }
  return new SandboxManager(config, logger);
}
