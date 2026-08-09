import { describe, expect, it } from 'vitest';
import type { Utterance } from '@/lib/moments/utterances';
import { analyzeEndingPause } from '../h6-pause';
import { expandStartToValidSetup } from '../h1-start';
import { buildStratifiedSample, type LineageRow } from '../sampling';
import { buildJudgeInput } from '../judge-input';
import { decideConsensus } from '../consensus';
import type { JudgeCall } from '../judge-types';
import type { Transcript } from '@/lib/domain/types';

/**
 * Brief V12R Phase M — fixtures AJ-08..AJ-20: H6 pause semantics, H1 bounded
 * expansion, sampling determinism, consensus artifact stability.
 */

function utt(id: string, startSec: number, endSec: number, text: string, extra: Partial<Utterance> = {}): Utterance {
  return {
    id,
    startSec,
    endSec,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
    speakerId: null,
    isCompleteSentence: false,
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: false,
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    words: undefined,
    ...extra,
  } as unknown as Utterance;
}

function transcript(cues: { startSec: number; endSec: number; text: string }[]): Transcript {
  return {
    videoId: 'fixture-v12r',
    source: 'youtube_asr',
    language: 'en',
    durationSec: 1000,
    wordCount: 100,
    cues: cues.map((c) => ({ ...c, words: [] })),
  } as Transcript;
}

function fakeJudge(publishable: boolean, confidence: number): JudgeCall {
  return {
    tier: 'A',
    providerId: 'fixture',
    model: 'fixture',
    raw_text: '{}',
    output: {
      start_complete: true,
      setup_sufficient: true,
      context_independence: true,
      hook_score: 0.7,
      topic_cohesion: 0.7,
      payoff_score: 0.7,
      ending_complete: true,
      next_topic_leakage: false,
      hard_negative: false,
      standalone_score: 0.7,
      publishable,
      confidence,
      failure_reasons: [],
      repair_hint: { action: 'NONE', directional_seconds: 0, semantic_reason: 'fixture' },
      short_reason: 'fixture',
    },
    status: 'ok',
    error: null,
    attempts: 1,
    input_tokens: null,
    output_tokens: null,
    duration_ms: 1,
  };
}

describe('V12R H6 pause-aware ending confidence', () => {
  it('AJ-08 no punctuation + clear pause + complete semantics -> H6 may recover', () => {
    const utterances = [
      utt('a', 100, 110, 'The answer is that we changed the process', {
        isCompleteSentence: false,
        pauseAfterSec: 0.9,
      }),
    ];
    const result = analyzeEndingPause({ startSec: 100, endSec: 110 }, utterances, 0.78);
    expect(result).not.toBeNull();
    expect(result!.experimental_confidence).toBeGreaterThanOrEqual(0.82);
    expect(result!.experimental_decision).toBe('ACCEPT');
  });

  it('AJ-09 no punctuation + finished thought + pause -> H6 must not recover', () => {
    const utterances = [
      utt('a', 100, 110, 'And then we just kept going because', { pauseAfterSec: 1.2 }),
    ];
    const r = analyzeEndingPause({ startSec: 100, endSec: 110 }, utterances, 0.55);
    expect(r).not.toBeNull();
    expect(r!.experimental_confidence).toBeLessThan(0.82);
    expect(r!.experimental_decision).toBe('REJECT');
  });
});

describe('V12R H1 bounded start expansion', () => {
  it('AJ-10 mid-context + nearby valid setup -> expands to question', () => {
    const utterances = [
      utt('q', 50, 58, 'What did she do next?'),
      utt('a', 58, 66, 'she went to the studio and recorded it', {}),
    ];
    const r = expandStartToValidSetup({ startSec: 62, endSec: 90 }, utterances, {});
    expect(r.reason_code).toBe('EXPAND_TO_QUESTION');
    expect(r.found_setup).toBe(true);
    expect(r.expanded_start_sec).toBe(50);
  });

  it('AJ-11 mid-context + no valid setup -> reject', () => {
    const utterances = [
      utt('a', 50, 58, 'because the market demanded it and then', {}),
    ];
    const r = expandStartToValidSetup({ startSec: 58, endSec: 90 }, utterances, {});
    expect(r.found_setup).toBe(false);
    expect(['REJECT_NO_VALID_SETUP', 'REJECT_WOULD_CROSS_TOPIC']).toContain(r.reason_code);
  });

  it('AJ-12 backward search crosses topic -> reject expansion', () => {
    const utterances = [
      utt('a', 10, 20, 'This is the earlier topic setup.'),
      utt('trans', 30, 40, 'Anyway, moving on to something new.'),
    ];
    const r = expandStartToValidSetup({ startSec: 40, endSec: 80 }, utterances, {});
    expect(r.crossed_topic).toBe(true);
    expect(r.reason_code).toBe('REJECT_WOULD_CROSS_TOPIC');
    expect(r.found_setup).toBe(false);
  });

  it('AJ-13 start already valid -> no expansion', () => {
    const utterances = [
      utt('s', 40, 48, 'When I was young I saved every paycheck.'),
    ];
    const r = expandStartToValidSetup({ startSec: 40, endSec: 90 }, utterances, {});
    expect(r.reason_code).toBe('NO_REPAIR_NEEDED');
    expect(r.expanded_start_sec).toBe(40);
  });
});

describe('V12R sampling determinism', () => {
  function rows(): LineageRow[] {
    const raw: LineageRow[] = [];
    for (let i = 0; i < 100; i += 1) {
      raw.push({
        candidate_id: `c=${i}`,
        episode_id: `ep${i % 5}`,
        rough_start_sec: i * 10,
        rough_end_sec: i * 10 + 40,
        kept: false,
        accepted: false,
        rejection_stage: i % 3 === 0 ? 'ENDING_CONFIDENCE' : i % 3 === 1 ? 'ENDING_COMPLETE' : 'ENDING_CONFIDENCE',
        ending_confidence: i % 3 === 0 ? 0.78 : 0.4,
        rank: null,
      });
    }
    raw.push({
      candidate_id: 'c=accepted',
      episode_id: 'ep0',
      rough_start_sec: 1,
      rough_end_sec: 21,
      kept: true,
      accepted: true,
    });
    return raw;
  }

  it('AJ-19 seeded sampling is fully deterministic', () => {
    const a = buildStratifiedSample(rows(), { seed: 42, targetSize: 20 });
    const b = buildStratifiedSample(rows(), { seed: 42, targetSize: 20 });
    expect(a.sample.map((e) => e.candidate_id)).toEqual(b.sample.map((e) => e.candidate_id));
    expect(a.seed).toBe(42);
    // every included candidate is unique
    const ids = a.sample.map((e) => e.candidate_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sampling includes the accepted candidate when present', () => {
    const s = buildStratifiedSample(rows(), { seed: 42, targetSize: 20 });
    expect(s.sample.some((e) => e.accepted)).toBe(true);
  });
});

describe('V12R judge input contract', () => {
  it('contract carries pre/candidate/post context and source evidence', () => {
    const tr = transcript([
      { startSec: 0, endSec: 10, text: 'intro sentence that is long enough.' },
      { startSec: 10, endSec: 20, text: 'setup that continues.' },
      { startSec: 20, endSec: 30, text: 'candidate body sentence.' },
      { startSec: 30, endSec: 40, text: 'candidate payoff sentence.' },
      { startSec: 40, endSec: 50, text: 'next topic question.' },
      { startSec: 50, endSec: 60, text: 'wrapping up afterwards.' },
    ]);
    const contract = buildJudgeInput(tr, { startSec: 20, endSec: 40 }, 'c=test', { maxContextSec: 20 });
    expect(contract.pre_context.text).toContain('setup');
    expect(contract.candidate.text).toContain('candidate');
    expect(contract.post_context.text).toContain('next topic');
    expect(contract.source_evidence.timing_precision).toBe('cue');
    expect(contract.candidate.duration_sec).toBe(20);
  });
});

describe('V12R consensus artifact stability', () => {
  it('AJ-20 consensus output carries stable machine-readable fields', () => {
    const d = decideConsensus(fakeJudge(true, 0.9), fakeJudge(true, 0.9), null, { confidenceFloor: 0.5 });
    expect(d).toHaveProperty('label');
    expect(d).toHaveProperty('rule');
    expect(d).toHaveProperty('votes');
    expect(d).toHaveProperty('judge_c_invoked');
    expect(d).toHaveProperty('reason');
    expect(['PASS', 'REVIEW', 'FAIL']).toContain(d.label);
  });
});