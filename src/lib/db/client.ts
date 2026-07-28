import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';

/**
 * SQLite connection singleton.
 *
 * Next.js hot-reloads server modules in development, which would otherwise
 * open a new file handle on every edit, so the instance is cached on
 * `globalThis`.
 */

declare global {
  var __ycmDatabase: Database.Database | undefined;
}

/**
 * The `turbopackIgnore` comments matter: the path comes from the environment at
 * runtime, and without them the bundler treats the dynamic `resolve` as a signal
 * to trace the entire project into the server output.
 */
function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();

  if (configured && configured.length > 0) {
    return configured === ':memory:'
      ? configured
      : resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  }

  return resolve(/* turbopackIgnore: true */ process.cwd(), 'data/content-miner.db');
}

function createDatabase(): Database.Database {
  const path = resolveDatabasePath();

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  // WAL keeps dashboard reads fast while a pipeline run is writing.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA_SQL);

  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__ycmDatabase) {
    globalThis.__ycmDatabase = createDatabase();
  }
  return globalThis.__ycmDatabase;
}

/** Run a set of writes atomically. */
export function transaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  return db.transaction(fn)(db);
}

export function closeDb(): void {
  if (globalThis.__ycmDatabase) {
    globalThis.__ycmDatabase.close();
    globalThis.__ycmDatabase = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Serialisation helpers                                                      */
/* -------------------------------------------------------------------------- */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as T | null;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** SQLite has no boolean type. */
export function toSqliteBool(value: boolean | null | undefined): 0 | 1 | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

export function fromSqliteBool(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

export function nowIso(): string {
  return new Date().toISOString();
}
