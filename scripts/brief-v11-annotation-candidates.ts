import { config } from '../src/lib/config';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { detectMoments } from '../src/lib/moments/segmentation';

const VIDEO_IDS = [
  'I6wCuvvaRPI',
  'GOqEl4ADyVk',
  '2HLGcRpw1hc',
  'UZ1kCEGjYX0',
  'Hb2rKGfIOrM',
  'g2cQ2kD6lzs',
  'Ive926sC6mc',
  '3NSC5nps3OM',
  '376JmatmnaI',
  'XuoqKYxDHVc',
];

for (const videoId of VIDEO_IDS) {
  const transcript = getTranscript(videoId);
  if (!transcript) {
    process.stdout.write(`${JSON.stringify({ video_id: videoId, error: 'no transcript' })}\n`);
    continue;
  }
  const detection = detectMoments(transcript, {
    minDurationSec: config.pipeline.segment.minDurationSec,
    maxDurationSec: config.pipeline.segment.maxDurationSec,
    targetDurationSec: config.pipeline.segment.targetDurationSec,
    maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
  });
  const ranked = [...detection.segments].sort(
    (a, b) => b.salience - a.salience || a.startSec - b.startSec,
  );
  process.stdout.write(`${JSON.stringify({
    video_id: videoId,
    candidates: ranked.slice(0, 4).map((segment) => ({
      start_sec: segment.startSec,
      end_sec: segment.endSec,
      duration_sec: segment.durationSec,
      salience: segment.salience,
      text: segment.text,
    })),
  })}\n`);
}
