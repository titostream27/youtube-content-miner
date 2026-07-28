/**
 * Create the database file and apply the schema.
 *
 * Not strictly required - `getDb()` applies the schema on first connection - but
 * useful in deployment scripts and for confirming the file path and permissions
 * before starting the server.
 */
import { getDb } from '../src/lib/db/client';

const db = getDb();

const tables = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
  .all() as { name: string }[];

console.log(`Database ready at ${process.env.DATABASE_PATH ?? 'data/content-miner.db'}`);
console.log(`Tables (${tables.length}): ${tables.map((table) => table.name).join(', ')}`);
