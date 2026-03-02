export enum Lifecycle {
  Singleton = "singleton",
  Transient = "transient",
  Scoped = "scoped",
}

export interface ServiceToken<T> {
  readonly symbol: symbol;
  readonly description: string;
  readonly _type?: T;
}

export function createToken<T>(description: string): ServiceToken<T> {
  return {
    symbol: Symbol(description),
    description,
  };
}

export interface ServiceResolver {
  resolve<T>(token: ServiceToken<T>): T;
}

export type ServiceFactory<T> = (resolver: ServiceResolver) => T;

export interface ServiceDescriptor<T> {
  readonly token: ServiceToken<T>;
  readonly lifecycle: Lifecycle;
  readonly factory: ServiceFactory<T>;
  instance?: T;
  initialized: boolean;
}

export interface Disposable {
  dispose(): Promise<void> | void;
}

export function isDisposable(obj: unknown): obj is Disposable {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "dispose" in obj &&
    typeof (obj as Disposable).dispose === "function"
  );
}

export interface AsyncInitializable {
  initialize(): Promise<void>;
}

export function isAsyncInitializable(obj: unknown): obj is AsyncInitializable {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "initialize" in obj &&
    typeof (obj as AsyncInitializable).initialize === "function"
  );
}

export interface ContainerOptions {
  enableLogging?: boolean;
  maxResolutionDepth?: number;
  logFn?: (message: string) => void;
}

export interface RegisterOptions<T> {
  token: ServiceToken<T>;
  lifecycle?: Lifecycle;
  factory: ServiceFactory<T>;
}
