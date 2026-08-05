import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RenderRequestV2Schema } from '@/lib/render/contract';

const CONTRACTS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'contracts');
const VALID_DIR = join(CONTRACTS_DIR, 'fixtures', 'valid');
const INVALID_DIR = join(CONTRACTS_DIR, 'fixtures', 'invalid');

function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

describe('shared contract fixtures — TypeScript parity (Phase 1 §5.7.10)', () => {
  it('has fixtures available', () => {
    const valid = jsonFiles(VALID_DIR).filter((f) => f.includes('v2'));
    const invalid = jsonFiles(INVALID_DIR);
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it('accepts every valid v2 fixture', () => {
    for (const f of jsonFiles(VALID_DIR).filter((x) => x.includes('v2'))) {
      const payload = JSON.parse(readFileSync(join(VALID_DIR, f), 'utf-8'));
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be valid`).not.toThrow();
    }
  });

  it('rejects every invalid fixture', () => {
    for (const f of jsonFiles(INVALID_DIR)) {
      const payload = JSON.parse(readFileSync(join(INVALID_DIR, f), 'utf-8'));
      expect(() => RenderRequestV2Schema.parse(payload), `${f} should be invalid`).toThrow();
    }
  });
});
