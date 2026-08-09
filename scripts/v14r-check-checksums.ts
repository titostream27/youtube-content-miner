/**
 * Brief V14R — Node-based checksum verifier (Windows equivalent of
 * `sha256sum -c`). Validates evidence/v14r/SHA256SUMS with LF-normalized
 * hashing so Linux (GNU sha256sum on git-checked-out LF files) and Windows
 * produce identical results. Exit non-zero on any mismatch/missing/dup/escape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function findRoot(start: string): string {
  let d = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'evidence'))) return d;
    d = path.dirname(d);
  }
  throw new Error('ROOT_NOT_FOUND');
}

const ROOT = findRoot(__dirname);
const MANIFEST = path.join(ROOT, 'evidence', 'v14r', 'SHA256SUMS');

function lfHash(p: string): string {
  const raw = fs.readFileSync(p).toString('utf-8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(raw, 'utf-8').digest('hex');
}

function main(): void {
  if (!fs.existsSync(MANIFEST)) {
    console.error('FAIL: manifest missing');
    process.exit(1);
  }
  const entries: { hash: string; rel: string }[] = [];
  for (const line of fs.readFileSync(MANIFEST, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([0-9a-f]{64})  (.+)$/.exec(t);
    if (m) entries.push({ hash: m[1]!, rel: m[2]! });
  }
  const seen = new Set<string>();
  const problems: string[] = [];
  let ok = 0;
  for (const e of entries) {
    if (seen.has(e.rel)) problems.push(`duplicate:${e.rel}`);
    seen.add(e.rel);
    const abs = path.join(ROOT, ...e.rel.split('/'));
    if (!abs.startsWith(ROOT + path.sep)) {
      problems.push(`escape:${e.rel}`);
      continue;
    }
    if (!fs.existsSync(abs)) {
      problems.push(`missing:${e.rel}`);
      continue;
    }
    if (lfHash(abs) !== e.hash) {
      problems.push(`hash-mismatch:${e.rel}`);
    } else {
      ok += 1;
    }
  }
  if (problems.length === 0) {
    console.log(`checksums OK: ${ok}/${entries.length} entries verified (LF-normalized)`);
  } else {
    console.error(`checksums FAIL: ${ok}/${entries.length} ok; problems: ${problems.slice(0, 10).join(' ')}`);
    process.exitCode = 1;
  }
}

main();