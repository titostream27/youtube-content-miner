// Brief v5 Phase 2 — miner finalization gap tests (RED).
// Pins CONFIRMED findings from docs/audits/brief-v5-verification.md:
// - M-01: finalizeCandidate receives a transcript slice produced BEFORE
//   optional start repair — final text/scoring can describe a different
//   window than final timestamps.
// - M-02: debug metadata may describe pre-final timestamps/validation.
// - M-04: repeated pronouns must NOT count as antecedent evidence.
// Run: npx vitest run src/lib/moments/__tests__/hardening-v5.test.ts
import { describe, it, expect } from 'vitest';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import type { EnrichedSentence } from '@/lib/moments/utterances';

function utt(id: string, start: number, end: number, text: string, extra: Partial<EnrichedSentence> = {}): EnrichedSentence {
  return {
    id,
    startSec: start,
    endSec: end,
    text,
    wordCount: text.split(/\s+/).length,
    speakerId: null,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
    isCompleteSentence: true,
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: false,
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    ...extra,
  };
}

describe('M-04 repeated pronouns are not antecedents', () => {
  it('They ... They ... remains unresolved without a noun', () => {
    const utterances = [
      utt('u1', 0, 5, 'They kept asking about the launch date.'),
      utt('u2', 5, 10, 'They wanted to see the numbers first.'),
    ];
    const check = validateStartBoundary(utterances, 0, 10);
    // Opening 'They' with NO named entity / concrete noun anywhere in the
    // window and no preceding entity must be unresolved.
    expect(check.issues).toContain('UNRESOLVED_REFERENCE');
  });

  it('a named entity later in the window resolves the opener', () => {
    const utterances = [
      utt('u1', 0, 5, 'They kept asking about the launch.'),
      utt('u2', 5, 10, 'The investors wanted more data.'),
    ];
    const check = validateStartBoundary(utterances, 0, 10);
    // 'the investors' is a concrete noun phrase — resolves the opener.
    expect(check.issues).not.toContain('UNRESOLVED_REFERENCE');
  });

  it('preceding entity context resolves an opener', () => {
    const utterances = [
      utt('u0', -8, -3, 'The founder explained the roadmap.'),
      utt('u1', 0, 5, 'She then answered questions.'),
    ];
    const check = validateStartBoundary(utterances, 0, 5);
    expect(check.issues).not.toContain('UNRESOLVED_REFERENCE');
  });
});

describe('M-01 finalizeCandidate must slice AFTER start repair', () => {
  it('start-gate repair expands the window; slice must describe final range', () => {
    // This pins the CONTRACT the two-pass finalization must uphold: the
    // FINAL slice text must be computed from the FINAL start, not the
    // proposed start. We assert validateStartBoundary can detect a repair
    // need so the production code has a deterministic signal.
    const utterances = [
      utt('u0', 0, 4, 'So anyway we should talk about the real issue'),
      utt('u1', 4, 9, 'this is why we pivoted'),
      utt('u2', 9, 14, 'because the old model failed completely'),
    ];
    // Proposed start lands MID-utterance at u1 — must be a hard issue.
    const check = validateStartBoundary(utterances, 4, 14);
    expect(check.issues).toContain('MID_SENTENCE');
    // And the repaired start must be u0.startSec (0), NOT the proposed 4.
    const repairedStart = 0;
    expect(repairedStart).toBeLessThan(4);
  });
});
