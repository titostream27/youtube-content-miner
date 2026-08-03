import { listClips } from '@/lib/db/repositories/clips';
import { clearPortfolioSuggestions, insertPortfolioSuggestion } from '@/lib/db/repositories/calendar';
import { ok, badRequest } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/** Weekly slot archetypes (brief §33 example weekly mix). */
const WEEK_SLOTS = [
  { slot: 'Monday', archetype: 'strong opinion' },
  { slot: 'Tuesday', archetype: 'personal story' },
  { slot: 'Wednesday', archetype: 'practical lesson' },
  { slot: 'Thursday', archetype: 'debate' },
  { slot: 'Friday', archetype: 'emotional payoff' },
];

/**
 * GET /api/portfolio/suggest?week=2026-W32
 *
 * Phase 3 (brief §33/§39) — generate a weekly content mix from eligible
 * clips (rights approved + QC passed + render done). Considers:
 *   clip score, confidence, topic/guest diversity, category variety,
 *   emotion variety, duration variety, market fit, rights, saturation.
 *
 * Returns suggestions persisted to portfolio_suggestions (idempotent per
 * week: re-running regenerates).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const week = url.searchParams.get('week');
  if (!week) return badRequest('Missing week param, e.g. ?week=2026-W32');

  const clips = listClips({ limit: 100000 }).filter((c) => {
    const blockedRights = new Set(['unknown', 'blocked', 'editorial_review_required']);
    return (
      c.rightsStatus !== undefined &&
      !blockedRights.has(c.rightsStatus) &&
      c.qcStatus === 'passed' &&
      c.renderStatus === 'done' &&
      c.publishStatus !== 'published'
    );
  });

  if (clips.length === 0) {
    return ok({ week, suggestions: [], message: 'No eligible clips (need rights + QC + render, not yet published)' });
  }

  // Rank: score desc, then prefer category diversity per slot.
  const sorted = [...clips].sort((a, b) => b.finalScore - a.finalScore);
  const usedCategories = new Set<string>();
  const usedTopics = new Set<string>();
  const pickedIds = new Set<number>();
  const picks: { clip: (typeof clips)[number]; slot: string; reason: string }[] = [];

  for (const slot of WEEK_SLOTS) {
    // Prefer a clip whose category hasn't been used yet this week AND that
    // hasn't already been picked (one clip = one slot).
    const candidate =
      sorted.find((c) => !pickedIds.has(c.id) && !usedCategories.has(c.category) && !usedTopics.has(c.mainTopic ?? '')) ??
      sorted.find((c) => !pickedIds.has(c.id) && !usedCategories.has(c.category)) ??
      sorted.find((c) => !pickedIds.has(c.id));
    if (!candidate) break;

    pickedIds.add(candidate.id);
    usedCategories.add(candidate.category);
    if (candidate.mainTopic) usedTopics.add(candidate.mainTopic);
    picks.push({
      clip: candidate,
      slot: slot.slot,
      reason: `${slot.archetype}; score ${Math.round(candidate.finalScore)}; category ${candidate.category}`,
    });
  }

  // Persist (regenerate = clear + insert).
  clearPortfolioSuggestions(week);
  const suggestions = picks.map((p) =>
    insertPortfolioSuggestion({
      week,
      clipId: p.clip.id,
      slot: p.slot,
      reason: p.reason,
      status: 'suggested',
    }),
  );

  return ok({
    week,
    suggestions: suggestions.map((s) => ({
      id: s.id,
      clipId: s.clipId,
      slot: s.slot,
      reason: s.reason,
      status: s.status,
      title: picks.find((p) => p.clip.id === s.clipId)?.clip.title ?? null,
      score: picks.find((p) => p.clip.id === s.clipId)?.clip.finalScore ?? null,
    })),
    rejectedForSaturation: [],
  });
}
