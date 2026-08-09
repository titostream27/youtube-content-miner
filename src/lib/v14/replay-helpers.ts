/**
 * Brief V14 — replay helper module (types + deterministic utilities).
 * Only imported by the OFFLINE V14 runner; production never imports this.
 */
import { classifyEnding, detectTopicBoundary, type EndingAnalysis } from '@/lib/moments/topic-boundary';
import { utteranceAtOrBefore, type EnrichedSentence } from '@/lib/moments/utterances';

export const V14_STAGES = [
  '00_LINEAGE_PRESENT',
  '01_PROPOSAL_VALID',
  '02_TEMPORAL_NORMALIZATION',
  '03_START_GATE',
  '04_ENDING_COMPLETE',
  '05_ENDING_CONFIDENCE',
  '06_CONTAMINATION_GATE',
  '07_DURATION_GATE',
  '08_DUPLICATE_OVERLAP',
  '09_COMPONENT_SCORING',
  '10_FINAL_SCORE',
  '11_RANKING',
  '12_ACCEPTANCE_THRESHOLD',
  '13_FINAL_ACCEPTED',
] as const;

export type V14StageName = (typeof V14_STAGES)[number];

export interface V14StageRow {
  stage_id: string;
  stage_name: V14StageName;
  execution_index: number | null;
  reached: boolean;
  bypassed: boolean;
  status: 'SURVIVED' | 'DIED' | 'NOT_REACHED';
  semantic_state: string | null;
  raw_confidence: number | null;
  observed_invalidity: boolean | null;
  action: 'PASS' | 'SOFT_PENALTY' | 'HARD_REJECT' | 'NOT_REACHED';
  reason_code: string | null;
  evidence_refs: string[];
  evidence: Record<string, unknown>;
  score_before: number | null;
  delta: number | null;
  score_after: number | null;
  explanation: string;
}

export interface V14ReplayResult {
  run_id: string;
  parent_run_id: string | null;
  candidate_id: string;
  episode_id: string;
  variant_id: string;
  config_hash: string;
  code_sha: string;
  seed: string;
  stages: V14StageRow[];
  window: { start_sec: number; end_sec: number };
  first_death: V14StageName | null;
  first_death_reason: string | null;
  survived_to_scoring: boolean;
  final_accepted: boolean;
  final_score: number | null;
  original_score: number | null;
  soft_penalty_total: number;
  score_contributions: { component: string; delta: number | null; note: string }[];
  contamination: number | null;
}

export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function followingUtterances(
  utterances: EnrichedSentence[],
  endIdx: number,
  endSec: number,
  lookaheadSec: number,
): EnrichedSentence[] {
  if (endIdx < 0 || endIdx >= utterances.length) return [];
  const horizon = endSec + lookaheadSec;
  const out: EnrichedSentence[] = [];
  for (let i = endIdx + 1; i < utterances.length; i += 1) {
    const u = utterances[i];
    if (!u) break;
    if (u.startSec > horizon) break;
    out.push(u);
  }
  return out;
}

export function applyNextTopicGuard(
  selectedEnd: number,
  nextTopicDetected: boolean,
  nextTopicStart: number | null,
  endGuardSec: number,
): number {
  if (nextTopicDetected && nextTopicStart !== null) {
    const guarded = nextTopicStart - endGuardSec;
    if (guarded < selectedEnd) return Math.max(0, guarded);
  }
  return selectedEnd;
}

export function snapToUtteranceEnd(
  utterances: EnrichedSentence[],
  targetSec: number,
  windowSec = 0.45,
): number {
  let bestSec = targetSec;
  let bestDist = Math.abs((utterances[0]?.endSec ?? targetSec) - targetSec);
  for (const u of utterances) {
    const dist = Math.abs(u.endSec - targetSec);
    if (dist <= windowSec && dist < bestDist) {
      bestDist = dist;
      bestSec = u.endSec;
    }
  }
  return bestSec;
}

export function deterministicNormalization(
  utterances: EnrichedSentence[],
  roughStartSec: number,
  roughEndSec: number,
  nextTopicLookaheadSec: number,
  endGuardSec: number,
): { startSec: number; endSec: number } {
  const startIdx = utteranceAtOrBefore(utterances, roughStartSec);
  const endIdxLocal = utteranceAtOrBefore(utterances, roughEndSec);
  let finalEnd = roughEndSec;
  if (endIdxLocal >= 0) {
    const endU = utterances[endIdxLocal]!;
    const nxt = endIdxLocal + 1 < utterances.length ? utterances[endIdxLocal + 1]! : null;
    const following = followingUtterances(utterances, endIdxLocal, endU.endSec ?? roughEndSec, nextTopicLookaheadSec);
    const boundary = nxt
      ? detectTopicBoundary(endU, nxt, following, nextTopicLookaheadSec)
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };
    finalEnd = applyNextTopicGuard(endU.endSec ?? roughEndSec, boundary.nextTopicDetected, boundary.nextTopicStart, endGuardSec);
    finalEnd = snapToUtteranceEnd(utterances, finalEnd, 0.45);
  }
  const finalStart = startIdx >= 0 ? (utterances[startIdx]?.startSec ?? roughStartSec) : roughStartSec;
  return { startSec: finalStart, endSec: finalEnd };
}

export function evidenceAt(
  utterances: EnrichedSentence[],
  endSec: number,
  lookaheadSec: number,
): { ending: EndingAnalysis; boundary: { nextTopicDetected: boolean; nextTopicStart: number | null; contamination: number } } {
  const endIdx = utteranceAtOrBefore(utterances, endSec);
  if (endIdx < 0) {
    return {
      ending: { endingType: 'UNKNOWN', endingConfidence: 0.45, endingComplete: false },
      boundary: { nextTopicDetected: false, nextTopicStart: null, contamination: 0 },
    };
  }
  const endU = utterances[endIdx]!;
  const nxt = endIdx + 1 < utterances.length ? utterances[endIdx + 1]! : null;
  const following = followingUtterances(utterances, endIdx, endU.endSec, lookaheadSec);
  return {
    ending: classifyEnding(endU, nxt, following),
    boundary: nxt
      ? detectTopicBoundary(endU, nxt, following, lookaheadSec)
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 },
  };
}

export function nullDecision(): {
  state: null;
  action: 'PASS';
  reason_code: null;
  evidence_refs: [];
  raw_confidence: null;
  hard_reject: false;
  observed_invalidity: boolean;
  soft_penalty: 0;
  penalty_owner: null;
} {
  return {
    state: null,
    action: 'PASS',
    reason_code: null,
    evidence_refs: [],
    raw_confidence: null,
    hard_reject: false,
    observed_invalidity: false,
    soft_penalty: 0,
    penalty_owner: null,
  };
}

export type { EndingAnalysis };