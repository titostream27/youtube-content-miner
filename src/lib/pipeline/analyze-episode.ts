import { config } from '@/lib/config';
import type {
  ClipJudgement,
  EpisodeCandidate,
  MomentSegment,
  ScoredClip,
  ScoringEngineName,
  Transcript,
} from '@/lib/domain/types';
import { computeClipScore } from '@/lib/scoring/clip-score';
import { computeConfidence } from '@/lib/scoring/confidence';
import { detectMoments } from '@/lib/moments/segmentation';
import { twoPassHighlightSelection } from '@/lib/moments/two-pass';
import {
  judgeSegmentHeuristically,
  refineClipMetadata,
  scoreSegmentsWithAgent,
  UsageLedger,
  type AgentOverrides,
} from '@/lib/ai';
import { resolveTranscript, TranscriptUnavailableError } from '@/lib/transcript';

/**
 * PRD Steps 3 through 8 for a single episode.
 *
 * Kept separate from the run orchestrator so one episode can be analysed on its
 * own - from the episode detail page, or when re-scoring after a model change -
 * without going through discovery again.
 */

export interface AnalyzeEpisodeParams {
  candidate: EpisodeCandidate;
  topic: string | null;
  clipScoreThreshold: number;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
  forceTranscriptRefresh?: boolean;
}

export interface AnalyzeEpisodeResult {
  transcript: Transcript;
  segments: MomentSegment[];
  /** Clips at or above the threshold, best first. */
  clips: ScoredClip[];
  /** Everything scored, including archive-tier, for the training dataset. */
  allClips: ScoredClip[];
  engine: ScoringEngineName;
  warnings: string[];
}

/**
 * Build the final clip record from a raw judgement.
 *
 * Note the separation of concerns: the engine (LLM or heuristic) produces
 * dimension scores and copy, and never the final score, the tier, or the
 * confidence. Those are computed here from the deterministic models so that
 * thresholds mean the same thing regardless of which engine ran, and so a
 * model swap cannot silently redefine "Publish Immediately".
 */
function buildClip(params: {
  segment: MomentSegment;
  judgement: ClipJudgement;
  transcriptSource: Transcript['source'];
}): ScoredClip {
  const { segment, judgement, transcriptSource } = params;

  const score = computeClipScore(judgement.dimensions, segment);
  const { confidence } = computeConfidence({
    dimensions: judgement.dimensions,
    finalScore: score.finalScore,
    segment,
    transcriptSource,
    whyThisWorks: judgement.whyThisWorks,
    selfCertainty: judgement.selfCertainty,
    engine: judgement.engine,
  });

  // Surface the quality caps as explanations - "why is this a 87 and not a 95"
  // is the question an editor actually asks.
  const capReasons = score.appliedCaps.map((cap) => cap.reason);
  const whyThisWorks = Array.from(new Set([...judgement.whyThisWorks, ...capReasons])).slice(0, 6);

  return {
    segmentIndex: segment.index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    durationSec: segment.durationSec,
    title: judgement.title,
    transcript: segment.text,
    dimensions: judgement.dimensions,
    finalScore: score.finalScore,
    confidence,
    tier: score.tier,
    category: judgement.category,
    whyThisWorks,
    suggestedHook: judgement.suggestedHook,
    suggestedCaption: judgement.suggestedCaption,
    editingNotes: judgement.editingNotes,
    engine: judgement.engine,
  };
}

export async function analyzeEpisode(
  params: AnalyzeEpisodeParams,
): Promise<AnalyzeEpisodeResult> {
  const { candidate, topic, clipScoreThreshold, overrides, ledger, signal } = params;
  const warnings: string[] = [];

  // Step 3 - transcript.
  const resolution = await resolveTranscript({
    candidate,
    forceRefresh: params.forceTranscriptRefresh,
    signal,
  });
  warnings.push(...resolution.warnings);
  const transcript = resolution.transcript;

  // Step 4 - moment detection.
  const detection = detectMoments(transcript, {
    minDurationSec: config.pipeline.segment.minDurationSec,
    maxDurationSec: config.pipeline.segment.maxDurationSec,
    targetDurationSec: config.pipeline.segment.targetDurationSec,
    maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
  });

  if (detection.segments.length === 0) {
    warnings.push(
      `${candidate.videoId}: no candidate moments passed the salience filter (${detection.sentenceCount} sentences).`,
    );
    return {
      transcript,
      segments: [],
      clips: [],
      allClips: [],
      engine: 'heuristic',
      warnings,
    };
  }

  // Step 4b - two-pass highlight selection: Pass 2 (boundary refinement) with
  // deterministic topic-boundary guards (Phase 1 Correctness).
  const twoPass = await twoPassHighlightSelection(
    transcript,
    detection.segments,
    candidate.title,
    {
      minDurationSec: config.pipeline.segment.minDurationSec,
      maxDurationSec: config.pipeline.segment.maxDurationSec,
      targetDurationSec: config.pipeline.segment.targetDurationSec,
      maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
      overrides,
      ledger,
      signal,
    },
  );
  warnings.push(...twoPass.warnings);
  const segments = twoPass.segments;

  // Step 5 - clip scoring. The agent handles what it can; every segment it
  // misses or fails on falls through to the deterministic engine, so a partial
  // provider failure costs quality rather than coverage.
  const agentResult = await scoreSegmentsWithAgent({
    segments,
    episodeTitle: candidate.title,
    channelTitle: candidate.channelTitle,
    topic,
    overrides,
    ledger,
    signal,
  });
  warnings.push(...agentResult.warnings);

  let llmScored = 0;
  const allClips = segments.map((segment) => {
    const judgement = agentResult.judgements.get(segment.index);
    if (judgement) llmScored += 1;
    return buildClip({
      segment,
      judgement: judgement ?? judgeSegmentHeuristically(segment),
      transcriptSource: transcript.source,
    });
  });

  // Step 7 - threshold filtering.
  const passing = allClips
    .filter((clip) => clip.finalScore >= clipScoreThreshold)
    .sort((a, b) => b.finalScore - a.finalScore || b.confidence - a.confidence);

  // Step 8 - publish-ready copy, only for clips that survived the threshold.
  const metadata = await refineClipMetadata({
    clips: passing,
    episodeTitle: candidate.title,
    overrides,
    ledger,
    signal,
  });
  warnings.push(...metadata.warnings);

  const refinedById = new Map(metadata.clips.map((clip) => [clip.segmentIndex, clip]));

  return {
    transcript,
    segments,
    clips: metadata.clips,
    allClips: allClips.map((clip) => refinedById.get(clip.segmentIndex) ?? clip),
    engine: llmScored > 0 ? 'llm' : 'heuristic',
    warnings,
  };
}

export { TranscriptUnavailableError };
