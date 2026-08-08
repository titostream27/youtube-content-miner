/** Brief v11 closure G1 — fetch transcripts for additional real episodes. */
import { resolveTranscript } from '../src/lib/transcript';
import type { EpisodeCandidate } from '../src/lib/domain/types';

const EPISODES: { id: string; title: string; note: string }[] = [
  { id: '3NSC5nps3OM', title: 'Raditya Dika — Cerita Cinta Idgitaf', note: 'Indonesian, two-person' },
  { id: '0kbiBpff7O0', title: 'Raditya Dika — Ada Sheila Dara dari Sore', note: 'Indonesian, two-person' },
  { id: 'FQmdrv3cO6A', title: 'Raditya Dika — Pada Suatu Hari ada Maudy Ayunda', note: 'Indonesian, two-person' },
  { id: 'rg5OqMu00m0', title: 'Raditya Dika — Saya Penggemar Rich Brian', note: 'Indonesian, two-person' },
];

function stubCandidate(id: string, title: string): EpisodeCandidate {
  return {
    videoId: id, title, description: '', channelId: 'unknown', channelTitle: 'unknown',
    publishedAt: new Date().toISOString(), durationSeconds: 3600,
    viewCount: 0, likeCount: 0, commentCount: 0, thumbnailUrl: null,
    tags: [], hasCaptions: null, license: null, embeddable: null, channel: null,
  };
}

async function main() {
  for (const e of EPISODES) {
    try {
      const r = await resolveTranscript({ candidate: stubCandidate(e.id, e.title), forceRefresh: true });
      console.log(JSON.stringify({
        episodeId: e.id, ok: true, note: e.note,
        source: r.transcript.source, language: r.transcript.language,
        cues: r.transcript.cues.length, words: r.transcript.wordCount,
        durationSec: r.transcript.durationSec,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        episodeId: e.id, ok: false, note: e.note,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
}

void main();