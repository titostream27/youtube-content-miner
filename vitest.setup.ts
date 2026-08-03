import { beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Test setup: isolate the SQLite DB so unit tests never touch production
 * data. A fresh temp DB is created per test run.
 */
let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycm-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
});

afterAll(() => {
  delete process.env.DATABASE_PATH;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // DB handle may still hold the file on Windows; temp dir cleanup is
      // best-effort (OS will reap it).
    }
  }
});
