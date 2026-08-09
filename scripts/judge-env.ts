/**
 * Judge provider environment loader — self-healing gateway configuration for
 * offline judge/audit scripts (V14/V14R tooling; NOT production code).
 *
 * Why: the homelab production .env has OPENAI_API_KEY= (empty) and
 * DEEPSEEK_BASE_URL=http://host.docker.internal:20128/v1 (reachable only
 * inside Docker). Judge calls made with --env-file therefore failed with
 * 401/no-key or connection errors. This loader fixes process.env BEFORE any
 * provider call:
 *
 *  1. keys: OPENAI_API_KEY empty  -> reuse DEEPSEEK_API_KEY (9router gateway
 *     key); OPENAI_API_KEY still empty -> OPENROUTER_API_KEY.
 *  2. base URLs: for each provider (openai/deepseek/openrouter) pick a base
 *     URL that actually answers /models (probe, 2s timeout), preferring the
 *     127.0.0.1 local gateway; never prints secret values.
 *  3. verify: one lightweight completion call (optional --probe mode or
 *     ensureJudgeEnv({ verify: true })).
 */
import fs from 'node:fs';

const PROBE_TIMEOUT_MS = 10_000;

export interface JudgeEnvResult {
  openai_base_url: string;
  openai_key_set: boolean;
  deepseek_base_url: string;
  openrouter_base_url: string;
  gateway: string;
  warnings: string[];
  model_status?: Record<string, { ok: boolean; detail: string }>;
}

/** Probe a concrete model route; returns {ok, detail} — never throws. */
export async function modelAvailable(base: string, apiKey: string, model: string, timeoutMs = 45_000): Promise<{ ok: boolean; detail: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true, detail: 'reachable' };
    const text = (await res.text()).slice(0, 200);
    if (text.includes('429') || /RATE_LIMITED|rate.limit/i.test(text)) {
      return { ok: false, detail: 'RATE_LIMITED (429) — retry after upstream quota reset' };
    }
    if (/no active credentials/i.test(text)) {
      return { ok: false, detail: 'NO_CREDENTIALS — provider route disabled upstream' };
    }
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 120)}` };
  } catch (error) {
    return { ok: false, detail: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Probe every judge tier's effective model; returns { tier: {ok, detail} }. */
export async function checkJudgeModels(base: string, apiKey: string, models: Record<string, string>): Promise<Record<string, { ok: boolean; detail: string }>> {
  const out: Record<string, { ok: boolean; detail: string }> = {};
  for (const [tier, model] of Object.entries(models)) {
    out[tier] = await modelAvailable(base, apiKey, model);
  }
  return out;
}

export function loadEnvFile(envFile: string): void {
  if (!fs.existsSync(envFile)) return;
  const raw = fs.readFileSync(envFile, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

/** Pick the first reachable gateway base URL from candidates (probe /models). */
export async function reachableBase(candidates: string[], apiKey: string): Promise<string | null> {
  for (const base of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(`${base.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return base;
    } catch {
      // unreachable candidate -> try next
    }
  }
  return null;
}

/** Deterministic resolution for tests: given reachable set, which base wins? */
export function preferGateway(bases: string[], reachable: (b: string) => boolean): string | null {
  const ordered = [
    'http://127.0.0.1:20128/v1',
    'http://localhost:20128/v1',
  ];
  for (const b of [...ordered, ...bases.filter((x) => !ordered.includes(x))]) {
    if (reachable(b)) return b;
  }
  return null;
}

export async function resolveBases(apiKey: string, fromEnv: {
  openai?: string;
  deepseek?: string;
  openrouter?: string;
}): Promise<{
  openai: string | null;
  deepseek: string | null;
  openrouter: string | null;
}> {
  const candidates = ['http://127.0.0.1:20128/v1', 'http://localhost:20128/v1'];
  for (const b of [fromEnv.openai, fromEnv.deepseek, fromEnv.openrouter]) {
    if (b && !candidates.includes(b)) candidates.push(b);
  }
  const live = await reachableBase(candidates, apiKey);
  return {
    openai: live ?? fromEnv.openai ?? null,
    deepseek: live ?? fromEnv.deepseek ?? null,
    openrouter: live ?? fromEnv.openrouter ?? null,
  };
}

/** Effective judge models (mirrors src/lib/v12r/judge-runner.ts defaults,
 *  honoring V12R_JUDGE_<TIER>_MODEL overrides). */
export function judgeModelFor(tier: 'A' | 'B' | 'C'): string {
  const env = process.env[`V12R_JUDGE_${tier}_MODEL`]?.trim();
  if (env) return env;
  return { A: 'ds/deepseek-v4-flash', B: 'tr/moonshotai/kimi-k3-free', C: 'cx/gpt-5.6-luna' }[tier];
}

/** Idempotent judge-environment bootstrap. Call once at script entry. */
export async function ensureJudgeEnv(opts?: { envFile?: string; probe?: boolean; checkModels?: boolean }): Promise<JudgeEnvResult> {
  const warnings: string[] = [];
  const envFile = opts?.envFile ?? process.env.JUDGE_ENV_FILE ?? '';
  if (envFile) loadEnvFile(envFile);

  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? '';
  const openrouterKey = process.env.OPENROUTER_API_KEY ?? '';
  let openaiKey = process.env.OPENAI_API_KEY ?? '';
  if (!openaiKey && deepseekKey) openaiKey = deepseekKey;
  if (!openaiKey && openrouterKey) openaiKey = openrouterKey;
  if (!openaiKey) warnings.push('no gateway API key found (OPENAI/DEEPSEEK/OPENROUTER)');

  const keyForProbe = openaiKey || deepseekKey || openrouterKey;
  const bases = await resolveBases(keyForProbe, {
    openai: process.env.OPENAI_BASE_URL?.trim() || undefined,
    deepseek: process.env.DEEPSEEK_BASE_URL?.trim() || undefined,
    openrouter: process.env.OPENROUTER_BASE_URL?.trim() || undefined,
  });

  if (!bases.openai) warnings.push('no reachable gateway for openai channel');
  else process.env.OPENAI_BASE_URL = bases.openai;
  if (!bases.deepseek) warnings.push('no reachable gateway for deepseek channel');
  else process.env.DEEPSEEK_BASE_URL = bases.deepseek;
  if (!bases.openrouter) warnings.push('no reachable gateway for openrouter channel');
  else process.env.OPENROUTER_BASE_URL = bases.openrouter;

  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;

  let modelStatus: Record<string, { ok: boolean; detail: string }> | undefined;
  if (opts?.checkModels === true && bases.openai && openaiKey) {
    modelStatus = await checkJudgeModels(bases.openai, openaiKey, {
      A: judgeModelFor('A'),
      B: judgeModelFor('B'),
      C: judgeModelFor('C'),
    });
    for (const [tier, st] of Object.entries(modelStatus)) {
      if (!st.ok) warnings.push(`tier ${tier} model unavailable: ${st.detail}`);
    }
  }

  if (opts?.probe === true && bases.openai) {
    await probeCompletion(bases.openai, openaiKey);
  }

  return {
    openai_base_url: bases.openai ?? '',
    openai_key_set: Boolean(openaiKey),
    deepseek_base_url: bases.deepseek ?? '',
    openrouter_base_url: bases.openrouter ?? '',
    gateway: bases.openai ?? '',
    warnings,
    model_status: modelStatus,
  };
}

export async function probeCompletion(base: string, apiKey: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const model = (process.env.DEEPSEEK_MODEL ?? 'deepseek/deepseek-v4-flash').trim();
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
      temperature: 0,
    }),
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (!res.ok) {
    throw new Error(`JUDGE_PROBE_FAILED: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  console.log(`judge probe OK: ${base} (model ${model})`);
}

// CLI mode: node --import tsx scripts/judge-env.ts [--env-file ...] [--probe] [--check-models]
if (require.main === module) {
  const i = process.argv.indexOf('--env-file');
  const envFile = i >= 0 ? process.argv[i + 1] : process.env.JUDGE_ENV_FILE ?? '';
  const probe = process.argv.includes('--probe');
  const checkModels = process.argv.includes('--check-models');
  void ensureJudgeEnv({ envFile, probe, checkModels }).then((r) => {
    console.log(JSON.stringify({ openai_base_url: r.openai_base_url, openai_key_set: r.openai_key_set, gateway: r.gateway, model_status: r.model_status, warnings: r.warnings }, null, 1));
    if (!r.openai_key_set || r.warnings.length > 0) process.exitCode = 1;
  });
}