/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Database as BunDatabase, Statement } from "bun:sqlite";

export interface DatabaseService {
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export function createDatabaseAdapter(db: BunDatabase): DatabaseService {
  return {
    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number } {
      const stmt = db.prepare(sql);
      const result = params 
        ? (stmt.run as any)(...params)
        : stmt.run();
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
      const stmt = db.prepare(sql);
      const result = params 
        ? (stmt.get as any)(...params)
        : stmt.get();
      return result as T | undefined;
    },
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      const result = params 
        ? (stmt.all as any)(...params)
        : stmt.all();
      return result as T[];
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}
