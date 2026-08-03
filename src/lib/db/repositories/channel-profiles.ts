import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 3 (Master Task Brief §28) — channel-specific scoring profiles.
 * Profile adjusts ranking WITHOUT weakening universal gates (clarity,
 * standalone, complete ending, rights stay universal).
 */

export interface ChannelProfile {
  id: number;
  profileId: string;
  name: string | null;
  preferredDurationSec: [number, number] | null;
  strongCategories: string[];
  weakCategories: string[];
  preferredHookTypes: string[];
  targetMarkets: string[];
  active: boolean;
}

interface Row {
  id: number;
  profile_id: string;
  name: string | null;
  preferred_duration_sec: string | null;
  strong_categories: string;
  weak_categories: string;
  preferred_hook_types: string;
  target_markets: string;
  active: number;
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseDuration(s: string | null | undefined): [number, number] | null {
  const arr = parseJsonArray(s).map(Number);
  const lo = arr[0];
  const hi = arr[1];
  if (lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi)) {
    return [lo, hi];
  }
  return null;
}

function mapRow(r: Row): ChannelProfile {
  return {
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    preferredDurationSec: parseDuration(r.preferred_duration_sec),
    strongCategories: parseJsonArray(r.strong_categories),
    weakCategories: parseJsonArray(r.weak_categories),
    preferredHookTypes: parseJsonArray(r.preferred_hook_types),
    targetMarkets: parseJsonArray(r.target_markets),
    active: r.active === 1,
  };
}

export interface ChannelProfileInput {
  profileId: string;
  name?: string;
  preferredDurationSec?: [number, number];
  strongCategories?: string[];
  weakCategories?: string[];
  preferredHookTypes?: string[];
  targetMarkets?: string[];
}

export function upsertChannelProfile(input: ChannelProfileInput): ChannelProfile {
  const now = nowIso();
  const existing = getDb()
    .prepare('SELECT id FROM channel_profiles WHERE profile_id = ?')
    .get(input.profileId) as { id: number } | undefined;

  const params = {
    profileId: input.profileId,
    name: input.name ?? null,
    preferredDurationSec: input.preferredDurationSec ? JSON.stringify(input.preferredDurationSec) : null,
    strongCategories: JSON.stringify(input.strongCategories ?? []),
    weakCategories: JSON.stringify(input.weakCategories ?? []),
    preferredHookTypes: JSON.stringify(input.preferredHookTypes ?? []),
    targetMarkets: JSON.stringify(input.targetMarkets ?? []),
    now,
  };

  if (existing) {
    getDb()
      .prepare(
        `UPDATE channel_profiles SET name=@name, preferred_duration_sec=@preferredDurationSec,
           strong_categories=@strongCategories, weak_categories=@weakCategories,
           preferred_hook_types=@preferredHookTypes, target_markets=@targetMarkets,
           updated_at=@now WHERE profile_id=@profileId`,
      )
      .run(params);
  } else {
    getDb()
      .prepare(
        `INSERT INTO channel_profiles (profile_id, name, preferred_duration_sec, strong_categories,
           weak_categories, preferred_hook_types, target_markets, active, created_at, updated_at)
         VALUES (@profileId, @name, @preferredDurationSec, @strongCategories,
           @weakCategories, @preferredHookTypes, @targetMarkets, 1, @now, @now)`,
      )
      .run(params);
  }

  const row = getDb().prepare('SELECT * FROM channel_profiles WHERE profile_id = ?').get(input.profileId) as Row;
  return mapRow(row);
}

export function listChannelProfiles(): ChannelProfile[] {
  const rows = getDb().prepare('SELECT * FROM channel_profiles ORDER BY id').all() as Row[];
  return rows.map(mapRow);
}

export function getChannelProfile(profileId: string): ChannelProfile | null {
  const row = getDb().prepare('SELECT * FROM channel_profiles WHERE profile_id = ?').get(profileId) as Row | undefined;
  return row ? mapRow(row) : null;
}

export interface ProfileAdjustment {
  /** 0..100 adjustment added to the universal score. */
  adjustment: number;
  reasons: string[];
}

/**
 * Compute the channel-profile adjustment for a clip (brief §28 formula):
 *   universal score + channel preference + market fit + recent performance
 *   - saturation penalty.
 * Universal gates are NOT touched here — this only nudges ranking.
 */
export function applyChannelProfileAdjustment(
  profile: ChannelProfile,
  clip: {
    category?: string;
    durationSec?: number;
    hook?: string;
    market?: string;
    recentlyPublishedSimilar?: boolean;
  },
): ProfileAdjustment {
  let adjustment = 0;
  const reasons: string[] = [];

  // Strong / weak categories.
  if (clip.category && profile.strongCategories.some((c) => c.toLowerCase() === clip.category!.toLowerCase())) {
    adjustment += 6;
    reasons.push(`strong category ${clip.category}`);
  }
  if (clip.category && profile.weakCategories.some((c) => c.toLowerCase() === clip.category!.toLowerCase())) {
    adjustment -= 6;
    reasons.push(`weak category ${clip.category}`);
  }

  // Preferred duration.
  if (clip.durationSec && profile.preferredDurationSec) {
    const [lo, hi] = profile.preferredDurationSec;
    if (clip.durationSec >= lo && clip.durationSec <= hi) {
      adjustment += 4;
      reasons.push(`preferred duration ${clip.durationSec}s`);
    } else if (clip.durationSec < lo) {
      adjustment -= 2;
      reasons.push(`below preferred duration`);
    } else {
      adjustment -= 3;
      reasons.push(`above preferred duration`);
    }
  }

  // Preferred hook types (substring match on hook text).
  if (clip.hook) {
    const h = clip.hook.toLowerCase();
    if (profile.preferredHookTypes.some((t) => h.includes(t.toLowerCase()))) {
      adjustment += 3;
      reasons.push('preferred hook type');
    }
  }

  // Market fit.
  if (clip.market && profile.targetMarkets.some((m) => m.toLowerCase() === clip.market!.toLowerCase())) {
    adjustment += 3;
    reasons.push(`target market ${clip.market}`);
  }

  // Recent saturation penalty (brief §32).
  if (clip.recentlyPublishedSimilar) {
    adjustment -= 10;
    reasons.push('recent saturation');
  }

  return { adjustment: Math.max(-20, Math.min(20, adjustment)), reasons };
}
