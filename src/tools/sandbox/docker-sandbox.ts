import Dockerode from "dockerode";
import type {
  SandboxConfig,
  SandboxInstance,
  ExecResult,
  PoolStats,
} from "./sandbox-types.js";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox-types.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class DockerSandboxManager {
  private docker: Dockerode;
  private config: SandboxConfig;
  private logger: Logger;
  private initialized = false;
  private pool: Map<string, SandboxInstance> = new Map();
  private sessionMap: Map<string, string> = new Map();
  private waitQueue: Array<{
    resolve: (instance: SandboxInstance) => void;
    reject: (err: Error) => void;
  }> = [];
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: Partial<SandboxConfig> = {},
    logger: Logger = console,
  ) {
    this.docker = new Dockerode();
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.docker.ping();
      this.logger.info("Docker daemon connected");
    } catch {
      throw new Error(
        "Docker daemon not available. " +
        "SandboxManager requires Docker to be running. " +
        "Install Docker: https://docs.docker.com/get-docker/"
      );
    }

    await this.ensureImage();

    const warmupPromises: Promise<void>[] = [];
    for (let i = 0; i < this.config.poolMinSize; i++) {
      warmupPromises.push(this.createContainer());
    }
    await Promise.all(warmupPromises);
    this.logger.info(`Container pool warmed up: ${this.config.poolMinSize} containers ready`);

    this.idleCheckInterval = setInterval(
      () => this.reclaimIdleContainers(),
      60_000
    );

    this.initialized = true;
  }

  async acquire(sessionId: string): Promise<SandboxInstance> {
    const existingId = this.sessionMap.get(sessionId);
    if (existingId) {
      const existing = this.pool.get(existingId);
      if (existing && (existing.status === "idle" || existing.status === "busy")) {
        existing.status = "busy";
        existing.lastUsedAt = Date.now();
        return existing;
      }
    }

    for (const [, instance] of this.pool) {
      if (instance.status === "idle" && !instance.sessionId) {
        instance.status = "busy";
        instance.sessionId = sessionId;
        instance.lastUsedAt = Date.now();
        this.sessionMap.set(sessionId, instance.containerId);
        return instance;
      }
    }

    if (this.pool.size < this.config.poolMaxSize) {
      await this.createContainer();
      return this.acquire(sessionId);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Sandbox acquire timeout: all containers busy"));
      }, 30_000);
      this.waitQueue.push({
        resolve: (instance) => {
          clearTimeout(timeout);
          instance.sessionId = sessionId;
          this.sessionMap.set(sessionId, instance.containerId);
          resolve(instance);
        },
        reject,
      });
    });
  }

  async release(sessionId: string): Promise<void> {
    const containerId = this.sessionMap.get(sessionId);
    if (!containerId) return;

    const instance = this.pool.get(containerId);
    if (!instance) return;

    this.sessionMap.delete(sessionId);
    instance.sessionId = null;
    instance.lastUsedAt = Date.now();

    if (Date.now() - instance.createdAt > this.config.maxLifetimeMs) {
      await this.destroyContainer(containerId);
      await this.createContainer();
      return;
    }

    try {
      await this.execInContainer(containerId, "rm -rf /workspace/* /workspace/.*", 5000);
    } catch {
      await this.destroyContainer(containerId);
      await this.createContainer();
      return;
    }

    instance.status = "idle";

    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      instance.status = "busy";
      waiter.resolve(instance);
    }
  }

  async exec(sessionId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const instance = await this.acquire(sessionId);
    const startTime = Date.now();

    try {
      return await this.execInContainer(instance.containerId, command, timeoutMs);
    } finally {
      // Not auto-released - caller decides when to release
    }
  }

  async readFile(sessionId: string, filePath: string): Promise<string> {
    const result = await this.exec(sessionId, `cat "${filePath}"`, 10_000);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${filePath}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async writeFile(sessionId: string, filePath: string, content: string): Promise<void> {
    const instance = await this.acquire(sessionId);
    const container = this.docker.getContainer(instance.containerId);

    const tarStream = this.createTarStream(filePath, content);
    await container.putArchive(tarStream, { path: "/workspace" });
  }

  async listDir(sessionId: string, dirPath: string): Promise<string[]> {
    const result = await this.exec(sessionId, `ls -la "${dirPath}"`, 5000);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list directory ${dirPath}: ${result.stderr}`);
    }
    return result.stdout.split("\n").filter(Boolean);
  }

  getPoolStats(): PoolStats {
    let idle = 0, busy = 0;
    for (const inst of this.pool.values()) {
      if (inst.status === "idle") idle++;
      else if (inst.status === "busy") busy++;
    }
    return {
      totalContainers: this.pool.size,
      idleContainers: idle,
      busyContainers: busy,
      waitingRequests: this.waitQueue.length,
    };
  }

  async dispose(): Promise<void> {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }
    const destroyPromises = Array.from(this.pool.keys()).map((id) =>
      this.destroyContainer(id)
    );
    await Promise.allSettled(destroyPromises);
    this.pool.clear();
    this.sessionMap.clear();
    this.logger.info("DockerSandboxManager disposed: all containers destroyed");
  }

  private async createContainer(): Promise<void> {
    const container = await this.docker.createContainer({
      Image: this.config.image,
      Cmd: ["sleep", "infinity"],
      WorkingDir: "/workspace",
      User: "sandbox",
      HostConfig: {
        Memory: this.config.memoryLimit,
        CpuQuota: this.config.cpuQuota,
        PidsLimit: this.config.pidsLimit,
        NetworkMode: this.config.networkMode,
        ReadonlyRootfs: false,
        SecurityOpt: ["no-new-privileges:true"],
        CapDrop: ["ALL"],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=128m" },
        Binds: this.config.workspaceMountPath
          ? [`${this.config.workspaceMountPath}:/workspace/shared:ro`]
          : [],
      },
    });

    await container.start();

    const instance: SandboxInstance = {
      containerId: container.id,
      workDir: "/workspace",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "idle",
      sessionId: null,
    };

    this.pool.set(container.id, instance);
    this.logger.debug(`Container created: ${container.id.substring(0, 12)}`);
  }

  private async destroyContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
    } catch {
      // Container may already be stopped
    }
    this.pool.delete(containerId);
    this.logger.debug(`Container destroyed: ${containerId.substring(0, 12)}`);
  }

  private async execInContainer(
    containerId: string,
    command: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    const container = this.docker.getContainer(containerId);
    const startTime = Date.now();

    const exec = await container.exec({
      Cmd: ["bash", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      User: "sandbox",
    });

    return new Promise<ExecResult>((resolve) => {
      const timeout = setTimeout(async () => {
        try {
          const info = await exec.inspect();
          if (info.Running) {
            await container.exec({
              Cmd: ["kill", "-9", String(info.Pid)],
            });
          }
        } catch {
          // Ignore
        }
        resolve({
          exitCode: -1,
          stdout: "",
          stderr: "Execution timed out",
          timedOut: true,
          durationMs: Date.now() - startTime,
        });
      }, timeoutMs);

      exec.start({ Detach: false }, (err: Error | undefined, stream: NodeJS.ReadableStream | undefined) => {
        if (err || !stream) {
          clearTimeout(timeout);
          resolve({
            exitCode: -1,
            stdout: "",
            stderr: err?.message ?? "Failed to start exec",
            timedOut: false,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        let stdout = "";
        let stderr = "";

        container.modem.demuxStream(stream, {
          write: (chunk: Buffer) => { stdout += chunk.toString(); },
        }, {
          write: (chunk: Buffer) => { stderr += chunk.toString(); },
        });

        stream.on("end", async () => {
          clearTimeout(timeout);
          const inspectResult = await exec.inspect();
          resolve({
            exitCode: inspectResult.ExitCode ?? -1,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            timedOut: false,
            durationMs: Date.now() - startTime,
          });
        });
      });
    });
  }

  private async reclaimIdleContainers(): Promise<void> {
    const now = Date.now();
    for (const [id, instance] of this.pool) {
      if (
        instance.status === "idle" &&
        !instance.sessionId &&
        now - instance.lastUsedAt > this.config.idleTimeoutMs &&
        this.pool.size > this.config.poolMinSize
      ) {
        await this.destroyContainer(id);
      }
    }
  }

  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.config.image).inspect();
      this.logger.info(`Sandbox image found: ${this.config.image}`);
    } catch {
      this.logger.info(`Building sandbox image: ${this.config.image}...`);
      // Build from embedded Dockerfile
      const buildStream = await this.docker.buildImage(
        { context: "./docker", src: ["Dockerfile.sandbox"] },
        { t: this.config.image },
      );
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(buildStream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.logger.info(`Sandbox image built: ${this.config.image}`);
    }
  }

  private createTarStream(filePath: string, content: string): NodeJS.ReadableStream {
    const { Buffer } = require("buffer");
    const tar = require("tar");

    const chunks: Buffer[] = [];
    const readable = new (require("stream").Readable)({
      read() {
        // Will be populated by tar stream
      },
    });

    const entry = {
      cwd: "/workspace",
      file: filePath,
      content: Buffer.from(content, "utf-8"),
    };

    const pack = tar.pack();
    pack.entry({ name: filePath }, content);
    pack.end();

    return pack;
  }
}
