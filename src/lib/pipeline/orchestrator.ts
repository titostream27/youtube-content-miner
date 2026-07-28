import { config } from '@/lib/config';
import { PRIORITY_TIERS, type PriorityTier } from '@/lib/domain/thresholds';
import type {
  EpisodeAnalysisResult,
  EpisodeCandidate,
  RunRequest,
  RunSummary,
  ScoringEngineName,
} from '@/lib/domain/types';
import { scoreEpisodeOpportunity } from '@/lib/scoring/episode-opportunity';
import { planDiscovery, triageEpisodes, UsageLedger, type AgentOverrides } from '@/lib/ai';
import {
  discoverByTopic,
  discoverFromChannels,
  mineChannelArchive,
} from '@/lib/youtube/discovery';
import { upsertChannel } from '@/lib/db/repositories/channels';
import {
  listTrackedChannels,
  markTrackedChannelChecked,
} from '@/lib/db/repositories/channels';
import {
  findAnalysedVideoIds,
  markEpisodeAnalysed,
  markEpisodeFailed,
  markEpisodeSkipped,
  upsertDiscoveredEpisode,
} from '@/lib/db/repositories/episodes';
import { replaceClipsForEpisode } from '@/lib/db/repositories/clips';
import { completeRun, createRun, failRun } from '@/lib/db/repositories/runs';
import { analyzeEpisode } from './analyze-episode';

/**
 * The run orchestrator - the PRD's complete workflow, in order:
 *
 *   Input topic -> AI search -> episode ranking -> transcript -> moment
 *   detection -> clip scoring -> threshold filtering -> export
 *
 * The two gates that make this economically viable are both here:
 *
 *  1. The Episode Opportunity Score decides which episodes get a transcript at
 *     all. Everything below threshold is recorded as skipped, with a reason, and
 *     never costs a token.
 *  2. `maxEpisodesAnalysedPerRun` caps spend per run even when discovery finds
 *     forty eligible episodes.
 *
 * Nothing in a run is fatal by default. A single episode that fails to
 * transcribe is recorded and the run continues, because a partial result the
 * editor can use beats an error page.
 */

export interface RunPipelineOptions extends RunRequest {
  overrides?: AgentOverrides;
  signal?: AbortSignal;
  /** Re-analyse episodes that already have clips. */
  force?: boolean;
}

function emptyTierCounts(): Record<PriorityTier, number> {
  return PRIORITY_TIERS.reduce(
    (acc, tier) => {
      acc[tier] = 0;
      return acc;
    },
    {} as Record<PriorityTier, number>,
  );
}

/** Deduplicate candidates by video ID, keeping the first occurrence. */
function dedupeCandidates(candidates: EpisodeCandidate[]): EpisodeCandidate[] {
  const seen = new Set<string>();
  const unique: EpisodeCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.videoId)) continue;
    seen.add(candidate.videoId);
    unique.push(candidate);
  }

  return unique;
}

interface DiscoveryPhase {
  candidates: EpisodeCandidate[];
  searchQueries: string[];
  source: 'live' | 'demo';
  warnings: string[];
}

/**
 * PRD Step 1. Mode A expands the topic through the Discovery Agent first,
 * because a raw topic string is a poor YouTube query.
 */
async function runDiscovery(
  options: RunPipelineOptions,
  ledger: UsageLedger,
): Promise<DiscoveryPhase> {
  const maxEpisodes = options.maxEpisodes ?? config.pipeline.maxEpisodesPerRun;
  const warnings: string[] = [];

  if (options.mode === 'topic') {
    const topic = options.topic?.trim();
    if (!topic) {
      return { candidates: [], searchQueries: [], source: 'demo', warnings: ['No topic supplied.'] };
    }

    const plan = await planDiscovery({
      topic,
      overrides: options.overrides,
      ledger,
      signal: options.signal,
    });
    warnings.push(...plan.warnings);

    const queries = plan.plan.searchQueries;
    const perQuery = Math.max(4, Math.ceil(maxEpisodes / Math.max(1, queries.length)));

    const candidates: EpisodeCandidate[] = [];
    let source: 'live' | 'demo' = 'demo';

    for (const query of queries) {
      const outcome = await discoverByTopic({
        topic: query,
        maxResults: perQuery,
        publishedWithinDays: options.publishedWithinDays,
      });
      candidates.push(...outcome.candidates);
      // Any live query makes the run live; demo fallbacks are reported as warnings.
      if (outcome.source === 'live') source = 'live';
      warnings.push(...outcome.warnings);
    }

    return {
      candidates: dedupeCandidates(candidates).slice(0, maxEpisodes),
      searchQueries: queries,
      source,
      warnings: Array.from(new Set(warnings)),
    };
  }

  if (options.mode === 'tracked_channels') {
    const channelIds =
      options.channelIds && options.channelIds.length > 0
        ? options.channelIds
        : listTrackedChannels(true).map((tracked) => tracked.channelId);

    const outcome = await discoverFromChannels({
      channelIds,
      maxPerChannel: Math.max(2, Math.ceil(maxEpisodes / Math.max(1, channelIds.length))),
      publishedWithinDays: options.publishedWithinDays ?? 30,
    });

    for (const channelId of channelIds) {
      markTrackedChannelChecked(channelId);
    }

    return {
      candidates: dedupeCandidates(outcome.candidates).slice(0, maxEpisodes),
      searchQueries: [],
      source: outcome.source,
      warnings: [...warnings, ...outcome.warnings],
    };
  }

  // Mode C - archive mining.
  const channelId = options.channelIds?.[0];
  if (!channelId) {
    return {
      candidates: [],
      searchQueries: [],
      source: 'demo',
      warnings: ['Archive mining requires a channel.'],
    };
  }

  const outcome = await mineChannelArchive({ channelId, maxResults: maxEpisodes });
  return {
    candidates: dedupeCandidates(outcome.candidates).slice(0, maxEpisodes),
    searchQueries: [],
    source: outcome.source,
    warnings: [...warnings, ...outcome.warnings],
  };
}

export async function runPipeline(options: RunPipelineOptions): Promise<RunSummary> {
  const startedAt = new Date();
  const ledger = new UsageLedger();

  const topic = options.mode === 'topic' ? (options.topic?.trim() ?? null) : null;
  const episodeThreshold =
    options.episodeScoreThreshold ?? config.pipeline.episodeScoreThreshold;
  const clipThreshold = options.clipScoreThreshold ?? config.pipeline.clipScoreThreshold;

  const runId = createRun({
    mode: options.mode,
    topic,
    channelIds: options.channelIds ?? [],
    engine: config.ai.agents.clip_scoring.providerId ? 'llm' : 'heuristic',
    episodeThreshold,
    clipThreshold,
  });

  const warnings: string[] = [];
  const results: EpisodeAnalysisResult[] = [];
  const tierCounts = emptyTierCounts();
  let engine: ScoringEngineName = 'heuristic';

  try {
    /* ---------------------------------------------------------------- */
    /* Step 1 - discovery                                              */
    /* ---------------------------------------------------------------- */
    const discovery = await runDiscovery(options, ledger);
    warnings.push(...discovery.warnings);

    // Persist channel statistics so they are available to the UI and to future
    // opportunity scores without re-fetching.
    for (const candidate of discovery.candidates) {
      if (candidate.channel) upsertChannel(candidate.channel);
    }

    /* ---------------------------------------------------------------- */
    /* Step 2 - episode ranking and the cost gate                      */
    /* ---------------------------------------------------------------- */
    const triage = await triageEpisodes({
      candidates: discovery.candidates,
      topic,
      overrides: options.overrides,
      ledger,
      signal: options.signal,
    });
    warnings.push(...triage.warnings);

    const now = new Date();
    const ranked = discovery.candidates
      .map((candidate) => {
        const judgement = triage.judgements.get(candidate.videoId);
        return {
          candidate,
          opportunity: scoreEpisodeOpportunity(candidate, {
            topic,
            threshold: episodeThreshold,
            now,
            semantic: judgement
              ? {
                  topicFit: judgement.topicFit,
                  expectedClipDensity: judgement.expectedClipDensity,
                  isPodcastEpisode: judgement.isPodcastEpisode,
                  reason: judgement.reason,
                }
              : null,
          }),
        };
      })
      .sort((a, b) => b.opportunity.score - a.opportunity.score);

    for (const entry of ranked) {
      upsertDiscoveredEpisode({
        candidate: entry.candidate,
        opportunity: entry.opportunity,
        topic,
        runId,
      });
    }

    const eligible = ranked.filter((entry) => entry.opportunity.eligible);
    const alreadyAnalysed = options.force
      ? new Set<string>()
      : findAnalysedVideoIds(eligible.map((entry) => entry.candidate.videoId));

    const queue = eligible
      .filter((entry) => !alreadyAnalysed.has(entry.candidate.videoId))
      .slice(0, config.pipeline.maxEpisodesAnalysedPerRun);

    // Record everything we are not analysing, with the reason.
    for (const entry of ranked) {
      if (queue.includes(entry)) continue;

      const skipReason = entry.opportunity.eligible
        ? alreadyAnalysed.has(entry.candidate.videoId)
          ? 'Already analysed in an earlier run'
          : `Below the per-run analysis cap of ${config.pipeline.maxEpisodesAnalysedPerRun} episodes`
        : (entry.opportunity.skipReason ?? 'Did not clear the opportunity threshold');

      if (!entry.opportunity.eligible) {
        markEpisodeSkipped(entry.candidate.videoId, skipReason);
      }

      results.push({
        episode: entry.candidate,
        opportunity: entry.opportunity,
        analysed: false,
        skipReason,
        transcriptSource: null,
        segmentCount: 0,
        clips: [],
      });
    }

    /* ---------------------------------------------------------------- */
    /* Steps 3-8 - analyse the promoted episodes                       */
    /* ---------------------------------------------------------------- */
    let clipsFound = 0;

    for (const entry of queue) {
      const { candidate } = entry;

      try {
        const analysis = await analyzeEpisode({
          candidate,
          topic,
          clipScoreThreshold: clipThreshold,
          overrides: options.overrides,
          ledger,
          signal: options.signal,
        });

        warnings.push(...analysis.warnings);
        if (analysis.engine === 'llm') engine = 'llm';

        // Archive-tier clips are persisted too: they are the labelled dataset
        // the PRD identifies as the long-term moat.
        replaceClipsForEpisode(candidate.videoId, analysis.allClips, runId);

        markEpisodeAnalysed({
          videoId: candidate.videoId,
          transcriptSource: analysis.transcript.source,
          segmentCount: analysis.segments.length,
          clipCount: analysis.clips.length,
        });

        for (const clip of analysis.clips) {
          tierCounts[clip.tier] += 1;
        }
        clipsFound += analysis.clips.length;

        results.push({
          episode: candidate,
          opportunity: entry.opportunity,
          analysed: true,
          skipReason: null,
          transcriptSource: analysis.transcript.source,
          segmentCount: analysis.segments.length,
          clips: analysis.clips,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown analysis error';
        markEpisodeFailed(candidate.videoId, message);
        warnings.push(`${candidate.title}: ${message}`);

        results.push({
          episode: candidate,
          opportunity: entry.opportunity,
          analysed: false,
          skipReason: message,
          transcriptSource: null,
          segmentCount: 0,
          clips: [],
        });
      }
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const episodesSkipped = ranked.length - queue.length;
    const dedupedWarnings = Array.from(new Set(warnings));

    completeRun({
      runId,
      episodesDiscovered: ranked.length,
      episodesAnalysed: queue.length,
      episodesSkipped,
      clipsFound,
      warnings: dedupedWarnings,
      durationMs,
    });

    const usage = ledger.summary();

    return {
      runId,
      mode: options.mode,
      topic,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      engine,
      discoverySource: discovery.source,
      searchQueries: discovery.searchQueries,
      episodesDiscovered: ranked.length,
      episodesAnalysed: queue.length,
      episodesSkipped,
      clipsFound,
      tierCounts,
      aiUsage: {
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      warnings: dedupedWarnings,
      results: results.sort((a, b) => b.opportunity.score - a.opportunity.score),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    failRun(runId, error instanceof Error ? error.message : 'Unknown pipeline error', durationMs);
    throw error;
  }
}
