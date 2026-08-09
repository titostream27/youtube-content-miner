/**
 * Brief V14R — canonical artifact paths + fail-closed loaders (R-01, R-04).
 *
 * One centralized variant-to-directory map used by every V14/V14R script and
 * test. No toLowerCase(), no guessed casing, no empty-array fallback: missing,
 * empty, malformed or case-mismatched required inputs terminate with a thrown
 * error (callers exit non-zero).
 */
import fs from 'node:fs';
import path from 'node:path';

export type RunVariantId = 'C0' | 'E1' | 'E2' | 'E3' | 'E4' | 'S1' | 'S2' | 'NEGATIVE_CONTROL';

export const RUN_VARIANTS: readonly RunVariantId[] = [
  'C0', 'E1', 'E2', 'E3', 'E4', 'S1', 'S2', 'NEGATIVE_CONTROL',
] as const;

/** Canonical committed directory names (case matters; do not lowercase). */
export const V14_RUN_DIR: Record<RunVariantId, string> = {
  C0: 'c0',
  E1: 'E1',
  E2: 'E2',
  E3: 'E3',
  E4: 'E4',
  S1: 'S1',
  S2: 'S2',
  NEGATIVE_CONTROL: 'NEGATIVE_CONTROL',
};

/** Files every run directory must contain. */
export const REQUIRED_RUN_FILES = [
  'run_summary.json',
  'variant_results.jsonl',
  'stage_trace.jsonl',
  'first_death.csv',
  'score_contributions.csv',
  'metrics.json',
] as const;

export function isRunVariantId(v: string): v is RunVariantId {
  return (RUN_VARIANTS as readonly string[]).includes(v);
}

export function runDirFor(variant: RunVariantId): string {
  return V14_RUN_DIR[variant];
}

/** Path to <base>/<canonicalDir(variant)>/<variant>/<file>; throws when absent. */
export function requiredRunFile(base: string, variant: RunVariantId, file: string): string {
  if (!isRunVariantId(variant)) {
    throw new Error(`INVALID_VARIANT_ID: ${String(variant)} (must be one of ${RUN_VARIANTS.join(',')})`);
  }
  const p = path.join(base, runDirFor(variant), variant, file);
  return requiredFile(p);
}

/** Assert a file exists, is a regular file, and stays inside the base dir. */
export function requiredFile(p: string, base?: string): string {
  const abs = path.resolve(p);
  if (base !== undefined) {
    const baseAbs = path.resolve(base);
    const rel = path.relative(baseAbs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`PATH_ESCAPES_REPO: ${abs}`);
    }
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`MISSING_REQUIRED_ARTIFACT: ${abs}`);
  }
  const st = fs.statSync(abs);
  if (!st.isFile()) {
    throw new Error(`NOT_A_REGULAR_FILE: ${abs}`);
  }
  return abs;
}

/** Load a JSONL file; throws on missing, empty, or malformed lines. */
export function loadJsonlStrict(p: string): Record<string, unknown>[] {
  const abs = requiredFile(p);
  const raw = fs.readFileSync(abs, 'utf-8');
  if (raw.trim().length === 0) {
    throw new Error(`EMPTY_JSONL: ${abs}`);
  }
  const rows: Record<string, unknown>[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`ROW_NOT_OBJECT:${i + 1}`);
      }
      rows.push(parsed);
    } catch (error) {
      throw new Error(`MALFORMED_JSONL:${abs}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rows.length === 0) {
    throw new Error(`EMPTY_JSONL: ${abs}`);
  }
  return rows;
}

/** Load a JSON document; throws on missing or malformed content. */
export function loadJsonStrict(p: string): Record<string, unknown> {
  const abs = requiredFile(p);
  const raw = fs.readFileSync(abs, 'utf-8');
  if (raw.trim().length === 0) {
    throw new Error(`EMPTY_JSON: ${abs}`);
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ROOT_NOT_OBJECT');
    }
    return parsed;
  } catch (error) {
    throw new Error(`MALFORMED_JSON:${abs}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Optional file: returns the resolved path or null (never throws). */
export function optionalFile(p: string): string | null {
  return fs.existsSync(p) && fs.statSync(p).isFile() ? path.resolve(p) : null;
}

/** Assert every candidate_id in a set of outcome rows is unique. */
export function assertUniqueCandidateIds(rows: { candidate_id?: unknown }[], scope: string): void {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const r of rows) {
    const id = r.candidate_id as string | undefined;
    if (id === undefined || id === '') {
      throw new Error(`MISSING_CANDIDATE_ID in ${scope}`);
    }
    if (seen.has(id)) dups.push(id);
    seen.add(id);
  }
  if (dups.length > 0) {
    throw new Error(`DUPLICATE_CANDIDATE_IDS in ${scope}: ${dups.join(',')}`);
  }
}