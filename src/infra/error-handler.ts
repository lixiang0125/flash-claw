
let errorIdCounter = 0;

function generateErrorId(): string {
  errorIdCounter = (errorIdCounter + 1) % 10000;
  return `${Date.now()}-${errorIdCounter.toString().padStart(4, "0")}`;
}

export interface ErrorContext {
  sessionId?: string;
  userId?: string;
  operation?: string;
}

export class ErrorSanitizer {
  private static internalErrors = new Set<string>([
    "ENOENT",
    "EACCES",
    "EPERM",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "VALIDATION_ERROR",
  ]);

  static sanitize(error: unknown, context?: ErrorContext): string {
    const errorId = generateErrorId();

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error(`[Error:${errorId}]`, {
      message: errorMessage,
      stack: errorStack,
      context,
    });

    return `抱歉，处理您的请求时遇到了问题（错误编号: ${errorId}）。请稍后重试。`;
  }

  static isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes("timeout") ||
        message.includes("econnrefused") ||
        message.includes("etimedout") ||
        message.includes("network")
      );
    }
    return false;
  }

  static getErrorCode(error: unknown): string {
    if (error instanceof Error) {
      if (error.message.includes("ENOENT")) return "FILE_NOT_FOUND";
      if (error.message.includes("EACCES")) return "PERMISSION_DENIED";
      if (error.message.includes("VALIDATION")) return "VALIDATION_ERROR";
      if (error.message.includes("timeout")) return "TIMEOUT";
      if (error.message.includes("network")) return "NETWORK_ERROR";
    }
    return "INTERNAL_ERROR";
  }
}
