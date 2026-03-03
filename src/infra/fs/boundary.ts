import { resolve, relative, isAbsolute } from "path";
import { realpathSync, lstatSync, existsSync } from "fs";

const ALLOWED_ROOTS = [
  resolve(process.cwd(), ".flashclaw"),
  resolve(process.cwd(), "skills"),
  resolve(process.cwd(), "data"),
];

const SENSITIVE_PATTERNS = [/\.env$/, /\.git/, /node_modules/, /package\.json$/];

export function validateReadPath(targetPath: string): string {
  const absPath = resolve(process.cwd(), targetPath);
  validatePath(absPath, false);
  return absPath;
}

export function validateWritePath(targetPath: string): string {
  const absPath = resolve(process.cwd(), targetPath);
  validatePath(absPath, true);
  return absPath;
}

function validatePath(absPath: string, isWrite: boolean): void {
  const isAllowed = ALLOWED_ROOTS.some((root) => {
    const rel = relative(root, absPath);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });

  if (!isAllowed) {
    throw new Error(`Path outside allowed boundaries: ${absPath}`);
  }

  try {
    const realPath = realpathSync(absPath);
    const isRealAllowed = ALLOWED_ROOTS.some((root) => {
      const rel = relative(root, realPath);
      return !rel.startsWith("..") && !isAbsolute(rel);
    });
    if (!isRealAllowed) {
      throw new Error(`Symlink traversal detected: ${absPath} -> ${realPath}`);
    }
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
      throw e;
    }
  }

  if (SENSITIVE_PATTERNS.some((p) => p.test(absPath))) {
    throw new Error(`Cannot access sensitive path: ${absPath}`);
  }
}

export function checkPathInBounds(targetPath: string): boolean {
  try {
    const absPath = resolve(process.cwd(), targetPath);
    const isAllowed = ALLOWED_ROOTS.some((root) => {
      const rel = relative(root, absPath);
      return !rel.startsWith("..") && !isAbsolute(rel);
    });
    return isAllowed;
  } catch {
    return false;
  }
}
