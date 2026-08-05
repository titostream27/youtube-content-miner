import type {
  EpisodeCandidate,
  EpisodeFactorKey,
  EpisodeFactorScores,
  EpisodeOpportunity,
} from '@/lib/domain/types';
import { EPISODE_FACTOR_LABELS, EPISODE_FACTOR_WEIGHTS } from './weights';
import { clamp, daysSince, logScale, piecewise, round, weightedAverage } from './normalize';
import { termCoverage } from './text';

/**
 * PRD Step 2 - Episode Opportunity Score.
 *
 * This runs BEFORE any transcript is fetched or any token is spent. It is the
 * cost gate of the whole product: a 3 hour episode costs real money to
 * transcribe and score, so we only pay for episodes that look like they hold
 * multiple publishable moments.
 *
 * Every factor is normalised to 0-100 and combined with the weights in
 * `weights.ts`. The factor breakdown is returned alongside the score so the UI
 * can explain exactly why an episode was promoted or skipped.
 */

export const DEFAULT_EPISODE_SCORE_THRESHOLD = 60;

/** Chapter markers such as "12:34 The turning point". */
const TIMESTAMP_MARKER = /(?:^|\n)\s*\(?(?:\d{1,2}:)?\d{1,2}:\d{2}\)?\s+\S/g;

/** Title conventions that signal a multi-person conversation. */
const GUEST_MARKERS =
  /\b(?:with|ft\.?|feat\.?|featuring|interview|conversation|w\/)\b|\|/i;

function countTimestampMarkers(description: string): number {
  const matches = description.match(TIMESTAMP_MARKER);
  return matches ? matches.length : 0;
}

/**
 * Topic relevance. Title matches are worth more than description matches
 * because podcast descriptions are full of sponsor copy and boilerplate.
 *
 * When there is no topic (Mode B / Mode C) relevance is not a meaningful
 * filter, so we return a neutral value rather than penalising the episode.
 */
function scoreTopicRelevance(candidate: EpisodeCandidate, topic: string | null): number {
  if (!topic || topic.trim().length === 0) return 72;

  const titleCoverage = termCoverage(topic, candidate.title);
  const tagCoverage = termCoverage(topic, candidate.tags.join(' '));
  // Sponsor blocks live at the bottom of descriptions; the top is the summary.
  const descriptionCoverage = termCoverage(topic, candidate.description.slice(0, 1200));
  const channelCoverage = termCoverage(topic, candidate.channelTitle);

  const composite =
    titleCoverage * 0.5 +
    descriptionCoverage * 0.24 +
    tagCoverage * 0.16 +
    channelCoverage * 0.1;

  // A full title match should reach the top of the scale, not 100% of a
  // weighted average that no real episode can max out.
  return clamp(composite * 135);
}

/**
 * Duration fit. Short uploads are usually Shorts or trailers, not episodes.
 * Long episodes are good: more raw material per discovery + transcript cost.
 */
function scoreDurationFit(durationSeconds: number): number {
  const minutes = durationSeconds / 60;
  return piecewise(minutes, [
    [0, 0],
    [3, 4],
    [8, 18],
    [15, 45],
    [25, 72],
    [40, 90],
    [60, 98],
    [90, 100],
    [180, 96],
    [300, 82],
  ]);
}

/**
 * Engagement. Comments are weighted 4x likes: a comment is a much stronger
 * signal that something in the episode was worth reacting to.
 */
function scoreEngagement(candidate: EpisodeCandidate): number {
  if (candidate.viewCount <= 0) return 25;
  const weightedInteractions = candidate.likeCount + candidate.commentCount * 4;
  const ratio = weightedInteractions / candidate.viewCount;
  // 1% weighted engagement is solid, 5%+ is exceptional.
  return piecewise(ratio * 100, [
    [0, 0],
    [0.2, 20],
    [0.5, 42],
    [1, 62],
    [2, 78],
    [3.5, 90],
    [5, 97],
    [8, 100],
  ]);
}

/** Views per day since publication, log scaled to absorb the long tail. */
function scoreViewVelocity(candidate: EpisodeCandidate, now: Date): number {
  const age = Math.max(1, daysSince(candidate.publishedAt, now));
  const viewsPerDay = candidate.viewCount / age;
  return logScale(viewsPerDay, 500, 50_000);
}

/** Freshness. Weighted lightly so archive mining still works. */
function scoreRecency(candidate: EpisodeCandidate, now: Date): number {
  const age = daysSince(candidate.publishedAt, now);
  return piecewise(age, [
    [0, 100],
    [3, 98],
    [7, 92],
    [14, 84],
    [30, 72],
    [90, 55],
    [180, 44],
    [365, 34],
    [1095, 22],
  ]);
}

/**
 * Channel quality. Subscribers plus average views per video, so a small
 * channel with genuinely engaged viewers is not buried by a large dormant one.
 */
function scoreChannelQuality(candidate: EpisodeCandidate): number {
  const channel = candidate.channel;
  if (!channel) {
    // No channel stats available - infer from the episode's own reach.
    return clamp(logScale(candidate.viewCount, 5_000, 1_000_000) * 0.8);
  }

  const subscriberScore = logScale(channel.subscriberCount ?? 0, 25_000, 5_000_000);
  const averageViews =
    channel.viewCount && channel.videoCount && channel.videoCount > 0
      ? channel.viewCount / channel.videoCount
      : 0;
  const consistencyScore = logScale(averageViews, 10_000, 1_000_000);
  const catalogueScore = logScale(channel.videoCount ?? 0, 50, 1_000);

  return clamp(subscriberScore * 0.5 + consistencyScore * 0.35 + catalogueScore * 0.15);
}

/**
 * Discussion density - how much distinct conversation is packed into the
 * episode. Before we have a transcript we proxy it with:
 *  - chapter markers in the description (many chapters = many topics)
 *  - guest markers in the title (a conversation, not a monologue)
 *  - comments per 1000 views (viewers reacting to specific moments)
 */
function scoreDiscussionDensity(candidate: EpisodeCandidate): number {
  const hours = Math.max(0.1, candidate.durationSeconds / 3600);
  const chapters = countTimestampMarkers(candidate.description);
  const chaptersPerHour = chapters / hours;

  const chapterScore = piecewise(chaptersPerHour, [
    [0, 34],
    [2, 55],
    [4, 72],
    [7, 88],
    [12, 100],
  ]);

  const hasGuest = GUEST_MARKERS.test(candidate.title);
  const conversationScore = hasGuest ? 82 : 58;

  const commentsPerThousandViews =
    candidate.viewCount > 0 ? (candidate.commentCount / candidate.viewCount) * 1000 : 0;
  const reactionScore = piecewise(commentsPerThousandViews, [
    [0, 20],
    [1, 45],
    [3, 65],
    [6, 82],
    [12, 95],
    [20, 100],
  ]);

  return clamp(chapterScore * 0.4 + conversationScore * 0.3 + reactionScore * 0.3);
}

/**
 * Expected clip density - our prior on how many publishable moments per hour
 * this episode will yield. It is a derived factor: dense, relevant, engaging
 * conversation of the right length produces more clips.
 */
function scoreExpectedClipDensity(
  durationSeconds: number,
  discussionDensity: number,
  engagement: number,
  topicRelevance: number,
): number {
  const hours = durationSeconds / 3600;
  // Empirical prior: ~3 publishable moments per hour of dense conversation.
  const clipsPerHour = 1 + (discussionDensity / 100) * 3.5;
  const expectedClips = clipsPerHour * hours;

  const volumeScore = piecewise(expectedClips, [
    [0, 0],
    [1, 30],
    [2, 52],
    [4, 74],
    [7, 90],
    [12, 100],
  ]);

  // Quality prior: volume alone is worthless if the material is weak.
  const qualityPrior = (engagement * 0.5 + topicRelevance * 0.5) / 100;
  return clamp(volumeScore * (0.55 + 0.45 * qualityPrior));
}

/**
 * Phase 2 (Opportunity scoring) — Channel-relative velocity.
 *
 * Absolute view velocity favours big channels: a 100k-view episode is
 * unremarkable for a 5M-subscriber channel but exceptional for a 20k one.
 * Divide the episode's views-per-day by the channel's average views-per-day
 * so we measure the episode against its OWN channel's baseline.
 */
function scoreChannelRelativeVelocity(candidate: EpisodeCandidate, now: Date): number {
  const age = Math.max(1, daysSince(candidate.publishedAt, now));
  const episodeViewsPerDay = candidate.viewCount / age;
  const channel = candidate.channel;
  if (!channel || !channel.videoCount || channel.videoCount <= 0) {
    // No channel baseline: fall back to neutral (not a penalty).
    return 55;
  }
  const channelAgeDays = Math.max(1, daysSince(candidate.publishedAt, now));
  const avgViewsPerDay =
    channel.viewCount && channelAgeDays > 0 ? channel.viewCount / channelAgeDays / channel.videoCount : 0;
  if (avgViewsPerDay <= 0) return 55;
  const ratio = episodeViewsPerDay / avgViewsPerDay;
  // ratio 0.5x = baseline, 1x = on-channel, 3x+ = exceptional outlier.
  return clamp(piecewise(ratio, [
    [0, 20],
    [0.5, 45],
    [1, 62],
    [2, 80],
    [3.5, 92],
    [6, 100],
  ]));
}

/**
 * Phase 2 (Opportunity scoring) — Momentum.
 *
 * A proxy for acceleration without historical view series: comment velocity
 * relative to view velocity. Comments lag views (viewers finish the episode
 * before commenting), so a HIGH comments-per-1000-views on a RECENT episode
 * suggests the conversation is still building — the episode is accelerating,
 * not decaying.
 */
function scoreMomentum(candidate: EpisodeCandidate, now: Date): number {
  const age = Math.max(1, daysSince(candidate.publishedAt, now));
  if (candidate.viewCount <= 0) return 40;
  const commentsPerDay = candidate.commentCount / age;
  const viewsPerDay = candidate.viewCount / age;
  const commentRatio = commentsPerDay / Math.max(1, viewsPerDay); // comments per view
  // Decay: momentum means "still hot NOW" — freshness multiplies the signal.
  const freshness = Math.max(0.35, 1 - age / 60);
  const momentum = commentRatio * 1000 * freshness;
  return clamp(piecewise(momentum, [
    [0, 35],
    [1, 55],
    [2.5, 70],
    [5, 84],
    [10, 95],
    [18, 100],
  ]));
}

/**
 * Phase 2 (Opportunity scoring) — Personal fit.
 *
 * The user's own content preferences (topics they cover / watch). Without a
 * profile we return neutral so cold-start discovery is not penalised.
 */
function scorePersonalFit(
  candidate: EpisodeCandidate,
  topic: string | null,
  personalTopics: readonly string[],
): number {
  if (personalTopics.length === 0) return 60;
  const haystack = `${candidate.title} ${candidate.description.slice(0, 800)} ${candidate.channelTitle}`;
  let best = 0;
  for (const t of personalTopics) {
    if (!t.trim()) continue;
    best = Math.max(best, termCoverage(t, haystack));
  }
  if (best <= 0) return 35;
  // Scale so a strong keyword overlap lands mid-high; full match is rare.
  return clamp(best * 130);
}

/**
 * Phase 2 (Opportunity scoring) — Processing cost efficiency.
 *
 * Every minute of a long episode costs real transcription/scoring tokens.
 * All else equal, a dense 45-minute episode is a better buy than a 3-hour
 * one. Longer episodes are still allowed (they can hold more clips) but the
 * per-minute cost pressure should be visible.
 */
function scoreProcessingCostEfficiency(durationSeconds: number): number {
  const minutes = durationSeconds / 60;
  // Sweet spot 25-75 min; very long episodes pay a cost penalty.
  return piecewise(minutes, [
    [0, 20],
    [10, 62],
    [25, 85],
    [45, 95],
    [75, 88],
    [120, 70],
    [180, 52],
    [300, 35],
  ]);
}

/**
 * Build the human readable explanation. We surface the factors that moved the
 * score furthest from neutral, in both directions, because "why was this
 * skipped" is as important to the user as "why was this picked".
 */
function buildReasons(factors: EpisodeFactorScores): string[] {
  const neutral = 55;
  const ranked = (Object.keys(factors) as EpisodeFactorKey[])
    .map((key) => ({
      key,
      score: factors[key],
      impact: (factors[key] - neutral) * EPISODE_FACTOR_WEIGHTS[key],
    }))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  return ranked.slice(0, 4).map(({ key, score, impact }) => {
    const label = EPISODE_FACTOR_LABELS[key];
    const direction = impact >= 0 ? 'strong' : 'weak';
    return `${direction === 'strong' ? '+' : '-'} ${label}: ${round(score)}/100`;
  });
}

/**
 * Optional semantic judgement from the Episode Triage Agent.
 *
 * Blended in rather than substituted: the deterministic factors keep the
 * majority weight so a hallucinated 95 cannot promote a junk episode on its
 * own, and a provider outage changes the ranking slightly instead of stopping
 * the pipeline.
 */
export interface EpisodeSemanticJudgement {
  topicFit: number;
  expectedClipDensity: number;
  isPodcastEpisode: boolean;
  reason?: string;
}

/** Deterministic share of each blended factor. */
const DETERMINISTIC_WEIGHT = 0.55;

function blend(deterministic: number, semantic: number): number {
  return deterministic * DETERMINISTIC_WEIGHT + semantic * (1 - DETERMINISTIC_WEIGHT);
}

export interface EpisodeOpportunityOptions {
  topic?: string | null;
  threshold?: number;
  now?: Date;
  semantic?: EpisodeSemanticJudgement | null;
  /** Phase 2: user's personal content preferences (topics they cover). */
  personalTopics?: readonly string[];
}

export function scoreEpisodeOpportunity(
  candidate: EpisodeCandidate,
  options: EpisodeOpportunityOptions = {},
): EpisodeOpportunity {
  const {
    topic = null,
    threshold = DEFAULT_EPISODE_SCORE_THRESHOLD,
    now = new Date(),
    semantic = null,
    personalTopics = [],
  } = options;

  const topicRelevance = scoreTopicRelevance(candidate, topic);
  const durationFit = scoreDurationFit(candidate.durationSeconds);
  const engagement = scoreEngagement(candidate);
  const viewVelocity = scoreViewVelocity(candidate, now);
  const recency = scoreRecency(candidate, now);
  const channelQuality = scoreChannelQuality(candidate);
  const discussionDensity = scoreDiscussionDensity(candidate);
  const expectedClipDensity = scoreExpectedClipDensity(
    candidate.durationSeconds,
    discussionDensity,
    engagement,
    topicRelevance,
  );
  // Phase 2 (Opportunity scoring): channel-relative + economic factors.
  const channelRelativeVelocity = scoreChannelRelativeVelocity(candidate, now);
  const momentum = scoreMomentum(candidate, now);
  const personalFit = scorePersonalFit(candidate, topic, personalTopics);
  const processingCostEfficiency = scoreProcessingCostEfficiency(candidate.durationSeconds);

  const factors: EpisodeFactorScores = {
    topicRelevance: round(
      semantic ? blend(topicRelevance, semantic.topicFit) : topicRelevance,
      1,
    ),
    durationFit: round(durationFit, 1),
    engagement: round(engagement, 1),
    viewVelocity: round(viewVelocity, 1),
    recency: round(recency, 1),
    channelQuality: round(channelQuality, 1),
    discussionDensity: round(discussionDensity, 1),
    expectedClipDensity: round(
      semantic ? blend(expectedClipDensity, semantic.expectedClipDensity) : expectedClipDensity,
      1,
    ),
    channelRelativeVelocity: round(channelRelativeVelocity, 1),
    momentum: round(momentum, 1),
    personalFit: round(personalFit, 1),
    processingCostEfficiency: round(processingCostEfficiency, 1),
  };

  let score = weightedAverage(factors, EPISODE_FACTOR_WEIGHTS);

  // Hard disqualifiers. These are not "low scores", they are structural: no
  // amount of engagement makes a 90 second upload a podcast episode.
  let skipReason: string | null = null;
  if (candidate.durationSeconds < 8 * 60) {
    score = Math.min(score, 28);
    skipReason = 'Too short to be a podcast episode (under 8 minutes)';
  } else if (semantic && !semantic.isPodcastEpisode) {
    // "This is not a conversational episode" is a categorical judgement that
    // metadata heuristics genuinely cannot make, so the agent is decisive here.
    score = Math.min(score, 30);
    skipReason = semantic.reason?.trim()
      ? `Not a podcast episode: ${semantic.reason.trim()}`
      : 'Not a podcast episode (trailer, compilation or re-upload)';
  } else if (topic && factors.topicRelevance < 18) {
    score = Math.min(score, 42);
    skipReason = `No meaningful match for "${topic}"`;
  }

  const finalScore = round(clamp(score));
  const eligible = finalScore >= threshold && skipReason === null;

  if (!eligible && skipReason === null) {
    skipReason = `Opportunity score ${finalScore} is below the ${threshold} analysis threshold`;
  }

  return {
    score: finalScore,
    factors,
    reasons: buildReasons(factors),
    eligible,
    skipReason: eligible ? null : skipReason,
  };
}

/** Exposed for the UI so it can render the same curve used for gating. */
export const episodeFactorHelp: Record<EpisodeFactorKey, string> = {
  topicRelevance: 'How closely the title, tags and description match the requested topic.',
  durationFit: 'Long-form conversation scores highest; Shorts and trailers score near zero.',
  engagement: 'Likes and comments relative to views. Comments count 4x.',
  viewVelocity: 'Views per day since upload, log scaled.',
  recency: 'Freshness. Weighted lightly so strong archive episodes still surface.',
  channelQuality: 'Subscribers plus average views per video and catalogue depth.',
  discussionDensity: 'Chapter markers, guest format and comment rate as a proxy for topic variety.',
  expectedClipDensity: 'Derived prior on how many publishable moments this episode should yield.',
  channelRelativeVelocity: 'Views per day relative to the channel\u2019s own average — an outlier for a small channel is a stronger signal than a normal day for a big one.',
  momentum: 'Comment velocity scaled by freshness as a proxy for whether the episode is still accelerating.',
  personalFit: 'How closely the episode matches your own content preferences (topics you cover/watch).',
  processingCostEfficiency: 'Per-minute transcription/scoring cost pressure; dense mid-length episodes are cheaper buys.',
};
