/**
 * Golden dataset ingest pipeline (hardening v3 F3) — transcript parsing.
 *
 * Converts common podcast transcript formats into the GoldenFixture
 * `transcriptCues` shape. Supported:
 *   - .srt  (SubRip with [HH:]MM:SS,mmm cues)
 *   - .vtt  (WebVTT; "WEBVTT" header + HH:MM:SS.mmm cues)
 *   - .txt  (plain text; timing is ESTIMATED from word count at a
 *            configurable speaking rate — mark captionsQuality='noisy'
 *            when you use estimated timing)
 *
 * Run: npx tsx scripts/golden/parse-transcript.ts <file> [--rate 2.7]
 */
import { readFileSync } from 'node:fs';

export interface ParsedCue {
  startSec: number;
  endSec: number;
  text: string;
}

const SRT_CUE_RE = /(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{1,3})/;

function hmsToSec(h: string, m: string, s: string, ms: string): number {
  const hh = h ? parseInt(h, 10) : 0;
  const mm = parseInt(m, 10);
  const ss = parseInt(s, 10);
  const milli = parseInt(ms.padEnd(3, '0'), 10);
  return hh * 3600 + mm * 60 + ss + milli / 1000;
}

/** Estimate seconds for `wordCount` words at a speaking rate (wps). */
export function estimateSeconds(wordCount: number, rate = 2.7): number {
  return Math.max(1.0, wordCount / rate);
}

export function parseSrt(content: string): ParsedCue[] {
  const cues: ParsedCue[] = [];
  const blocks = content.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const timeLine = lines.find((l) => SRT_CUE_RE.test(l));
    if (!timeLine) continue;
    const m = SRT_CUE_RE.exec(timeLine)!;
    const start = hmsToSec(m[1]!, m[2]!, m[3]!, m[4]!);
    const end = hmsToSec(m[5]!, m[6]!, m[7]!, m[8]!);
    // Subtitle text = everything between the time line and the next blank.
    const ti = lines.indexOf(timeLine);
    const text = lines.slice(ti + 1).filter(Boolean).join(' ').trim();
    if (text && end > start) {
      cues.push({ startSec: start, endSec: end, text });
    }
  }
  return cues;
}

const VTT_TIME_RE = /(\d{1,2}:)?(\d{2}):(\d{2})[.](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.](\d{1,3})/;

export function parseVtt(content: string): ParsedCue[] {
  const cues: ParsedCue[] = [];
  const lines = content.split(/\r?\n/);
  let pending: ParsedCue | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const m = VTT_TIME_RE.exec(line);
    if (m) {
      if (pending) cues.push(pending);
      pending = {
        startSec: hmsToSec(m[1]!, m[2]!, m[3]!, m[4]!),
        endSec: hmsToSec(m[5]!, m[6]!, m[7]!, m[8]!),
        text: '',
      };
      continue;
    }
    if (pending && line && line !== 'WEBVTT' && !line.startsWith('NOTE') && !line.startsWith('Kind:') && !line.startsWith('Language:')) {
      pending.text = [pending.text, line].filter(Boolean).join(' ').trim();
    }
  }
  if (pending) cues.push(pending);
  return cues.filter((c) => c.text && c.endSec > c.startSec);
}

/** Plain text: split into sentence-ish chunks, estimate timing per chunk. */
export function parsePlainText(content: string, rate = 2.7): ParsedCue[] {
  const sentences = content
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const cues: ParsedCue[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const words = s.split(/\s+/).length;
    const dur = estimateSeconds(words, rate);
    cues.push({ startSec: cursor, endSec: round2(cursor + dur), text: s });
    cursor += dur;
  }
  return cues;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseTranscriptFile(path: string, rate = 2.7): ParsedCue[] {
  const content = readFileSync(path, 'utf-8');
  const lower = path.toLowerCase();
  if (lower.endsWith('.srt')) return parseSrt(content);
  if (lower.endsWith('.vtt')) return parseVtt(content);
  if (lower.endsWith('.txt')) return parsePlainText(content, rate);
  // Default: sniff.
  if (content.trimStart().startsWith('WEBVTT')) return parseVtt(content);
  if (SRT_CUE_RE.test(content)) return parseSrt(content);
  return parsePlainText(content, rate);
}

// CLI entry
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const rateArg = process.argv.find((a) => a.startsWith('--rate='));
  const rate = rateArg ? parseFloat(rateArg.split('=')[1]!) : 2.7;
  if (!file || !existsSync(file)) {
    console.error('usage: npx tsx parse-transcript.ts <file.srt|.vtt|.txt> [--rate=2.7]');
    process.exit(2);
  }
  const cues = parseTranscriptFile(file, rate);
  console.log(JSON.stringify(cues, null, 2));
}
