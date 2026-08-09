/**
 * Brief V13 Phase A — Config snapshot (evidence/v13/config_before.json).
 *
 * Records the production selector configuration in effect BEFORE any V13
 * change: thresholds, weights, durations, gate config, dedupe/ranking,
 * fallback and LLM/provider identifiers (no secrets).
 *
 * Usage: DATABASE_PATH=... node --import tsx scripts/v13-config-snapshot.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/lib/config';
import {
  CLIP_GATE_WEIGHTS,
  CLIP_DRIVER_KEYS,
  CLIP_DRIVER_SHARE,
  CLIP_GATE_SHARE,
  CLIP_DRIVER_TOP_N,
  EPISODE_FACTOR_WEIGHTS,
} from '../src/lib/scoring/weights';
import { LIBRARY_MIN_SCORE, PRIORITY_TIERS } from '../src/lib/domain/thresholds';
import { SCORING_VERSION } from '../src/lib/moments/two-pass';
import { benchmarkVersion } from '../src/lib/v13r/consensus-v2';

function main(): void {
  const h = config.pipeline.highlight;
  const agentRoles: Record<string, { provider: string | null; model: string | null }> = {};
  for (const role of Object.keys(config.ai.agents)) {
    const a = config.ai.agents[role as keyof typeof config.ai.agents];
    agentRoles[role] = { provider: a.providerId ?? 'heuristic', model: a.model };
  }

  const snapshot = {
    benchmark_version: benchmarkVersion(),
    selector_version: SCORING_VERSION,
    generated_at: new Date().toISOString(),
    candidate_generation_config: {
      min_duration_sec: config.pipeline.segment.minDurationSec,
      max_duration_sec: config.pipeline.segment.maxDurationSec,
      target_duration_sec: config.pipeline.segment.targetDurationSec,
      max_scored_segments_per_episode: config.pipeline.maxScoredSegmentsPerEpisode,
      min_salience: 0.3,
      proposal_source: 'detectMoments (salience windows, greedy non-overlapping)',
    },
    duration_limits: {
      hard_min_sec: h.hardMinSec,
      hard_max_sec: h.hardMaxSec,
      min_complete_duration_sec: h.minCompleteDurationSec,
      preferred_min_sec: h.preferredMinSec,
      preferred_max_sec: h.preferredMaxSec,
      allow_short_complete_clip: h.allowShortCompleteClip,
    },
    start_gate_config: {
      hard_issues: ['MID_SENTENCE', 'MISSING_CONTEXT', 'UNRESOLVED_REFERENCE'],
      late_hook_sec: 12,
      repair: 'expandStartBackToComplete (bounded, H1 experimental only)',
      notes: 'LATE_HOOK is a scoring penalty, not a hard reject',
    },
    ending_complete_config: {
      classifier: 'classifyEnding (topic-boundary)',
      hard_fail_types: ['INCOMPLETE_SENTENCE', 'FILLER', 'TOPIC_TRANSITION', 'QUESTION_START', 'UNKNOWN'],
      repair: 'repairBoundary before reject (boundary-repair)',
    },
    ending_confidence_config: {
      min_ending_confidence: h.minEndingConfidence,
      gate_semantics: `reject when confidence < ${h.minEndingConfidence} AND duration >= preferred_min_sec (${h.preferredMinSec}s)`,
      boundary_confidence_min: h.minBoundaryConfidence,
    },
    contamination_gate: {
      max_next_topic_contamination: h.maxNextTopicContamination,
      next_topic_lookahead_sec: h.nextTopicLookaheadSec,
      end_guard_sec: h.endGuardSec,
      topic_change_threshold: h.topicChangeThreshold,
    },
    scoring_weights: {
      clip_gate_weights: CLIP_GATE_WEIGHTS,
      clip_driver_keys: CLIP_DRIVER_KEYS,
      clip_driver_share: CLIP_DRIVER_SHARE,
      clip_gate_share: CLIP_GATE_SHARE,
      clip_driver_top_n: CLIP_DRIVER_TOP_N,
      episode_factor_weights: EPISODE_FACTOR_WEIGHTS,
      scoring_engine: 'heuristic (deterministic fallback; LLM agent when provider available)',
    },
    acceptance: {
      clip_score_threshold: config.pipeline.clipScoreThreshold,
      library_min_score: LIBRARY_MIN_SCORE,
      episode_score_threshold: config.pipeline.episodeScoreThreshold,
      priority_tiers: PRIORITY_TIERS,
    },
    dedupe_config: {
      identity: 'candidateFingerprint (videoId + start + end + first4 + last4 words)',
      overlap_resolution: 'greedy non-overlapping by rank at proposal time',
    },
    ranking_config: {
      order: 'final clip score descending',
      tie_break: 'stable insertion order',
    },
    fallback_config: {
      llm_unavailable: 'heuristic engine (judgeSegmentHeuristically + computeClipScore)',
      boundary_refinement_unavailable: 'deterministicBoundary (two-pass)',
    },
    llm_provider_identifiers: {
      production_default: config.ai.defaultProvider,
      agent_roles: agentRoles,
      judge_tiers: {
        A: { provider: 'deepseek', model: 'ds/deepseek-v4-flash', endpoint: '9router 127.0.0.1:20128/v1' },
        B: { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', endpoint: 'api.openrouter.ai' },
        C: { provider: 'openai(channel=9router)', model: 'cx/gpt-5.6-luna', endpoint: '9router 127.0.0.1:20128/v1' },
      },
      confidence_floor: process.env.V12R_JUDGE_CONFIDENCE_FLOOR ?? '0.5 (default)',
    },
    provenance: {
      brief: 'Brief_V13_Production_Selector_Alignment_Silver_Pass_Recall.pdf',
      baseline_sha: '1f58c6f3',
      baseline_branch: 'fix/brief-v12r-silver-gold-judge',
    },
  };

  fs.mkdirSync('evidence/v13', { recursive: true });
  fs.writeFileSync('evidence/v13/config_before.json', JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log('wrote evidence/v13/config_before.json');
}

main();
