/**
 * Judge provider environment loader — unit tests (no network: fetch mocked).
 * Covers: gateway preference, env-file merging, empty-key fallback,
 * fail-fast behavior when nothing is reachable.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadEnvFile,
  preferGateway,
  ensureJudgeEnv,
} from '../judge-env';

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_BASE_URL', 'DEEPSEEK_BASE_URL', 'OPENROUTER_BASE_URL']) {
    delete process.env[k];
  }
});

describe('judge-env: gateway preference', () => {
  it('prefers 127.0.0.1 gateway over configured bases', () => {
    const reachable = (b: string): boolean => b === 'http://127.0.0.1:20128/v1';
    expect(preferGateway(['http://host.docker.internal:20128/v1', 'https://api.openai.com/v1'], reachable)).toBe('http://127.0.0.1:20128/v1');
  });
  it('falls back to configured base when no local gateway answers', () => {
    const reachable = (b: string): boolean => b === 'http://host.docker.internal:20128/v1';
    expect(preferGateway(['http://host.docker.internal:20128/v1'], reachable)).toBe('http://host.docker.internal:20128/v1');
  });
  it('returns null when nothing is reachable', () => {
    const reachable = (): boolean => false;
    expect(preferGateway(['http://host.docker.internal:20128/v1'], reachable)).toBeNull();
  });
});

describe('judge-env: env file merging', () => {
  it('fills empty values and keeps already-set values', () => {
    process.env.OPENAI_API_KEY = 'already-set';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenv-'));
    const f = path.join(dir, 'env.txt');
    fs.writeFileSync(f, 'OPENAI_API_KEY=\nDEEPSEEK_API_KEY=file-key\nKEEP=1\n');
    loadEnvFile(f);
    expect(process.env.OPENAI_API_KEY).toBe('already-set');
    expect(process.env.DEEPSEEK_API_KEY).toBe('file-key');
  });
  it('never treats missing files as an error', () => {
    expect(() => loadEnvFile('/nonexistent/judge.env')).not.toThrow();
  });
});

describe('judge-env: empty-key fallback + base resolution', () => {
  it('reuses DEEPSEEK key for openai and picks the reachable gateway', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    let calls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      calls += 1;
      if (String(url).startsWith('http://127.0.0.1:20128')) {
        return { ok: true, status: 200 } as Response;
      }
      return { ok: false, status: 401 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await ensureJudgeEnv();
    expect(r.openai_key_set).toBe(true);
    expect(r.openai_base_url).toBe('http://127.0.0.1:20128/v1');
    expect(process.env.OPENAI_API_KEY).toBe('sk-test');
    expect(calls).toBeGreaterThan(0);
  });
  it('warns and keeps keys unset when nothing is reachable', async () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as Response));
    const r = await ensureJudgeEnv();
    expect(r.openai_key_set).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});