import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';
import { RenderRequestV2Schema } from '@/lib/render/contract';

const CONTRACTS_DIR = join(__dirname, '..', '..', '..', '..', 'contracts');
const VALID_DIR = join(CONTRACTS_DIR, 'fixtures', 'valid');
const INVALID_DIR = join(CONTRACTS_DIR, 'fixtures', 'invalid');

function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

// Phase-2 F19: neutral JSON Schema expresses STRUCTURAL rules (required,
// types, enums, min/max, additionalProperties:false). Cross-field invariants
// (cue-in-range, end>start, duplicate ids, narrative ordering) reference
// sibling values and are NOT expressible in standard JSON Schema — they are
// enforced by the Zod and Pydantic validators. Parity tests group fixtures
// accordingly so the JSON Schema claim stays honest.
const JSON_SCHEMA_INVALID = [
  'request-v2-empty-clips.json',
  'request-v2-empty-request-id.json',
  'request-v2-invalid-layout.json',
  'request-v2-invalid-mode.json',
  'request-v2-negative-start.json',
  'request-v2-no-video-url.json',
  'request-v2-wrong-version.json',
  'request-v2-zero-output.json',
];
const VALIDATOR_ONLY_INVALID = [
  'request-v2-cue-outside-range.json',
  'request-v2-duplicate-clip-ids.json',
  'request-v2-end-not-after-start.json',
  'request-v2-event-outside-range.json',
  'request-v2-word-outside-cue.json',
];

function loadJsonSchema(): Ajv.ValidateFunction {
  const schema = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'render-request-v2.schema.json'), 'utf-8'));
  return new Ajv({ allErrors: true }).compile(schema);
}

describe('shared contract fixtures — TypeScript parity (Phase 1 §5.7.10)', () => {
  it('has fixtures available', () => {
    const valid = jsonFiles(VALID_DIR).filter((f) => f.includes('v2'));
    const invalid = jsonFiles(INVALID_DIR);
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it('structural fixtures fail JSON Schema AND Zod identically (F19 parity)', () => {
    const schemaValidate = loadJsonSchema();
    for (const f of JSON_SCHEMA_INVALID) {
      const payload = JSON.parse(readFileSync(join(INVALID_DIR, f), 'utf-8'));
      expect(schemaValidate(payload), `${f} should FAIL JSON Schema`).toBe(false);
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be invalid (Zod)`).toThrow();
    }
    for (const f of jsonFiles(VALID_DIR).filter((x) => x.includes('v2') && !x.startsWith('render-result'))) {
      const payload = JSON.parse(readFileSync(join(VALID_DIR, f), 'utf-8'));
      expect(schemaValidate(payload), `${f} should pass JSON Schema`).toBe(true);
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be valid (Zod)`).not.toThrow();
    }
  });

  it('cross-field invariants are enforced by Zod (and Pydantic) validators', () => {
    for (const f of VALIDATOR_ONLY_INVALID) {
      const payload = JSON.parse(readFileSync(join(INVALID_DIR, f), 'utf-8'));
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be invalid (Zod)`).toThrow();
    }
  });

  it('accepts every valid v2 fixture', () => {
    for (const f of jsonFiles(VALID_DIR).filter((x) => x.includes('v2') && !x.startsWith('render-result'))) {
      const payload = JSON.parse(readFileSync(join(VALID_DIR, f), 'utf-8'));
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be valid`).not.toThrow();
    }
  });

  it('rejects every invalid fixture', () => {
    for (const f of jsonFiles(INVALID_DIR).filter((x) => !x.startsWith('render-result'))) {
      const payload = JSON.parse(readFileSync(join(INVALID_DIR, f), 'utf-8'));
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be invalid`).toThrow();
    }
  });
});

// ── Hardening v3 E1 (#26/#29/#30): shared source of truth for RenderResult
// (JSON Schema validates the neutral result fixture; parity enforced in the
// Python side via render_contract RenderResult). Missing fixtures FAIL. ──────
describe('render-result shared fixtures (hardening v3 E1)', () => {
  const RESULT_SCHEMA = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'render-result-v2.schema.json'), 'utf-8'),
  );
  const resultValidate = new Ajv({ allErrors: true }).compile(RESULT_SCHEMA);

  it('accepts the valid render-result fixture', () => {
    const files = jsonFiles(VALID_DIR).filter((f) => f.startsWith('render-result'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const payload = JSON.parse(readFileSync(join(VALID_DIR, f), 'utf-8'));
      const ok = resultValidate(payload);
      expect(ok, `${f} should pass JSON Schema`).toBe(true);
    }
  });

  it('rejects the invalid render-result fixture', () => {
    const files = jsonFiles(INVALID_DIR).filter((f) => f.startsWith('render-result'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const payload = JSON.parse(readFileSync(join(INVALID_DIR, f), 'utf-8'));
      const ok = resultValidate(payload);
      expect(ok, `${f} should FAIL JSON Schema`).toBe(false);
    }
  });
});
