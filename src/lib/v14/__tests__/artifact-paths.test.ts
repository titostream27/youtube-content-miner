/**
 * Brief V14R — portability tests for canonical artifact paths (V14R-PATH-001..004,
 * case sensitivity, traversal, missing/empty/malformed inputs).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUN_VARIANTS,
  V14_RUN_DIR,
  loadJsonlStrict,
  loadJsonStrict,
  requiredFile,
  requiredRunFile,
  runDirFor,
} from '../artifact-paths';

function tempDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v14r-path-'));
  // Create the directory with a DIFFERENT case on disk than the requested
  // canonical path to simulate a case-sensitive FS (Linux) behavior.
  const dir = path.join(base, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const v of ['c0', 'E1', 'E2', 'E3', 'E4', 'S1', 'S2', 'NEGATIVE_CONTROL']) {
    fs.mkdirSync(path.join(dir, v, v === 'c0' ? 'C0' : v), { recursive: true });
  }
  return base;
}

describe('V14R-PATH-001 — canonical E3 path resolves exactly on any FS', () => {
  it('runDirFor(E3) === E3 (never guessed casing)', () => {
    expect(V14_RUN_DIR.E3).toBe('E3');
    expect(runDirFor('E3')).toBe('E3');
    expect(runDirFor('C0')).toBe('c0');
  });
  it('requiredRunFile resolves and reads an existing file under canonical dir', () => {
    const base = tempDir();
    const target = path.join(base, 'runs', 'E3', 'E3', 'marker.txt');
    fs.writeFileSync(target, 'x', 'utf-8');
    const p = requiredRunFile(path.join(base, 'runs'), 'E3', 'marker.txt');
    expect(fs.existsSync(p)).toBe(true);
    // On a case-sensitive FS the lower-case path would NOT exist.
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      expect(fs.existsSync(path.join(base, 'runs', 'e3', 'E3', 'marker.txt'))).toBe(false);
    }
  });
});

describe('V14R-PATH-002 — lower-case variant ids never silently resolve', () => {
  it('invalid variant id is rejected before touching the FS', () => {
    expect(() => requiredRunFile('.', 'e3' as 'E3', 'variant_results.jsonl')).toThrow(/INVALID_VARIANT_ID/);
  });
  it('the full canonical map covers every run variant', () => {
    expect(Object.keys(V14_RUN_DIR).sort()).toEqual([...RUN_VARIANTS].sort());
  });
});

describe('V14R-PATH-003 — missing required artifacts fail closed', () => {
  it('missing file throws MISSING_REQUIRED_ARTIFACT', () => {
    const base = tempDir();
    expect(() => requiredFile(path.join(base, 'runs', 'E3', 'E3', 'nope.json'))).toThrow(/MISSING_REQUIRED_ARTIFACT/);
  });
  it('missing run file throws through requiredRunFile', () => {
    const base = tempDir();
    expect(() => requiredRunFile(path.join(base, 'runs'), 'E3', 'variant_results.jsonl')).toThrow(/MISSING_REQUIRED_ARTIFACT/);
  });
});

describe('V14R-PATH-004 — empty/malformed JSONL and JSON fail closed', () => {
  it('empty JSONL file throws EMPTY_JSONL', () => {
    const base = tempDir();
    const p = path.join(base, 'runs', 'E3', 'E3', 'empty.jsonl');
    fs.writeFileSync(p, '', 'utf-8');
    expect(() => loadJsonlStrict(p)).toThrow(/EMPTY_JSONL/);
    const p2 = path.join(base, 'runs', 'E3', 'E3', 'blank.jsonl');
    fs.writeFileSync(p2, '\n\n\n', 'utf-8');
    expect(() => loadJsonlStrict(p2)).toThrow(/EMPTY_JSONL/);
  });
  it('malformed JSONL line throws MALFORMED_JSONL', () => {
    const base = tempDir();
    const p = path.join(base, 'runs', 'E3', 'E3', 'bad.jsonl');
    fs.writeFileSync(p, '{"a":1}\nNOT_JSON\n', 'utf-8');
    expect(() => loadJsonlStrict(p)).toThrow(/MALFORMED_JSONL/);
  });
  it('empty JSON document throws EMPTY_JSON / malformed throws MALFORMED_JSON', () => {
    const base = tempDir();
    const p = path.join(base, 'runs', 'E3', 'E3', 'doc.json');
    fs.writeFileSync(p, '   ', 'utf-8');
    expect(() => loadJsonStrict(p)).toThrow(/EMPTY_JSON/);
    fs.writeFileSync(p, '{"a":', 'utf-8');
    expect(() => loadJsonStrict(p)).toThrow(/MALFORMED_JSON/);
  });
});

describe('V14R-PATH-005 — path traversal outside base is rejected', () => {
  it('requiredFile with base refuses paths escaping the base', () => {
    const base = tempDir();
    const outside = path.join(base, '..', 'escape.txt');
    fs.writeFileSync(outside, 'x', 'utf-8');
    expect(() => requiredFile(outside, base)).toThrow(/PATH_ESCAPES_REPO|MISSING_REQUIRED_ARTIFACT/);
  });
});