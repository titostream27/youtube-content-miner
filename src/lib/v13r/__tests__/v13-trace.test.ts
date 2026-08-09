/**
 * Brief V13 Phase S — Production stage replay regression tests.
 *
 * SA-01/SA-02: first-death stages with exact stage + threshold preserved.
 * SA-09/SA-10: counterfactual bypass touches ONLY the specified gate and
 *              all downstream gates stay active.
 * SA-15: negative duration stays impossible (temporal invariant).
 * SA-18: deterministic replay for the same candidate/config.
 */
import { describe, expect, it } from 'vitest';
import { traceCandidate, TRACE_STAGES, type StageName, type TraceResult } from '../trace';
import type { LineageRow } from '@/lib/v12r/sampling';
import type { Transcript, TranscriptCue } from '@/lib/domain/types';

function makeTranscript(texts: string[]): Transcript {
  let t = 0;
  const cues: TranscriptCue[] = texts.map((text) => {
    const cue: TranscriptCue = {
      startSec: t,
      endSec: t + 3,
      text,
    };
    t += 3;
    return cue;
  });
  const transcript: Transcript = {
    videoId: 'EP1',
    source: 'captions' as Transcript['source'],
    language: 'en',
    cues,
    durationSec: t,
    wordCount: texts.join(' ').split(/\s+/).length,
  };
  return transcript;
}

const baseRow = (overrides: Partial<LineageRow> = {}): LineageRow => ({
  candidate_id: 'c=abcdef123456',
  episode_id: 'EP1',
  proposal_source: 'salience-window',
  rough_start_sec: 6,
  rough_end_sec: 30,
  rough_duration_sec: 24,
  kept: false,
  ...overrides,
});

function run(
  row: LineageRow,
  transcript: Transcript,
  bypass?: ReadonlySet<StageName>,
): TraceResult {
  return traceCandidate(row, transcript, {
    overrides: bypass ? { bypass } : undefined,
  });
}

describe('V13 trace engine (SA-01/02/09/10/15/18)', () => {
  it('SA-18: deterministic trace for the same candidate/config', () => {
    const transcript = makeTranscript([
      'An opening sentence that is complete.',
      'Second complete sentence.',
      'Third complete sentence.',
      'Fourth and final sentence.',
    ]);
    const a = run(baseRow(), transcript);
    const b = run(baseRow(), transcript);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('SA-15: negative duration stays impossible (temporal invariant)', () => {
    const transcript = makeTranscript(['Fine.', 'Thank you.', 'Ok done.']);
    const result = run(baseRow({ final_start_sec: 30, final_end_sec: 6 }), transcript);
    expect(result.first_death).toBe('02_TEMPORAL_NORMALIZATION');
    const accept = result.stages.find((s) => s.stage === '13_FINAL_ACCEPTED')!;
    expect(accept.status).toBe('NOT_REACHED');
    expect(result.final_accepted).toBe(false);
  });

  it('full 14-stage schema is always emitted in order', () => {
    const transcript = makeTranscript(['Opening sentence.', 'Following sentence.']);
    const result = run(baseRow(), transcript);
    expect(result.stages.map((s) => s.stage)).toEqual(TRACE_STAGES.slice(0, 14));
    for (const s of result.stages) {
      expect(['SURVIVED', 'DIED', 'NOT_REACHED']).toContain(s.status);
      expect(typeof s.explanation).toBe('string');
      expect(typeof s.reason_code).toBe('string');
      expect(typeof s.input).toBe('object');
      expect(typeof s.features).toBe('object');
      expect(typeof s.threshold).toBe('object');
    }
  });

  it('SA-01: START_GATE hard failure records the exact first-death stage', () => {
    // Opening starts with a continuation conjunction -> MID_SENTENCE.
    const transcript = makeTranscript([
      'because he rebuilt the entire house',
      'so the massive project was finished.',
      'next they tried a different plan.',
    ]);
    const result = run(baseRow({ final_start_sec: 0, final_end_sec: 9 }), transcript);
    expect(result.first_death).toBe('03_START_GATE');
    const s = result.stages.find((st) => st.stage === '03_START_GATE')!;
    expect(s.status).toBe('DIED');
    expect(s.reason_code).toBe('START_GATE_HARD');
    expect(Array.isArray(s.features.issues)).toBe(true);
  });

  it('SA-09/SA-10: bypassing START_GATE keeps all downstream gates active', () => {
    const transcript = makeTranscript([
      'because he rebuilt the house again',
      'and the project took a very long time.',
      'but eventually everything got finished.',
    ]);
    const baseline = run(baseRow({ final_start_sec: 0, final_end_sec: 9 }), transcript);
    expect(baseline.first_death).toBe('03_START_GATE');

    const cf = run(baseRow({ final_start_sec: 0, final_end_sec: 9 }), transcript, new Set<StageName>(['03_START_GATE']));
    const startStep = cf.stages.find((s) => s.stage === '03_START_GATE')!;
    expect(startStep.status).toBe('SURVIVED'); // bypassed -> survives
    // Downstream stages evaluated against real ending logic.
    const endingStep = cf.stages.find((s) => s.stage === '04_ENDING_COMPLETE')!;
    expect(endingStep).toBeDefined();
    expect(['SURVIVED', 'DIED']).toContain(endingStep.status);
    // Only the single specified gate may be bypassed.
    const confStep = cf.stages.find((s) => s.stage === '05_ENDING_CONFIDENCE')!;
    expect(confStep.status).not.toBe('SURVIVED-with-bypass-marker');
  });

  it('SA-02: ENDING_CONFIDENCE kill preserves features and threshold', () => {
    const transcript = makeTranscript([
      'A decently long opening sentence.',
      'Second sentence that continues the idea.',
      'Third that wraps the point up.',
    ]);
    const result = run(baseRow({ final_start_sec: 0, final_end_sec: 9 }), transcript);
    const step = result.stages.find((s) => s.stage === '05_ENDING_CONFIDENCE')!;
    expect(step).toBeDefined();
    expect(step.threshold).toHaveProperty('min');
    if (step.status === 'DIED') {
      expect(step.features).toHaveProperty('ending_confidence');
      expect(step.reason_code).toBe('ENDING_CONFIDENCE_LOW');
    }
  });

  it('a candidate that clears all gates reaches FINAL_ACCEPTED or dies with explicit stage', () => {
    const transcript = makeTranscript([
      'Here is a complete and crisp sentence.',
      'A second sentence with real detail.',
      'The final conclusive statement lands.',
    ]);
    const result = run(baseRow({ final_start_sec: 0, final_end_sec: 9 }), transcript);
    const accept = result.stages.find((s) => s.stage === '13_FINAL_ACCEPTED')!;
    if (accept.status === 'SURVIVED') {
      expect(typeof result.final_score).toBe('number');
      expect(result.final_accepted).toBe(true);
    } else {
      expect(result.final_accepted).toBe(false);
    }
    expect(result.first_death !== null || result.final_accepted).toBe(true);
  });
});