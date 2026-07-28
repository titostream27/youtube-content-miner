import { z } from 'zod';
import { fetchFromVendor } from '@/lib/transcript/providers/hosted';
import { resolveTranscriptVendor } from '@/lib/settings/transcript-vendor';
import { vendorPreset } from '@/lib/transcript/vendors';
import { derivePollUrl } from '@/lib/settings/transcript-vendor';
import { cuesToSentences } from '@/lib/moments/segmentation';
import { badRequest, ok, parseJsonBody, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 240;

const testSchema = z.object({
  /** Defaults to a long real episode, because long videos are the actual workload. */
  videoId: z.string().trim().min(5).max(30).optional(),
  /** Test unsaved form values, so a vendor can be validated before committing. */
  vendorId: z.enum(['supadata', 'custom']).optional(),
  apiKey: z.string().max(400).optional(),
  urlTemplate: z.string().max(500).optional(),
  authHeader: z.string().max(120).optional(),
  authScheme: z.string().max(60).optional(),
  timeUnit: z.enum(['ms', 's']).optional(),
  pollUrlTemplate: z.string().max(500).optional(),
});

/**
 * POST /api/settings/transcript/test
 *
 * Runs the real provider path against one video and reports whether the result
 * is actually usable by this pipeline - which is a stricter question than "did
 * the request succeed".
 *
 * The checks exist because each corresponds to a way a vendor can return
 * HTTP 200 and still be useless here:
 *
 *   - no per-segment timestamps      -> cannot produce clip in/out points at all
 *   - wrong time unit                -> every timecode silently misplaced
 *   - no punctuation                 -> sentence rebuilding degrades, and every
 *                                       downstream score with it
 *   - truncated at N minutes         -> looks like "this episode had few moments"
 *   - whole-transcript-as-one-blob   -> unusable segment granularity
 */
export async function POST(request: Request) {
  const { data, error } = await parseJsonBody(request, testSchema);
  if (error) return error;

  try {
    const saved = resolveTranscriptVendor();

    // Merge form overrides over whatever is stored, so Test works before Save.
    const vendorId = data.vendorId ?? saved?.vendorId ?? null;
    if (!vendorId) {
      return badRequest('Select a vendor first, or save one, before testing.');
    }

    const preset = vendorPreset(vendorId);
    const urlTemplate = data.urlTemplate?.trim() || saved?.urlTemplate || preset.request.urlTemplate;
    const apiKey = data.apiKey?.trim() || saved?.apiKey || null;

    if (!urlTemplate) return badRequest('No request URL template to test.');
    if (!apiKey) return badRequest('No API key to test with.');

    const videoId = data.videoId ?? 'dQw4w9WgXcQ';
    const startedAt = Date.now();

    const outcome = await fetchFromVendor({
      vendor: {
        vendorId,
        preset,
        apiKey,
        urlTemplate,
        authHeader: data.authHeader?.trim() || saved?.authHeader || preset.request.authHeader,
        authScheme: data.authScheme?.trim() || saved?.authScheme || preset.request.authScheme,
        timeUnit: data.timeUnit ?? saved?.timeUnit ?? preset.response.timeUnit,
        pollUrlTemplate: derivePollUrl(
          preset,
          urlTemplate,
          data.pollUrlTemplate?.trim() || saved?.pollUrlTemplate || null,
        ),
        source: 'database',
      },
      videoId,
    });

    const elapsedMs = Date.now() - startedAt;

    if (!outcome.cues) {
      return ok({
        ok: false,
        videoId,
        elapsedMs,
        viaJob: outcome.viaJob,
        reason: outcome.reason,
        checks: [],
      });
    }

    const cues = outcome.cues;
    const wordCount = cues.reduce(
      (total, cue) => total + cue.text.split(/\s+/).filter(Boolean).length,
      0,
    );
    const durationSec = cues[cues.length - 1]?.endSec ?? 0;
    const punctuated = cues.filter((cue) => /[.,?!]/.test(cue.text)).length;
    const punctuationRatio = cues.length > 0 ? punctuated / cues.length : 0;
    const sentences = cuesToSentences(cues);
    const wordsPerSecond = durationSec > 0 ? wordCount / durationSec : 0;

    const durations = cues.map((cue) => cue.endSec - cue.startSec).sort((a, b) => a - b);
    const medianSegmentSec = durations[Math.floor(durations.length / 2)] ?? 0;

    const checks: { label: string; pass: boolean; detail: string }[] = [];

    checks.push({
      label: 'Per-segment timestamps',
      pass: cues.length > 1 && durationSec > 0,
      detail:
        cues.length > 1
          ? `${cues.length} timed segments`
          : 'only one segment returned - this vendor may be returning plain text, which cannot produce clip timecodes',
    });

    /*
     * The strongest available unit check, and it needs no second API call:
     * conversational speech runs about 2-3.5 words per second. An order of
     * magnitude off means the declared time unit is wrong.
     */
    const unitLooksRight = wordsPerSecond >= 0.8 && wordsPerSecond <= 8;
    checks.push({
      label: 'Time unit',
      pass: unitLooksRight,
      detail: unitLooksRight
        ? `${wordsPerSecond.toFixed(2)} words/sec - consistent with speech`
        : wordsPerSecond < 0.8
          ? `${wordsPerSecond.toFixed(3)} words/sec is far too slow: the vendor is probably reporting milliseconds. Switch the time unit to ms.`
          : `${wordsPerSecond.toFixed(1)} words/sec is far too fast: the vendor is probably reporting seconds. Switch the time unit to s.`,
    });

    checks.push({
      label: 'Punctuation',
      pass: punctuationRatio >= 0.15,
      detail: `${punctuated}/${cues.length} segments punctuated. Segmentation cuts on sentence boundaries, so low punctuation weakens every downstream score.`,
    });

    checks.push({
      label: 'Segment granularity',
      pass: medianSegmentSec > 0.5 && medianSegmentSec < 60,
      detail: `median segment ${medianSegmentSec.toFixed(1)}s (caption-like granularity is ideal)`,
    });

    checks.push({
      label: 'Sentence reconstruction',
      pass: sentences.length >= 3,
      detail: `${sentences.length} sentences rebuilt from ${cues.length} segments`,
    });

    checks.push({
      label: 'Coverage',
      // Upper bound matters as much as the lower one: an implausible span is the
      // signature of a unit error, not of a very long episode.
      pass: durationSec > 60 && durationSec < 12 * 3600,
      detail:
        `transcript spans ${Math.round(durationSec)}s. Compare this against the real episode ` +
        'length - a vendor that truncates long videos looks like an episode with few moments.',
    });

    return ok({
      ok: checks.every((check) => check.pass),
      videoId,
      elapsedMs,
      viaJob: outcome.viaJob,
      reason: null,
      language: outcome.language,
      stats: {
        segments: cues.length,
        words: wordCount,
        durationSec: Math.round(durationSec),
        wordsPerSecond: Math.round(wordsPerSecond * 100) / 100,
        sentences: sentences.length,
        punctuationRatio: Math.round(punctuationRatio * 100) / 100,
        medianSegmentSec: Math.round(medianSegmentSec * 10) / 10,
      },
      preview: cues
        .slice(0, 6)
        .map((cue) => cue.text)
        .join(' ')
        .slice(0, 300),
      checks,
    });
  } catch (error) {
    return serverError(error);
  }
}
