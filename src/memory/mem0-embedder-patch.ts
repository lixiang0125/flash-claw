import OpenAI from "openai";

export function patchEmbedderBaseURL(
  memoryInstance: unknown,
  baseURL: string,
  apiKey: string,
): void {
  const embedder = (memoryInstance as { embedder?: { openai?: unknown } }).embedder;
  if (!embedder) {
    throw new Error("mem0 Memory instance does not have an embedder property");
  }

  if ("openai" in embedder) {
    (embedder as { openai: OpenAI }).openai = new OpenAI({ apiKey, baseURL });
  } else {
    console.warn(
      "[mem0-patch] embedder 没有 openai 属性，可能已使用非 OpenAI provider，跳过 patch",
    );
  }
}
