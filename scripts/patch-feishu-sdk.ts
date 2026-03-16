/**
 * Patch for @larksuiteoapi/node-sdk pullConnectConfig error handling.
 *
 * The SDK's pullConnectConfig() only returns false for error codes 1 (system_busy)
 * and 1000040343 (internal_error). For any other non-zero/non-success code
 * (e.g. 1000040345), execution falls through and tries to access
 * ClientConfig.PingInterval on an undefined object, causing a crash:
 *   "undefined is not an object (evaluating 'ClientConfig.PingInterval')"
 *
 * This patch makes ANY non-zero code return false, preventing the crash.
 * The patch is idempotent — safe to run multiple times.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const SDK_PATH = resolve(
  import.meta.dir,
  "..",
  "node_modules",
  "@larksuiteoapi",
  "node-sdk",
  "lib",
  "index.js"
);

const PATCH_MARKER = "// [flash-claw-patch] return false for all non-zero codes";

function main() {
  if (!existsSync(SDK_PATH)) {
    console.log("[patch-feishu-sdk] SDK file not found — skipping (not yet installed?).");
    process.exit(0);
  }

  let source = readFileSync(SDK_PATH, "utf-8");

  // Idempotent check — already patched?
  if (source.includes(PATCH_MARKER)) {
    console.log("[patch-feishu-sdk] Already patched — skipping.");
    process.exit(0);
  }

  // Find the pattern:
  //   if (code === ErrorCode.system_busy || code === ErrorCode.internal_error) {
  //       return false;
  //   }
  //
  // Replace with:
  //   if (code === ErrorCode.system_busy || code === ErrorCode.internal_error) {
  //       return false;
  //   }
  //   // [flash-claw-patch] return false for all non-zero codes
  //   return false;

  const needle =
    "if (code === ErrorCode.system_busy || code === ErrorCode.internal_error) {\n                        return false;\n                    }";

  if (!source.includes(needle)) {
    console.error(
      "[patch-feishu-sdk] Could not find expected code pattern in SDK. " +
        "The SDK version may have changed. Manual patching required."
    );
    process.exit(1);
  }

  const replacement =
    needle +
    "\n                    " +
    PATCH_MARKER +
    "\n                    return false;";

  source = source.replace(needle, replacement);

  writeFileSync(SDK_PATH, source, "utf-8");
  console.log("[patch-feishu-sdk] Patched pullConnectConfig() — all non-zero codes now return false.");
}

main();
