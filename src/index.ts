import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { bootstrap, HTTP_SERVER, CONFIG, LOGGER } from "./core/container/bootstrap";
import { serve } from "bun";

/* ── 全局异常兜底，防止进程意外退出 ── */
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

async function main() {
  console.log("[Bootstrap] Starting FlashClaw with DI container...");
  
  const container = await bootstrap();
  
  const config = container.resolve(CONFIG);
  const logger = container.resolve(LOGGER);
  const httpServer = container.resolve(HTTP_SERVER);
  
  logger.info("FlashClaw started successfully", { 
    port: config.port,
    env: config.env,
    services: container.getRegisteredServices().length,
  });
  
  console.log(`[Bootstrap] Registered services: ${container.getRegisteredServices().join(", ")}`);
  
  serve({
    port: config.port,
    fetch: httpServer.fetch as (req: Request) => Promise<Response>,
  });
  
  console.log(`[Bootstrap] Server listening on port ${config.port}`);
}

main().catch((err) => {
  console.error("[FATAL] main() crashed:", err);
  process.exit(1);
});
