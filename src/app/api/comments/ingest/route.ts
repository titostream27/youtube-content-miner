import { z } from 'zod';
import { mineComments, persistCommentSignals } from '@/lib/analytics/comment-mining';
import { ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const IngestSchema = z.object({
  video_id: z.string().min(1),
  comments: z.array(z.string()).min(1),
});

/**
 * POST /api/comments/ingest
 *
 * Phase 3 (brief §31) — ingest a sample of YouTube comments and mine them for
 * timestamp mentions, repeated questions, quoted statements, objections,
 * controversy, follow-up topics and audience language.
 */
export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, IngestSchema);
  if (parsed.error) return parsed.error;

  const result = mineComments(parsed.data.video_id, parsed.data.comments);
  const inserted = persistCommentSignals(result);

  return ok({ ...result, signalsInserted: inserted });
}
