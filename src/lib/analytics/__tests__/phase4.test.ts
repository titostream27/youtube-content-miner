import { describe, it, expect } from 'vitest';
import { analyzeSpeakers } from '@/lib/moments/speaker-intelligence';
import { estimateLlmCost } from '@/lib/db/repositories/cost-ledger';
import { computeReRankAdjustments } from '@/lib/analytics/learning';
import type { TranscriptCue } from '@/lib/domain/types';

function cue(start: number, end: number, text: string, speakerId?: string): TranscriptCue {
  return { startSec: start, endSec: end, text, speakerId: speakerId ?? null };
}

describe('analyzeSpeakers (brief §34)', () => {
  it('clusters cues by speaker and detects host/guest', () => {
    const cues = [
      cue(0, 3, 'So tell me, how did you start the company?', 'SPEAKER_00'),
      cue(3, 9, 'We started in a garage with almost no money and built the product over two years.', 'SPEAKER_01'),
      cue(9, 12, 'What about the hardest moment?', 'SPEAKER_00'),
      cue(12, 20, 'The hardest moment was when we almost ran out of cash and had to lay off half the team.', 'SPEAKER_01'),
    ];
    const a = analyzeSpeakers(cues);
    expect(a.diarized).toBe(true);
    expect(a.hostSpeaker?.speakerId).toBe('SPEAKER_00');
    expect(a.guestSpeaker?.speakerId).toBe('SPEAKER_01');
    expect(a.guestSpeaker!.speechShare).toBeGreaterThan(0.5);
  });

  it('handles non-diarized transcripts with a single unknown speaker', () => {
    const cues = [
      cue(0, 3, 'This is a monologue without speakers.'),
      cue(3, 6, 'It keeps going for a while.'),
    ];
    const a = analyzeSpeakers(cues);
    expect(a.diarized).toBe(false);
    expect(a.speakers.length).toBeGreaterThanOrEqual(1);
  });

  it('produces a standalone signal in range', () => {
    const cues = [
      cue(0, 2, 'How did you do it?', 'SPEAKER_00'),
      cue(2, 10, 'We focused on one thing and ignored everything else for a year.', 'SPEAKER_01'),
    ];
    const a = analyzeSpeakers(cues);
    expect(a.standaloneSignal).toBeGreaterThanOrEqual(0);
    expect(a.standaloneSignal).toBeLessThanOrEqual(1);
  });
});

describe('estimateLlmCost (brief §37)', () => {
  it('estimates nonzero cost for tokens', () => {
    const cost = estimateLlmCost(100_000, 20_000);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1); // ~$0.05 for this volume
  });

  it('zero cost for zero tokens', () => {
    expect(estimateLlmCost(0, 0)).toBe(0);
  });
});

describe('computeReRankAdjustments (brief §24)', () => {
  it('returns adjustments but NOT applied when below threshold', () => {
    const r = computeReRankAdjustments();
    expect(r.eligible).toBe(false); // temp DB has no analytics
    for (const a of r.adjustments) {
      expect(a.applied).toBe(false);
    }
  });

  it('deltas stay within sane bounds', () => {
    const r = computeReRankAdjustments();
    for (const a of r.adjustments) {
      expect(Math.abs(a.delta)).toBeLessThanOrEqual(0.1);
    }
  });
});
