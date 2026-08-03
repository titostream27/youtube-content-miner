import { z } from 'zod';
import { listChannelProfiles, upsertChannelProfile } from '@/lib/db/repositories/channel-profiles';
import { ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const ProfileSchema = z.object({
  profile_id: z.string().min(1),
  name: z.string().optional(),
  preferred_duration_sec: z.tuple([z.number(), z.number()]).optional(),
  strong_categories: z.array(z.string()).optional(),
  weak_categories: z.array(z.string()).optional(),
  preferred_hook_types: z.array(z.string()).optional(),
  target_markets: z.array(z.string()).optional(),
});

/**
 * Phase 3 (Master Task Brief §28/§39):
 *   GET /api/channel-profiles            — list all profiles
 *   POST /api/channel-profiles           — upsert one profile
 */
export async function GET() {
  return ok({ profiles: listChannelProfiles() });
}

export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, ProfileSchema);
  if (parsed.error) return parsed.error;

  const profile = upsertChannelProfile({
    profileId: parsed.data.profile_id,
    name: parsed.data.name,
    preferredDurationSec: parsed.data.preferred_duration_sec,
    strongCategories: parsed.data.strong_categories,
    weakCategories: parsed.data.weak_categories,
    preferredHookTypes: parsed.data.preferred_hook_types,
    targetMarkets: parsed.data.target_markets,
  });

  return ok({ profile });
}
