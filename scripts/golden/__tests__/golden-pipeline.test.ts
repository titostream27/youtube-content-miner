// Pipeline unit tests (hardening v3 F3). Ensure the golden ingest path
// (parse -> draft -> label -> build) is deterministic and never promotes
// unreviewed skeleton rows into golden fixtures.
// Run: npx vitest run scripts/golden/__tests__/golden-pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSrt, parsePlainText, parseVtt } from '../parse-transcript';
import { buildDraft, labelsSkeleton } from '../ingest';
import { buildFixturesFromDir, parseLabel } from '../build';

describe('golden ingest pipeline (hardening v3 F3)', () => {
  it('parses SRT cues with real timestamps', () => {
    const srt = `1\n00:00:01,000 --> 00:00:05,000\nWe almost lost it.\n\n2\n00:00:06,000 --> 00:00:09,000\nThen we pivoted.\n`;
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.startSec).toBe(1);
    expect(cues[0]!.endSec).toBe(5);
    expect(cues[1]!.text).toBe('Then we pivoted.');
  });

  it('parses VTT cues', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello world\n';
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('Hello world');
  });

  it('estimates timing for plain text', () => {
    const cues = parsePlainText('Hello world. This is a longer sentence.', 2.7);
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues[0]!.endSec).toBeGreaterThan(cues[0]!.startSec);
  });

  it('buildDraft emits a label skeleton equal to cue count', () => {
    const cues = [
      { startSec: 0, endSec: 3, text: 'a' },
      { startSec: 3, endSec: 6, text: 'b' },
    ];
    const draft = buildDraft('ep-x', 'ep-x.srt', cues, { language: 'id', quality: 'noisy' });
    expect(draft.transcriptCues).toHaveLength(2);
    expect(draft.language).toBe('id');
    expect(draft.captionsQuality).toBe('noisy');
    const skeleton = labelsSkeleton('ep-x', cues).split('\n');
    expect(skeleton).toHaveLength(3); // header + 2 cues
  });

  it('parseLabel skips unreviewed skeleton rows', () => {
    // Empty score -> not reviewed -> null.
    expect(parseLabel('epx_c1\t0\t3\t\t0\t\t')).toBeNull();
    // Reviewed -> parsed.
    const lbl = parseLabel('epx_c1\t0\t3\t90\t0.05\ttrue\tfalse');
    expect(lbl).toEqual({
      clipId: 'epx_c1',
      expectedStartSec: 0,
      expectedEndSec: 3,
      expectedScore: 90,
      expectedContamination: 0.05,
      expectedStartComplete: true,
      expectedEndingComplete: false,
    });
  });

  it('build only emits fixtures whose labels are human-reviewed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    writeFileSync(join(dir, 'ep-a.draft.json'), JSON.stringify({
      id: 'ep-a', language: 'en', captionsQuality: 'noisy',
      transcriptCues: [{ startSec: 0, endSec: 3, text: 'x' }],
    }));
    writeFileSync(join(dir, 'ep-a.labels.tsv'),
      'clipId\tstartSec\tendSec\tscore\tcontamination\tstartComplete\tendingComplete\n' +
      'epx_c1\t0\t3\t90\t0.1\ttrue\tfalse\n');
    writeFileSync(join(dir, 'ep-b.draft.json'), JSON.stringify({
      id: 'ep-b', language: 'en', captionsQuality: 'noisy',
      transcriptCues: [{ startSec: 0, endSec: 3, text: 'y' }],
    }));
    writeFileSync(join(dir, 'ep-b.labels.tsv'),
      'clipId\tstartSec\tendSec\tscore\tcontamination\tstartComplete\tendingComplete\n' +
      'epx_c2\t0\t3\t\t\t\t\n'); // unreviewed
    const out = buildFixturesFromDir(dir, 2, false);
    expect(out.skipped).toContain('ep-b');
    expect(out.fixtures).toHaveLength(1);
    expect(out.fixtures[0]!.id).toBe('ep-a');
    expect(out.fixtures[0]!.labels).toHaveLength(1);
  });
});