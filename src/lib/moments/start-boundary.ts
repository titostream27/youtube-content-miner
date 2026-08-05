import { utteranceAtOrBefore } from '@/lib/moments/utterances';
import type { EnrichedSentence } from '@/lib/moments/utterances';

/**
 * Phase 2 (Intelligence correctness) — Start-boundary validation.
 *
 * Replaces the hardcoded/assumed `startComplete = true` with explicit checks
 * on the FIRST utterance(s) of a candidate clip window:
 *
 *  1. MID_SENTENCE        — the window starts mid-utterance or the first
 *                           utterance continues a sentence from before the
 *                           window (lowercase start, trailing comma before
 *                           it in context, continuation conjunction).
 *  2. MISSING_CONTEXT     — the opening refers to something not present in
 *                           the window (demonstrative "this/that", definite
 *                           "the X" with no prior mention inside the clip).
 *  3. UNRESOLVED_REFERENCE— an opening pronoun (he/she/it/they/we/you) has
 *                           no antecedent inside the clip window.
 *  4. LATE_HOOK           — the first interesting/hook-like content arrives
 *                           after `lateHookSec` from the window start.
 *
 * The result feeds `startComplete` so the existing quality caps
 * (START_MID_SENTENCE_CAP / REQUIRES_PREVIOUS_CONTEXT_CAP) actually fire.
 */

export type StartBoundaryIssue =
  | 'MID_SENTENCE'
  | 'MISSING_CONTEXT'
  | 'UNRESOLVED_REFERENCE'
  | 'LATE_HOOK';

export interface StartBoundaryResult {
  ok: boolean;
  startComplete: boolean;
  issues: StartBoundaryIssue[];
  /** First issue found (deterministic priority order), for diagnostics. */
  primaryIssue?: StartBoundaryIssue;
  /** Seconds from window start to the first hook-like utterance. */
  hookDelaySec: number | null;
}

/** Words that continue a sentence / a train of thought — at the OPENING. */
const CONTINUATION_RE =
  /^(because|but|so|and|or|then|that|which|while|when|if|although|though|since|until|jadi|terus|tapi|karena|kalau|sementara|sampai|sehingga|namun|sedangkan|yang|dan|atau)\b/i;
/** Openers that refer to something already introduced — anchored to START.
 * Deictic pronouns (we/us/you/kita/kami/anda) are excluded: they always
 * resolve to the speakers/audience and are valid at the start of a clip.
 */
const REFERENTIAL_OPENERS_RE =
  /^(this|that|these|those|it|its|he|she|they|them|the|so|ini|itu|dia|mereka|jadi|terus|tapi|yang|gini|gitu)\b/i;
/** Pronouns with no antecedent inside the window — anchored to START. */
const PRONOUN_OPENERS_RE =
  /^(he|she|it|they|them|this|that|these|those|dia|mereka|ini|itu)\b/i;
/** Hook-like signals: numbers, superlatives, contrasts, questions, claims. */
const HOOK_SIGNAL_RE =
  /\b(\d+|most|best|never|always|only|secret|shocking|crazy|insane|huge|problem|mistake|failed|success|win|won|broke|why|how|what|actually|literally|worst|first|last|percent|million|billion|ribu|juta|miliar|miliaran|paling|terbesar|terbaik|gagal|sukses|rahasia|masalah|kenapa|bagaimana)\b/i;

/** A sentence that starts uppercase (likely a fresh sentence). */
function startsFreshSentence(text: string): boolean {
  const trimmed = text.trim();
  return /^[A-Z"'\u201C\u2018]/.test(trimmed) || /^["'\u201C\u2018]?[A-Z]/.test(trimmed);
}

/**
 * Validate the start of a clip window.
 *
 * @param utterances full utterance list
 * @param startSec window start (final boundary)
 * @param endSec window end (final boundary)
 * @param opts.lateHookSec hook latency threshold in seconds (default 12)
 */
export function validateStartBoundary(
  utterances: EnrichedSentence[],
  startSec: number,
  endSec: number,
  opts: { lateHookSec?: number } = {},
): StartBoundaryResult {
  const lateHookSec = opts.lateHookSec ?? 12;

  const inside = utterances.filter(
    (u) => u.endSec > startSec && u.startSec < endSec,
  );
  if (inside.length === 0) {
    return { ok: false, startComplete: false, issues: ['MISSING_CONTEXT'], primaryIssue: 'MISSING_CONTEXT', hookDelaySec: null };
  }

  const first = inside[0]!;
  const issues: StartBoundaryIssue[] = [];

  // 1. MID_SENTENCE — the opening continues a sentence.
  // Phase-2 correctness (F16): capitalization is WEAK evidence. Many
  // transcriptions normalize casing, so a lowercase start alone must not
  // flag MID_SENTENCE; it needs a continuation word, a mid-utterance
  // boundary, or PRECEDING CONTEXT to count.
  const continuesThought = CONTINUATION_RE.test(first.text.trim());
  const startsMidUtterance = first.startSec < startSec - 0.05;
  const startsLower = !startsFreshSentence(first.text);
  // Brief 2 Phase B: preceding context — the utterance immediately before
  // the window. If it ends mid-sentence (trailing comma / conjunction /
  // no terminal punctuation), the window opening continues that thought.
  let precedingContinues = false;
  const beforeIdx = utteranceAtOrBefore(utterances, startSec);
  if (beforeIdx >= 0) {
    const before = utterances[beforeIdx]!;
    if (before.endSec <= startSec + 0.05 && before.startSec < startSec - 0.05) {
      const bt = before.text.trim();
      // Trailing comma, dangling conjunction, or missing terminal punctuation.
      precedingContinues =
        /,\s*$/.test(bt) ||
        /(and|but|so|because|then|jadi|terus|tapi|karena)\s*$/i.test(bt) ||
        !/[.!?…"\u201D]$/.test(bt);
    }
  }
  if (continuesThought || startsMidUtterance || (startsLower && continuesThought) || precedingContinues) {
    issues.push('MID_SENTENCE');
  }

  // 2. MISSING_CONTEXT — referential opener with no earlier referent in window.
  const firstText = first.text.trim();
  if (REFERENTIAL_OPENERS_RE.test(firstText)) {
    // Check if the referent appears later in the window (self-contained).
    const rest = inside.slice(1).map((u) => u.text).join(' ');
    const hasLaterReferent = /\b(he|she|it|they|this|that|these|those|the|dia|mereka|ini|itu|yang)\b/i.test(rest);
    if (!hasLaterReferent) {
      issues.push('MISSING_CONTEXT');
    }
  }

  // 3. UNRESOLVED_REFERENCE — pronoun opener with no antecedent at all.
  if (PRONOUN_OPENERS_RE.test(firstText)) {
    const rest = inside.slice(1).map((u) => u.text).join(' ');
    const hasAntecedent = /\b(he|she|it|they|this|that|these|those|the|dia|mereka|ini|itu|yang)\b/i.test(rest);
    if (!hasAntecedent) {
      issues.push('UNRESOLVED_REFERENCE');
    }
  }

  // 4. LATE_HOOK — first hook-like utterance arrives too late.
  let hookDelaySec: number | null = null;
  const hookIdx = inside.findIndex((u) => HOOK_SIGNAL_RE.test(u.text));
  if (hookIdx >= 0) {
    hookDelaySec = Math.max(0, Math.round((inside[hookIdx]!.startSec - startSec) * 10) / 10);
    if (hookDelaySec > lateHookSec) {
      issues.push('LATE_HOOK');
    }
  }

  // Dedupe + priority order.
  const unique = Array.from(new Set(issues));
  const ok = unique.length === 0;
  return {
    ok,
    startComplete: ok,
    issues: unique,
    primaryIssue: unique[0],
    hookDelaySec,
  };
}
