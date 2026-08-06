import type { EnrichedSentence } from '@/lib/moments/utterances';
import type { StartBoundaryIssue } from '@/lib/moments/start-boundary';

/**
 * Hardening sprint P0.3: start-boundary validation is a REPAIR/REJECT gate,
 * not a soft penalty. MID_SENTENCE / MISSING_CONTEXT / UNRESOLVED_REFERENCE
 * mean the clip cannot stand alone and must be repaired (start pulled back to
 * a complete prior utterance) or rejected. LATE_HOOK stays a scoring penalty.
 */
export const START_HARD_ISSUES: ReadonlySet<StartBoundaryIssue> = new Set<StartBoundaryIssue>([
  'MID_SENTENCE',
  'MISSING_CONTEXT',
  'UNRESOLVED_REFERENCE',
]);

/** Whether a set of start-boundary findings forces repair/reject. */
export function startBoundaryNeedsReject(issues: readonly StartBoundaryIssue[]): boolean {
  return issues.some((issue) => START_HARD_ISSUES.has(issue));
}

function sentenceComplete(u: EnrichedSentence): boolean {
  return typeof u.isCompleteSentence === 'boolean'
    ? u.isCompleteSentence
    : /[.!?…"']$/.test(u.text.trim());
}

/**
 * Expand a clip start BACK to the last complete prior utterance so the window
 * no longer begins mid-sentence or with a dangling referential opener.
 *
 * Walks the utterances ending at/before `startSec` and returns the start of
 * the closest one that ends a sentence. `startSec` itself is assumed already
 * to be a hard-failure boundary.
 */
export function expandStartBackToComplete(
  context: readonly EnrichedSentence[],
  startSec: number,
): number {
  const before = context.filter((u) => u.endSec <= startSec + 0.05);
  if (before.length === 0) {
    return startSec;
  }
  let lastComplete: EnrichedSentence | null = null;
  for (const u of before) {
    if (sentenceComplete(u)) {
      lastComplete = u;
    }
  }
  if (!lastComplete) {
    return before[0]!.startSec;
  }
  return lastComplete.startSec;
}