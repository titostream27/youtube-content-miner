#!/usr/bin/env node
/**
 * Brief V11 agent-assisted auto-review (NOT a human review).
 *
 * Scores the top-4 candidate windows per G1 episode on short-suitability
 * criteria using the configured DeepSeek-compatible endpoint. Output rows are
 * explicitly labelled `reviewed_by: "agent-auto"` and MUST NOT be presented as
 * human ground truth. Runtime env (via --env-file content-miner/.env):
 *   DEEPSEEK_BASE_URL  (default http://127.0.0.1:20128)
 *   DEEPSEEK_MODEL     (default ds/deepseek-v4-flash)
 *   DEEPSEEK_API_KEY   (or the key resolved by the provider)
 *
 * Usage:
 *   node --env-file=<content-miner>/.env scripts/brief-v11-agent-review.mjs \
 *     --in docs/evidence/brief-v11-annotation-candidates.jsonl \
 *     --out docs/evidence/brief-v11-agent-auto-review.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getArg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const IN = getArg('--in', 'docs/evidence/brief-v11-annotation-candidates.jsonl');
const OUT = getArg('--out', 'docs/evidence/brief-v11-agent-auto-review.jsonl');
const DEFAULT_BASE = 'http://127.0.0.1:20128';
const BASE_RAW = (process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
const BASE = BASE_RAW.endsWith('/v1') ? BASE_RAW : `${BASE_RAW}/v1`;
const MODEL = process.env.DEEPSEEK_MODEL ?? 'ds/deepseek-v4-flash';
const API_KEY = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const LIMIT = Number(getArg('--limit', '999'));

if (!API_KEY) {
  console.error('No DEEPSEEK_API_KEY/OPENAI_API_KEY in env. Abort.');
  process.exit(2);
}

const SYSTEM = [
  'You are an objective short-video content reviewer (agent-assistant).',
  'Given a candidate window transcript excerpt from a long-form video, judge whether the window can stand alone as a YouTube Short.',
  'Return JSON ONLY: {"score": <0..1>, "hook": "yes"|"partial"|"no", "payoff": "yes"|"partial"|"no", "self_contained": "yes"|"partial"|"no", "ending_complete": "yes"|"partial"|"no", "notes": "<short>"}',
  'Be strict: an excerpt that starts mid-sentence, needs prior context, or trails into the next topic must score low.',
].join('\n');

/** String-aware balanced extraction; tries the first brace that yields valid JSON. */
function extractJson(raw) {
  const t = String(raw).trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  let start = t.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < t.length; j += 1) {
      const ch = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { depth += 1; continue; }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, j + 1)); } catch { break; }
        }
      }
    }
    start = t.indexOf('{', start + 1);
  }
  const m = t.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/);
  if (m) return { score: Number(m[1]) };
  throw new Error('no JSON in model output');
}

const rows = fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const outHandle = fs.openSync(OUT, 'w');
let count = 0;
let okCount = 0;

for (const row of rows) {
  for (const c of (row.candidates ?? []).slice(0, 4)) {
    if (count >= LIMIT) break;
    count += 1;
    const text = (c.text ?? '').slice(0, 2500);
    const user = `video_id=${row.video_id}\nwindow start=${c.start_sec} end=${c.end_sec} duration=${c.duration_sec}s\nTranscript:\n${text}`;
    let judge = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !judge; attempt += 1) {
      try {
        const body = {
          model: MODEL,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
          temperature: 0.2,
          max_tokens: 400,
        };
        if (attempt === 1) body.response_format = { type: 'json_object' };
        const resp = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // The 9router endpoint appends `data: [DONE]` after the JSON object
        // (same line or next), so resp.json() fails. Extract the balanced
        // JSON object from the raw text first, then fall back to SSE lines.
        const bodyText = await resp.text();
        let data = null;
        try { data = extractJson(bodyText); } catch { /* fall through */ }
        if (!data || !data.choices?.[0]?.message?.content) {
          for (const line of bodyText.split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s === 'data: [DONE]') continue;
            const candidate = s.startsWith('data: ') ? s.slice(6).trim() : s;
            try {
              const parsed = JSON.parse(candidate);
              if (parsed.choices?.[0]?.message?.content) { data = parsed; break; }
            } catch { /* keep scanning */ }
          }
        }
        if (!data || !data.choices?.[0]?.message?.content) throw new Error('no parseable SSE JSON in response');
        const raw = data.choices?.[0]?.message?.content ?? '';
        judge = extractJson(raw);
      } catch (err) {
        lastErr = err;
        if (attempt === 3) judge = { score: null, hook: 'error', payoff: 'error', self_contained: 'error', ending_complete: 'error', notes: String(lastErr) };
        else await sleep(2000 * attempt);
      }
    }
    if (judge && judge.score !== null) okCount += 1;
    const outRow = {
      reviewed_by: 'agent-assistant-v1',
      judged_at: new Date().toISOString(),
      video_id: row.video_id,
      candidate: { start_sec: c.start_sec, end_sec: c.end_sec, duration_sec: c.duration_sec, salience: c.salience },
      verdict: judge,
    };
    fs.writeSync(outHandle, `${JSON.stringify(outRow)}\n`);
    process.stderr.write(`[${count}] ${row.video_id} ${c.start_sec}-${c.end_sec} -> ${judge && judge.score !== null ? `score ${judge.score}` : 'error'}\n`);
  }
  if (count >= LIMIT) break;
}
fs.closeSync(outHandle);
process.stderr.write(`done: ${count} candidates, ${okCount} with valid scores -> ${OUT}\n`);