import { getClip } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { analyzeSpeakers } from '@/lib/moments/speaker-intelligence';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/clips/:id/speakers
 *
 * Phase 4 (brief §34/§39) — speaker-aware analysis of the clip's transcript.
 * Requires diarized cues (speakerId present); falls back to a single
 * unknown speaker otherwise.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const transcript = getTranscript(clip.videoId);
  const cues = (transcript?.cues ?? []).filter(
    (cue) => cue.startSec >= clip.startSec && cue.startSec < clip.endSec,
  );

  const analysis = analyzeSpeakers(cues);

  return ok({
    clipId,
    diarized: analysis.diarized,
    standaloneSignal: analysis.standaloneSignal,
    guest: analysis.guestSpeaker
      ? { speakerId: analysis.guestSpeaker.speakerId, role: analysis.guestSpeaker.role, speechShare: analysis.guestSpeaker.speechShare, sampleText: analysis.guestSpeaker.sampleText }
      : null,
    host: analysis.hostSpeaker
      ? { speakerId: analysis.hostSpeaker.speakerId, role: analysis.hostSpeaker.role, speechShare: analysis.hostSpeaker.speechShare, questionsAsked: analysis.hostSpeaker.questionsAsked }
      : null,
    speakers: analysis.speakers.map((s) => ({
      speakerId: s.speakerId,
      role: s.role,
      cueCount: s.cueCount,
      words: s.words,
      speechShare: s.speechShare,
      questionsAsked: s.questionsAsked,
    })),
  });
}
