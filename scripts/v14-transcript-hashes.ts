/** V14 — emit canonical transcript hashes (same TS function as v14-census). */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getTranscript } from '../src/lib/db/repositories/transcripts';

function transcriptHash(transcript: { cues: unknown }): string {
  return createHash('sha256').update(JSON.stringify(transcript.cues)).digest('hex');
}

const EPISODES = [
  'I6wCuvvaRPI', 'GOqEl4ADyVk', '2HLGcRpw1hc', 'UZ1kCEGjYX0', 'Hb2rKGfIOrM',
  'g2cQ2kD6lzs', 'Ive926sC6mc', '3NSC5nps3OM', '376JmatmnaI', 'XuoqKYxDHVc',
  'LAmGfokvgzA', 'e1WM_JEmP-Q', 'hb7Oqrj3F3k', 'vs6x8VUGXCw',
];

const out: Record<string, string> = {};
for (const ep of EPISODES) {
  const t = getTranscript(ep);
  if (!t) {
    console.error(`no transcript ${ep}`);
    continue;
  }
  out[ep] = transcriptHash(t);
}
fs.writeFileSync('evidence/v14/transcript_hashes.json', JSON.stringify(out, null, 2), 'utf-8');
console.log(JSON.stringify(out, null, 1));