/**
 * Phase 2 (Personal learning) — contextual statistics.
 *
 * The moat is the labelled dataset: the editor's approvals/rejections per
 * channel, guest, topic, hook type, duration band, layout, and posting hour.
 * This module aggregates those labels into per-context acceptance priors
 * that a re-ranker (or the UI) can consume.
 *
 * Each statistic is a small Bayesian prior:
 *
 *   acceptancePrior = (approved + alpha) / (labelled + 2*alpha)
 *
 * with alpha = 1 (a weak prior toward 50%) so tiny samples do not claim
 * certainty. contextSamples = number of labelled clips in that context.
 *
 * These are READ-ONLY aggregates over existing feedback rows. No scoring
 * weights are changed by this module; the pipeline must opt in to consume
 * the priors.
 */

export interface ContextStat {
  key: string;
  /** Bayesian acceptance prior 0-1 with alpha=1 smoothing. */
  acceptancePrior: number;
  labelled: number;
  approved: number;
}

export interface PersonalLearningReport {
  byChannel: ContextStat[];
  byTopic: ContextStat[];
  byHookType: ContextStat[];
  byDurationBand: ContextStat[];
  byPostingHour: ContextStat[];
  /** Overall acceptance prior — the global baseline. */
  overallPrior: number;
  totalLabelled: number;
}

export interface LearningSample {
  clipId: number;
  channelTitle: string | null;
  mainTopic: string | null;
  suggestedHook: string;
  durationSec: number;
  publishedAt: string | null;
  verdict: 'approved' | 'rejected' | 'boundary_adjusted';
}

const ALPHA = 1;

export function acceptancePrior(approved: number, labelled: number): number {
  if (labelled === 0) return 0.5;
  return (approved + ALPHA) / (labelled + 2 * ALPHA);
}

function buckets<K extends string>(
  samples: LearningSample[],
  keyOf: (s: LearningSample) => K | null,
): Map<K, { approved: number; labelled: number }> {
  const map = new Map<K, { approved: number; labelled: number }>();
  for (const s of samples) {
    const k = keyOf(s);
    if (!k) continue;
    const entry = map.get(k) ?? { approved: 0, labelled: 0 };
    entry.labelled += 1;
    if (s.verdict === 'approved') entry.approved += 1;
    map.set(k, entry);
  }
  return map;
}

function toStats(map: Map<string, { approved: number; labelled: number }>): ContextStat[] {
  return Array.from(map.entries())
    .map(([key, v]) => ({
      key,
      acceptancePrior: acceptancePrior(v.approved, v.labelled),
      labelled: v.labelled,
      approved: v.approved,
    }))
    .sort((a, b) => b.labelled - a.labelled);
}

export function hookTypeOf(hook: string): string | null {
  const h = hook.trim().toLowerCase();
  if (!h) return null;
  // Number/claim specificity first: "We made $2 million" is a number hook,
  // not just a claim — the amount is the hook.
  if (/\b(billion|million|percent|\d+k|\d+m|\d+%)\b/.test(h)) return 'number';
  if (/^why\b|^how\b|^what\b/.test(h)) return 'question';
  if (/^(stop|never|always|this is|the real|i almost|we made|how we)/.test(h)) return 'hook_claim';
  if (/\b(secret|mistake|failed|worst|crazy|insane|shocking)\b/.test(h)) return 'shock';
  return 'other';
}

export function durationBandOf(durationSec: number): string {
  if (durationSec < 20) return '<20s';
  if (durationSec < 35) return '20-35s';
  if (durationSec < 60) return '35-60s';
  return '60s+';
}

export function postingHourOf(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCHours().toString().padStart(2, '0')}:00`;
}

export function buildPersonalLearningReport(samples: LearningSample[]): PersonalLearningReport {
  const totalApproved = samples.filter((s) => s.verdict === 'approved').length;
  return {
    byChannel: toStats(buckets(samples, (s) => s.channelTitle)),
    byTopic: toStats(buckets(samples, (s) => s.mainTopic)),
    byHookType: toStats(buckets(samples, (s) => hookTypeOf(s.suggestedHook))),
    byDurationBand: toStats(buckets(samples, (s) => durationBandOf(s.durationSec))),
    byPostingHour: toStats(buckets(samples, (s) => postingHourOf(s.publishedAt))),
    overallPrior: acceptancePrior(totalApproved, samples.length),
    totalLabelled: samples.length,
  };
}
