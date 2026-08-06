# Golden Dataset Pipeline (hardening v3 F3)

Convert raw podcast transcripts into labeled golden fixtures the evaluation
(`src/lib/golden/`) actually consumes.

## Why
The brief targets **20-30 episodes / 100+ approved moments / 100+ hard
negatives** across EN/ID and clean/noisy captions. Those labels must come from
**real, human-approved editors** — the pipeline exists so you can annotate real
episodes and have them flow into evaluation without editing source code. It
does **not** fabricate labels.

## Workflow

1. **Put transcripts** in a folder (`.srt`, `.vtt`, or `.txt`).

```bash
npx tsx scripts/golden/ingest.ts ./transcripts ./golden-data \
  --lang=en --quality=noisy
```

For each input file this writes:
- `golden-data/<id>.draft.json` — parsed `transcriptCues` + metadata
- `golden-data/<id>.labels.tsv` — a **skeleton** (one row per cue, blank score)
  for you to review.

2. **Annotate the TSV.** Fill these columns for every approved moment
   (`clipId`, `startSec`, `endSec`, `score`, `contamination`,
   `startComplete`, `endingComplete`). Rows left with an empty `score` /
   booleans are treated as **unreviewed** and dropped — they will never be
   promoted into a golden fixture.

```
clipId	startSec	endSec	score	contamination	startComplete	endingComplete
ep1_m1	12	27	92	0.03	true	true
ep1_neg	40	45	30	0.9	false	false
```

3. **Build + import.**

```bash
npx tsx scripts/golden/build.ts ./golden-data --topK=3 --import-index
```

This writes `golden-data/fixtures/<id>.json` and regenerates
`golden-data/index.ts`, which `src/lib/golden/fixtures.ts` imports as
`ALL_GOLDEN_FIXTURES`. Unreviewed drafts are skipped with a warning.

## Notes
- **Estimated timing**: `.txt` timing is derived from word count at a speaking
  rate (`--rate`, default 2.7 wps). Prefer `.srt`/`.vtt` (real timestamps).
- A metadata field (`captionsQuality`) marks the animate source: use `noisy`
  for machine-ASR output, `clean` for manual/YT captions.
- Editing curated inline fixtures is still fine — external fixtures just ADD
  to them.