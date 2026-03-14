import OpenAI from "openai";

/**
 * Monkey-patch the mem0 Memory instance's embedder to use a custom baseURL.
 *
 * Background: As of mem0ai v2.3.0, `OpenAIEmbedder` constructs its internal
 * OpenAI client with only `{ apiKey }`, ignoring any `url` / `baseURL` in the
 * EmbeddingConfig. This means embeddings always hit api.openai.com, which
 * fails when using OpenAI-compatible providers (DashScope, vLLM, etc.).
 *
 * This patch replaces the embedder's internal OpenAI client after construction
 * so that it points to the desired endpoint.
 *
 * @param memoryInstance - The mem0 `Memory` object (its `embedder` field is
 *   private in TS but accessible at runtime).
 * @param baseURL - The custom OpenAI-compatible API base URL.
 * @param apiKey  - The API key for the custom endpoint.
 */
export function patchEmbedderBaseURL(
  memoryInstance: unknown,
  baseURL: string,
  apiKey: string,
): void {
  // Access the private `embedder` property via runtime type assertion.
  const mem = memoryInstance as {
    embedder?: { openai?: OpenAI };
  };

  const embedder = mem.embedder;
  if (!embedder) {
    throw new Error(
      "[mem0-patch] Memory instance does not have an embedder property. " +
      "The mem0ai internal structure may have changed.",
    );
  }

  if ("openai" in embedder && embedder.openai instanceof OpenAI) {
    // Check if the current baseURL already matches (idempotent patch).
    const currentBase = (embedder.openai as unknown as { baseURL?: string }).baseURL;
    if (currentBase === baseURL) {
      return; // Already patched or already correct.
    }

    embedder.openai = new OpenAI({ apiKey, baseURL });
  } else if ("openai" in embedder) {
    // The property exists but isn't an OpenAI instance (possibly a different
    // version). Replace it anyway since the interface is compatible.
    (embedder as Record<string, unknown>).openai = new OpenAI({ apiKey, baseURL });
  } else {
    console.warn(
      "[mem0-patch] embedder has no 'openai' property — " +
      "it may be using a non-OpenAI provider. Skipping baseURL patch.",
    );
  }
}
