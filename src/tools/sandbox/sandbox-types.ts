export interface SandboxConfig {
  useDocker: boolean;
  image: string;
  poolMinSize: number;
  poolMaxSize: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  memoryLimit: number;
  cpuQuota: number;
  pidsLimit: number;
  networkMode: "none" | "bridge";
  workspaceMountPath: string;
}

export interface SandboxInstance {
  containerId: string;
  workDir: string;
  createdAt: number;
  lastUsedAt: number;
  status: "creating" | "idle" | "busy" | "stopping" | "stopped";
  sessionId: string | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface PoolStats {
  totalContainers: number;
  idleContainers: number;
  busyContainers: number;
  waitingRequests: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  useDocker: process.env.USE_DOCKER_SANDBOX === "true",
  image: "flashclaw-sandbox:latest",
  poolMinSize: 1,
  poolMaxSize: 5,
  idleTimeoutMs: 5 * 60 * 1000,
  maxLifetimeMs: 60 * 60 * 1000,
  memoryLimit: 512 * 1024 * 1024,
  cpuQuota: 50_000,
  pidsLimit: 128,
  networkMode: "none",
  workspaceMountPath: "",
};
