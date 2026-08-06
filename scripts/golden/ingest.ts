/**
 * Golden dataset ingest pipeline (hardening v3 F3) — batch ingest.
 *
 * Reads a folder of podcast transcript files (.srt/.vtt/.txt), parses each
 * into transcriptCues, and writes a DRAFT fixture JSON per episode under
 * golden-data/<id>.draft.json plus a labels TSV skeleton ready for human
 * review.
 *
 * Run:
 *   npx tsx scripts/golden/ingest.ts <inputDir> <outDir> \
 *        [--lang en|id] [--quality clean|noisy] [--rate=2.7]
 *
 * The draft has NO labels yet — a human (approved editor) fills
 * golden-data/<id>.labels.tsv (clipId<TAB>start<TAB>end<TAB>score<TAB>
 * contamination<TAB>startComplete<TAB>endingComplete), one labeled window per
 * line. `build.ts` then merges draft + labels into the final fixture.
 */
import { readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscriptFile, type ParsedCue } from './parse-transcript';

export interface DraftFixture {
  id: string;
  sourceFile: string;
  language?: 'en' | 'id';
  captionsQuality?: 'clean' | 'noisy';
  transcriptCues: ParsedCue[];
  labelColumns: string[];
}

export function buildDraft(
  id: string,
  sourceFile: string,
  cues: ParsedCue[],
  opts: { language?: string; quality?: string },
): DraftFixture {
  return {
    id,
    sourceFile,
    language: opts.language === 'id' ? 'id' : opts.language === 'en' ? 'en' : undefined,
    captionsQuality: opts.quality === 'noisy' ? 'noisy' : opts.quality === 'clean' ? 'clean' : undefined,
    transcriptCues: cues,
    labelColumns: ['clipId', 'startSec', 'endSec', 'score', 'contamination', 'startComplete', 'endingComplete'],
  };
}

export function labelsSkeleton(id: string, cues: ParsedCue[]): string {
  const header = 'clipId\tstartSec\tendSec\tscore\tcontamination\tstartComplete\tendingComplete';
  const rows = cues.map((c, i) =>
    [`${id}_c${i + 1}`, c.startSec, c.endSec, '', '0', '', ''].join('\t'),
  );
  return [header, ...rows].join('\n');
}

function normalizeId(fileName: string): string {
  return basename(fileName, extname(fileName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputDir = process.argv[2];
  const outDir = process.argv[3] || 'golden-data';
  const langArg = process.argv.find((a) => a.startsWith('--lang='));
  const qualityArg = process.argv.find((a) => a.startsWith('--quality='));
  const rateArg = process.argv.find((a) => a.startsWith('--rate='));
  const language = langArg ? langArg.split('=')[1] : 'en';
  const quality = qualityArg ? qualityArg.split('=')[1] : 'noisy';
  const rate = rateArg ? parseFloat(rateArg.split('=')[1]!) : 2.7;

  if (!inputDir || !existsSync(inputDir)) {
    console.error('usage: npx tsx scripts/golden/ingest.ts <inputDir> <outDir> [--lang=en|id] [--quality=clean|noisy] [--rate=2.7]');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inputDir)
    .filter((f) => /\.(srt|vtt|txt)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.warn(`no .srt/.vtt/.txt files in ${inputDir}`);
    process.exit(0);
  }
  console.log(`ingesting ${files.length} transcript(s) → ${outDir}`);
  for (const f of files) {
    const full = join(inputDir, f);
    const cues = parseTranscriptFile(full, rate);
    const id = normalizeId(f);
    const draft = buildDraft(id, full, cues, { language, quality });
    writeFileSync(join(outDir, `${id}.draft.json`), JSON.stringify(draft, null, 2));
    writeFileSync(join(outDir, `${id}.labels.tsv`), labelsSkeleton(id, cues));
    console.log(`  → ${id} (${cues.length} cues) draft + label skeleton`);
  }
  console.log('fill the labels.tsv files, then run build.ts to produce final fixtures.');
}
