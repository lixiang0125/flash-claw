import { EventEmitter } from "node:events";
import type { EventMap, Logger } from "./tokens";

export type EventName = keyof EventMap;

export type EventHandler<K extends EventName> = (payload: EventMap[K]) => void;

export class TypedEventBus {
  private readonly emitter: EventEmitter;
  private readonly logger: Logger | null;
  private disposed = false;

  constructor(logger: Logger | null = null) {
    this.emitter = new EventEmitter();
    this.logger = logger;
    this.emitter.setMaxListeners(100);
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.ensureNotDisposed();
    this.logger?.debug(`事件触发: ${String(event)}`, {
      payload: payload as Record<string, unknown>,
    });

    const listeners = this.emitter.listeners(event as string);

    for (const listener of listeners) {
      try {
        (listener as EventHandler<K>)(payload);
      } catch (err) {
        this.logger?.error(`事件处理器异常: ${String(event)}`, {
          error: err instanceof Error ? err.message : String(err),
        });

        if (event !== "system:error") {
          try {
            this.emitter.emit("system:error", {
              error: err instanceof Error ? err : new Error(String(err)),
              context: `事件处理器异常: ${String(event)}`,
            });
          } catch {
            // 防止无限递归
          }
        }
      }
    }
  }

  on<K extends EventName>(event: K, handler: EventHandler<K>): void {
    this.ensureNotDisposed();
    this.emitter.on(event as string, handler as (...args: unknown[]) => void);
  }

  off<K extends EventName>(event: K, handler: EventHandler<K>): void {
    this.emitter.off(event as string, handler as (...args: unknown[]) => void);
  }

  once<K extends EventName>(event: K, handler: EventHandler<K>): void {
    this.ensureNotDisposed();
    this.emitter.once(event as string, handler as (...args: unknown[]) => void);
  }

  waitFor<K extends EventName>(
    event: K,
    timeoutMs?: number,
  ): Promise<EventMap[K]> {
    return new Promise<EventMap[K]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const handler: EventHandler<K> = (payload) => {
        if (timer) clearTimeout(timer);
        resolve(payload);
      };

      this.once(event, handler);

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.off(event, handler);
          reject(
            new Error(`等待事件 "${String(event)}" 超时 (${timeoutMs}ms)`),
          );
        }, timeoutMs);
      }
    });
  }

  listenerCount<K extends EventName>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  dispose(): void {
    this.removeAllListeners();
    this.disposed = true;
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("[EventBus] 事件总线已销毁");
    }
  }
}
