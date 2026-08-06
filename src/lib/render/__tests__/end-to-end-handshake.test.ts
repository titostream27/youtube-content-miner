// Hardening v3 E1 (#30) — end-to-end cross-repository conformance: the miner's
// ClipRecord -> buildRenderContract payload must survive Python (Pydantic)
// normalization without losing words / language / provenance, and the
// renderer's RenderResult must parse back cleanly.
// Run: npx vitest run src/lib/render/__tests__/end-to-end-handshake.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { buildRenderContract } from '@/lib/render/contract';
import type { ClipRecord } from '@/lib/db/repositories/clips';

const RENDERER_DIR = join(__dirname, '..', '..', '..', '..', 'AI-Youtube-Shorts-Generator');
const PYTHON = join(RENDERER_DIR, '.venv', 'Scripts', 'python.exe');

function fakeClip(): ClipRecord {
  return {
    id: 1,
    videoId: 'ep-e2e',
    runId: 1,
    segmentIndex: 0,
    title: 'E2E clip',
    startSec: 10,
    endSec: 16,
    durationSec: 6,
    finalScore: 90,
    confidence: 0.9,
    tier: 'high_priority',
    category: 'Story',
    dimensions: { hook: 0.8, standalone: 0.7, clarity: 0.9, curiosity: 0.6, emotion: 0.5, storytelling: 0.8, shareability: 0.7, controversy: 0.3, teachingValue: 0.6, entertainment: 0.7 },
    whyThisWorks: ['clean story'],
    suggestedHook: 'It almost failed',
    suggestedCaption: 'the company nearly failed',
    editingNotes: '',
    transcript: 'the company nearly failed',
    engine: 'llm',
    endingType: 'CONCLUSION',
    startComplete: true,
  } as ClipRecord;
}

describe('miner -> python renderer handshake (E2E conformance)', () => {
  it('a miner contract payload survives Pydantic normalization without field loss', () => {
    // Skip if the renderer venv is not present (CI without it).
    if (!existsSync(PYTHON) || !existsSync(join(RENDERER_DIR, 'render_contract.py'))) {
      console.warn('renderer not present; skipping real E2E handshake');
      return;
    }
    const transcript = {
      videoId: 'ep-e2e', source: 'youtube_manual' as const, language: 'id',
      durationSec: 300, wordCount: 3,
      provider: 'youtube_manual', transcriptVersion: 'v3', alignmentConfidence: 0.97,
      cues: [
        {
          startSec: 10, endSec: 12, text: 'the company almost failed',
          speakerId: 'guest',
          words: [
            { startSec: 10, endSec: 10.5, text: 'the' },
            { startSec: 10.5, endSec: 11.2, text: 'company' },
            { startSec: 11.2, endSec: 12, text: 'almost' },
            { startSec: 12, endSec: 12.5, text: 'failed' },
          ],
        },
      ],
    };
    const contract = buildRenderContract('ep-e2e', [fakeClip()], {
      transcript,
      language: 'id',
      renderProfileVersion: 'camera-v3',
    });

    // Prove P0.4 fields are present in what the renderer will receive.
    const cp = contract.clips[0]!.caption_plan;
    expect(cp.language).toBe('id');
    expect(cp.provider).toBe('youtube_manual');
    expect(cp.alignment_confidence).toBeCloseTo(0.97, 2);
    expect(cp.cues[0]!.words).toHaveLength(4);

    // Real handshake: parse the payload with the renderer's pydantic model,
    // assert fields survive, then build a RenderResult back.
    const script = `
import json, sys
from render_contract import RenderRequestV2, RenderResult
payload = json.loads(sys.stdin.read())
req = RenderRequestV2(**payload)
cp = req.clips[0].caption_plan
out = {
  "language": cp.language,
  "provider": cp.provider,
  "transcript_version": cp.transcript_version,
  "alignment_confidence": cp.alignment_confidence,
  "word_count": len(cp.cues[0].words) if cp.cues and cp.cues[0].words else 0,
  "res": RenderResult(contract_version="2.0", request_id=payload["request_id"],
                      episode_id=payload["episode_id"], state="completed",
                      clips=[{"clip_id": str(c.clip_id), "status": "ok"} for c in req.clips]).state,
}
print(json.dumps(out))
`;
    const result = execFileSync(PYTHON, ['-c', script], {
      input: JSON.stringify(contract),
      encoding: 'utf-8',
      cwd: RENDERER_DIR,
    });
    const parsed = JSON.parse(result.trim().split('\n').pop()!);
    expect(parsed.language).toBe('id');
    expect(parsed.provider).toBe('youtube_manual');
    expect(parsed.word_count).toBe(4);
    expect(parsed.res).toBe('completed');
  });
});

function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}