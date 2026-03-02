declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

declare module "sqlite-vec" {
  export function load(db: unknown): void;
}
