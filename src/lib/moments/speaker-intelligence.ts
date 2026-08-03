import type { TranscriptCue } from '@/lib/domain/types';

/**
 * Phase 4 (Master Task Brief §34) — speaker-aware transcript intelligence.
 *
 * A diarized transcript (speakerId per cue) enables:
 *   - better standalone judgement (a host question vs guest answer)
 *   - better quote attribution
 *   - speaker-aware scoring (guest-driven clips score differently)
 *   - renderer speaker hints + better split-screen planning
 *
 * This module is deterministic: it derives speaker role heuristics from cue
 * patterns (question asker = likely host) without needing an external model.
 */

export interface SpeakerProfile {
  speakerId: string;
  role: 'host' | 'guest' | 'unknown';
  cueCount: number;
  words: number;
  /** Share of the clip's speech (0..1). */
  speechShare: number;
  /** Number of questions this speaker asked (host heuristic). */
  questionsAsked: number;
  /** Number of substantive answers (>= 8 words, not a question). */
  answersGiven: number;
  /** Sample of the speaker's words for name resolution later. */
  sampleText: string;
}

export interface SpeakerAnalysis {
  speakers: SpeakerProfile[];
  /** True when at least two distinct speakers were detected. */
  diarized: boolean;
  /** The guest speaker (largest non-question share) or null. */
  guestSpeaker: SpeakerProfile | null;
  /** The host speaker (most questions asked) or null. */
  hostSpeaker: SpeakerProfile | null;
  /** Clip standalone bonus: 0..1 based on whether content is guest-driven. */
  standaloneSignal: number;
}

const QUESTION_RE = /\b(how|what|why|when|where|who|is there|can you|do you|should|does|berapa|bagaimana|kenapa|apa|siapa|kapan)\b.*\?/i;
const FILLER_RE = /^(um|uh|er|ah|yeah|okay|right|so|jadi|ya)\b/i;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isQuestion(text: string): boolean {
  return QUESTION_RE.test(text);
}

/** Cluster cues by speakerId. Cues without a speaker go to 'speaker_unknown'. */
export function analyzeSpeakers(cues: readonly TranscriptCue[]): SpeakerAnalysis {
  const bySpeaker = new Map<string, { cueCount: number; words: number; questions: number; sample: string[] }>();

  for (const cue of cues) {
    const sid = cue.speakerId || 'speaker_unknown';
    const bucket = bySpeaker.get(sid) ?? { cueCount: 0, words: 0, questions: 0, sample: [] };
    bucket.cueCount += 1;
    bucket.words += countWords(cue.text);
    if (isQuestion(cue.text)) bucket.questions += 1;
    if (bucket.sample.length < 3 && cue.text.trim().length > 10 && !FILLER_RE.test(cue.text.trim())) {
      bucket.sample.push(cue.text.trim().slice(0, 80));
    }
    bySpeaker.set(sid, bucket);
  }

  const totalWords = Math.max(1, [...bySpeaker.values()].reduce((a, b) => a + b.words, 0));
  const speakers: SpeakerProfile[] = [...bySpeaker.entries()].map(([speakerId, b]) => {
    // Role heuristic: most questions asked => host; else guest if substantial.
    const role: SpeakerProfile['role'] = b.questions >= 2 && b.questions / Math.max(1, b.cueCount) > 0.25 ? 'host' : b.words > 20 ? 'guest' : 'unknown';
    return {
      speakerId,
      role,
      cueCount: b.cueCount,
      words: b.words,
      speechShare: Math.round((b.words / totalWords) * 100) / 100,
      questionsAsked: b.questions,
      answersGiven: b.cueCount - b.questions,
      sampleText: b.sample.join(' '),
    };
  }).sort((a, b) => b.words - a.words);

  const diarized = speakers.some((s) => s.speakerId !== 'speaker_unknown');

  const byQuestions = [...speakers].sort((a, b) => b.questionsAsked - a.questionsAsked);
  const topQuestioner = byQuestions[0];
  const hostSpeaker = topQuestioner && topQuestioner.questionsAsked > 0 ? topQuestioner : null;
  const guestSpeaker = [...speakers].filter((s) => s.role === 'guest').sort((a, b) => b.words - a.words)[0] ?? null;

  // Standalone bonus: guest-driven clips (a guest carries the content) are
  // more standalone than host monologues.
  const guestShare = guestSpeaker ? guestSpeaker.speechShare : 0;
  const hostShare = hostSpeaker ? hostSpeaker.speechShare : 0;
  const standaloneSignal = diarized
    ? Math.min(1, 0.5 + guestShare * 0.6 - Math.max(0, hostShare - 0.6) * 0.5)
    : 0.5;

  return { speakers, diarized, guestSpeaker, hostSpeaker, standaloneSignal };
}

/** Return speaker hint payload for the renderer (brief §34 example). */
export function speakerHintForRenderer(speaker: SpeakerProfile): {
  speaker_id: string;
  speaker_role: string;
  speaker_name: string | null;
} {
  return {
    speaker_id: speaker.speakerId,
    speaker_role: speaker.role,
    speaker_name: null, // name resolution requires external metadata
  };
}
