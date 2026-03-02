import {
  type ServiceToken,
  type ServiceDescriptor,
  type ServiceResolver,
  type ContainerOptions,
  type RegisterOptions,
  Lifecycle,
  isDisposable,
  isAsyncInitializable,
  createToken,
} from "./types";

export { Lifecycle, createToken };
export type { ServiceToken, ServiceResolver, ContainerOptions, RegisterOptions };

export class Container implements ServiceResolver {
  private readonly registry = new Map<symbol, ServiceDescriptor<any>>();
  private readonly resolutionStack: Set<symbol> = new Set();
  private readonly options: Required<ContainerOptions>;
  private disposed = false;
  private readonly registrationOrder: symbol[] = [];

  constructor(options: ContainerOptions = {}) {
    this.options = {
      enableLogging: options.enableLogging ?? false,
      maxResolutionDepth: options.maxResolutionDepth ?? 50,
      logFn: options.logFn ?? console.log,
    };
  }

  register<T>(options: RegisterOptions<T>): this {
    this.ensureNotDisposed();

    const { token, lifecycle = Lifecycle.Singleton, factory } = options;

    if (this.registry.has(token.symbol)) {
      throw new Error(
        `[Container] 服务 "${token.description}" 已注册，不允许重复注册。` +
          `如需替换，请先调用 unregister() 或使用 override()。`
      );
    }

    const descriptor: ServiceDescriptor<T> = {
      token,
      lifecycle,
      factory,
      instance: undefined,
      initialized: false,
    };

    this.registry.set(token.symbol, descriptor);
    this.registrationOrder.push(token.symbol);

    this.log(`已注册服务: ${token.description} [${lifecycle}]`);

    return this;
  }

  override<T>(options: RegisterOptions<T>): this {
    this.ensureNotDisposed();

    const { token, lifecycle = Lifecycle.Singleton, factory } = options;

    const descriptor: ServiceDescriptor<T> = {
      token,
      lifecycle,
      factory,
      instance: undefined,
      initialized: false,
    };

    this.registry.set(token.symbol, descriptor);

    if (!this.registrationOrder.includes(token.symbol)) {
      this.registrationOrder.push(token.symbol);
    }

    this.log(`已覆盖服务: ${token.description} [${lifecycle}]`);

    return this;
  }

  resolve<T>(token: ServiceToken<T>): T {
    this.ensureNotDisposed();

    const descriptor = this.registry.get(token.symbol) as
      | ServiceDescriptor<T>
      | undefined;

    if (!descriptor) {
      throw new Error(
        `[Container] 服务 "${token.description}" 未注册。` +
          `请确认是否在 bootstrap 阶段正确注册了该服务。`
      );
    }

    return this.resolveDescriptor(descriptor);
  }

  tryResolve<T>(token: ServiceToken<T>): T | undefined {
    if (!this.has(token)) {
      return undefined;
    }
    return this.resolve(token);
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.registry.has(token.symbol);
  }

  createScope(): ScopedContainer {
    this.ensureNotDisposed();
    return new ScopedContainer(this, this.options);
  }

  async initializeAll(): Promise<void> {
    this.ensureNotDisposed();

    this.log("开始异步初始化所有服务...");

    for (const sym of this.registrationOrder) {
      const descriptor = this.registry.get(sym);
      if (!descriptor) continue;

      if (
        descriptor.lifecycle === Lifecycle.Singleton &&
        !descriptor.initialized
      ) {
        const instance = this.resolveDescriptor(descriptor);

        if (isAsyncInitializable(instance)) {
          this.log(`正在异步初始化: ${descriptor.token.description}`);
          await instance.initialize();
          this.log(`异步初始化完成: ${descriptor.token.description}`);
        }

        descriptor.initialized = true;
      }
    }

    this.log("所有服务初始化完成");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;

    this.log("开始销毁容器...");

    const reversed = [...this.registrationOrder].reverse();

    for (const sym of reversed) {
      const descriptor = this.registry.get(sym);
      if (!descriptor || !descriptor.instance) continue;

      if (isDisposable(descriptor.instance)) {
        try {
          this.log(`正在释放: ${descriptor.token.description}`);
          await descriptor.instance.dispose();
        } catch (err) {
          this.log(`释放 ${descriptor.token.description} 时出错: ${err}`);
        }
      }
    }

    this.registry.clear();
    this.registrationOrder.length = 0;
    this.disposed = true;

    this.log("容器已销毁");
  }

  getRegisteredServices(): string[] {
    return this.registrationOrder
      .map((sym) => this.registry.get(sym)?.token.description)
      .filter((desc): desc is string => desc !== undefined);
  }

  protected resolveDescriptor<T>(descriptor: ServiceDescriptor<T>): T {
    const { token, lifecycle, factory } = descriptor;

    if (this.resolutionStack.has(token.symbol)) {
      const chain = [...this.resolutionStack]
        .map((sym) => this.registry.get(sym)?.token.description ?? "unknown")
        .join(" → ");
      throw new Error(
        `[Container] 检测到循环依赖: ${chain} → ${token.description}。` +
          `请通过 EventBus 事件解耦或延迟解析来打破循环。`
      );
    }

    if (this.resolutionStack.size >= this.options.maxResolutionDepth) {
      throw new Error(
        `[Container] 解析深度超过 ${this.options.maxResolutionDepth}，` +
          `可能存在过深的依赖链。服务: ${token.description}`
      );
    }

    if (
      lifecycle === Lifecycle.Singleton &&
      descriptor.instance !== undefined
    ) {
      return descriptor.instance;
    }

    this.resolutionStack.add(token.symbol);
    try {
      const instance = factory(this);

      if (lifecycle === Lifecycle.Singleton) {
        descriptor.instance = instance;
      }

      return instance;
    } finally {
      this.resolutionStack.delete(token.symbol);
    }
  }

  getDescriptor<T>(token: ServiceToken<T>): ServiceDescriptor<T> | undefined {
    return this.registry.get(token.symbol) as ServiceDescriptor<T> | undefined;
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("[Container] 容器已销毁，不能再进行操作。");
    }
  }

  protected log(message: string): void {
    if (this.options.enableLogging) {
      this.options.logFn(`[Container] ${message}`);
    }
  }
}

export class ScopedContainer implements ServiceResolver {
  private readonly scopedInstances = new Map<symbol, any>();
  private readonly resolutionStack: Set<symbol> = new Set();
  private disposed = false;
  private readonly options: Required<ContainerOptions>;

  constructor(
    private readonly parent: Container,
    options: Required<ContainerOptions>,
  ) {
    this.options = options;
  }

  resolve<T>(token: ServiceToken<T>): T {
    this.ensureNotDisposed();

    const descriptor = this.parent.getDescriptor(token);

    if (!descriptor) {
      throw new Error(`[ScopedContainer] 服务 "${token.description}" 未注册。`);
    }

    const { lifecycle, factory } = descriptor;

    if (lifecycle === Lifecycle.Singleton) {
      return this.parent.resolve(token);
    }

    if (lifecycle === Lifecycle.Scoped) {
      if (this.scopedInstances.has(token.symbol)) {
        return this.scopedInstances.get(token.symbol) as T;
      }
    }

    if (this.resolutionStack.has(token.symbol)) {
      throw new Error(
        `[ScopedContainer] 检测到循环依赖，涉及服务: ${token.description}`
      );
    }

    if (this.resolutionStack.size >= this.options.maxResolutionDepth) {
      throw new Error(
        `[ScopedContainer] 解析深度超过 ${this.options.maxResolutionDepth}。`
      );
    }

    this.resolutionStack.add(token.symbol);
    try {
      const instance = factory(this);

      if (lifecycle === Lifecycle.Scoped) {
        this.scopedInstances.set(token.symbol, instance);
      }

      return instance;
    } finally {
      this.resolutionStack.delete(token.symbol);
    }
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.parent.has(token);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;

    for (const instance of this.scopedInstances.values()) {
      if (isDisposable(instance)) {
        try {
          await instance.dispose();
        } catch (err) {
          if (this.options.enableLogging) {
            this.options.logFn(`[ScopedContainer] 释放资源时出错: ${err}`);
          }
        }
      }
    }

    this.scopedInstances.clear();
    this.disposed = true;
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("[ScopedContainer] 容器已销毁，不能再进行操作。");
    }
  }
}
