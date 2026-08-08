/**
 * Brief V12R Phase C — Judge input contract builder.
 *
 * PRE / CANDIDATE / POST context is mandatory: a judge cannot detect a
 * mid-context start or next-topic leakage from candidate text alone. We give
 * ~20-30s of pre/post context (or fewer utterances when the transcript edge
 * is closer), normalised transcript text, and source evidence. Production
 * score/acceptance/ending-confidence are NEVER passed to the judge (R4).
 */
import type { Transcript } from '@/lib/domain/types';
import { cuesToUtterances, type Utterance } from '@/lib/moments/utterances';
import type { JudgeInputContract } from './judge-types';

export interface V12JudgeContextOptions {
  /** Max seconds of pre/post context. Default 30. */
  maxContextSec?: number;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function contextWindow(
  utterances: Utterance[],
  fromSec: number,
  toSec: number,
): { start_sec: number; end_sec: number; text: string } {
  const inside = utterances.filter((u) => u.endSec > fromSec && u.startSec < toSec);
  const text = normalize(inside.map((u) => u.text).join(' '));
  return {
    start_sec: Math.round(fromSec * 10) / 10,
    end_sec: Math.round(toSec * 10) / 10,
    text,
  };
}

export function buildJudgeInput(
  transcript: Transcript,
  window: { startSec: number; endSec: number },
  candidateId: string,
  opts: V12JudgeContextOptions = {},
): JudgeInputContract {
  const maxContextSec = opts.maxContextSec ?? 30;
  const utterances = cuesToUtterances(transcript.cues);

  const preFrom = Math.max(0, window.startSec - maxContextSec);
  const preTo = window.startSec;
  const postFrom = window.endSec;
  const postTo = window.endSec + maxContextSec;

  const candidateText = normalize(
    utterances
      .filter((u) => u.endSec > window.startSec && u.startSec < window.endSec)
      .map((u) => u.text)
      .join(' '),
  );

  // Source evidence (brief Phase C): speaker turns inside, pause features at
  // the boundaries, honest timing precision (all frozen-corpus transcripts
  // are cue-level, so this is 'cue' here).
  const insideUtterances = utterances.filter(
    (u) => u.endSec > window.startSec && u.startSec < window.endSec,
  );
  let speakerTurns = 0;
  let previousSpeaker: string | null = null;
  for (const u of insideUtterances) {
    if (u.speakerId !== null && previousSpeaker !== null && u.speakerId !== previousSpeaker) {
      speakerTurns += 1;
    }
    if (u.speakerId !== null) previousSpeaker = u.speakerId;
  }

  const last = insideUtterances[insideUtterances.length - 1];
  const first = insideUtterances[0];
  const afterEnd = utterances.find((u) => u.startSec >= window.endSec - 0.05);

  const pauseFeatures = {
    pause_before_first_sec: first ? Math.round(first.pauseBeforeSec * 10) / 10 : 0,
    pause_after_last_sec: last ? Math.round(last.pauseAfterSec * 10) / 10 : 0,
    speaker_change_after_end: Boolean(
      afterEnd && last && last.speakerId !== null && afterEnd.speakerId !== null && last.speakerId !== afterEnd.speakerId,
    ),
  };

  return {
    episode_id: transcript.videoId,
    candidate_id: candidateId,
    language: transcript.language || 'unknown',
    pre_context: contextWindow(utterances, preFrom, preTo),
    candidate: {
      start_sec: Math.round(window.startSec * 10) / 10,
      end_sec: Math.round(window.endSec * 10) / 10,
      duration_sec: Math.round((window.endSec - window.startSec) * 10) / 10,
      text: candidateText,
    },
    post_context: contextWindow(utterances, postFrom, postTo),
    source_evidence: {
      speaker_turns: speakerTurns,
      pause_features: pauseFeatures,
      timing_precision: 'cue',
    },
  };
}