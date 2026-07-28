import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@/lib/config';
import type { Transcript, TranscriptSource } from '@/lib/domain/types';
import { cueStats, json3ToCues, type Json3Response } from '@/lib/youtube/timedtext';
import {
  attemptFailed,
  attemptSucceeded,
  type TranscriptAttempt,
  type TranscriptFetchInput,
  type TranscriptProvider,
} from './types';

/**
 * yt-dlp caption provider.
 *
 * yt-dlp is usually thought of as a downloader, but it is also the most capable
 * *caption* extractor available: it tracks YouTube's player clients, signature
 * handling and proof-of-origin token requirements, which is exactly the moving
 * target that breaks hand-rolled scrapers.
 *
 * `--skip-download` means no video or audio is transferred - only the subtitle
 * track, a few tens of kilobytes.
 *
 * On the default player client the request is refused without a PO token.
 * Measured here, `player_client=android` returns real caption files from a
 * datacenter IP without one, so that is the default; it remains configurable
 * because YouTube changes which clients work. For sustained volume, supply a
 * residential proxy and/or cookies.
 */

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runYtDlp(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(config.transcript.ytdlp.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });

    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

/**
 * Build the full argument list for one pass.
 *
 * `subFlag` selects manual (`--write-subs`) or auto-generated
 * (`--write-auto-subs`) tracks; see the two-pass rationale in `fetch`.
 */
function buildArgs(params: {
  videoId: string;
  outputTemplate: string;
  subFlag: '--write-subs' | '--write-auto-subs';
  subLangs: string;
}): string[] {
  const { ytdlp } = config.transcript;

  const args = [
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--sub-format',
    'json3',
    '--extractor-args',
    `youtube:player_client=${ytdlp.playerClient}`,
    params.subFlag,
    '--sub-langs',
    params.subLangs,
    '-o',
    params.outputTemplate,
  ];

  if (ytdlp.proxy) args.push('--proxy', ytdlp.proxy);
  if (ytdlp.cookiesFile) args.push('--cookies', ytdlp.cookiesFile);
  if (ytdlp.cookiesFromBrowser) args.push('--cookies-from-browser', ytdlp.cookiesFromBrowser);
  if (ytdlp.extraArgs.length > 0) args.push(...ytdlp.extraArgs);

  args.push(`https://www.youtube.com/watch?v=${params.videoId}`);
  return args;
}

/**
 * Rank the subtitle files yt-dlp wrote and return the best match.
 *
 * Translated tracks (`en-de-DE`) are machine translations of another language
 * and are far worse input for scoring than the original, so they lose to any
 * non-translated track.
 */
function pickFile(files: string[], preferredLanguages: readonly string[]): string | null {
  const candidates = files.filter((file) => file.endsWith('.json3'));
  if (candidates.length === 0) return null;

  const languageOf = (file: string): string => {
    const parts = file.split('.');
    return (parts[parts.length - 2] ?? '').toLowerCase();
  };

  const score = (file: string): number => {
    const language = languageOf(file);
    const isTranslation = language.split('-').length > 2 || /^[a-z]{2}-[a-z]{2}-/.test(language);
    const base = language.replace(/-orig$/, '');

    const preferenceIndex = preferredLanguages.findIndex((preferred) => {
      const wanted = preferred.toLowerCase();
      return base === wanted || base.startsWith(`${wanted}-`) || wanted.startsWith(base);
    });

    let value = preferenceIndex === -1 ? 0 : 100 - preferenceIndex * 10;
    if (isTranslation) value -= 60;
    // `-orig` is the original-language auto track: better than a translation.
    if (language.endsWith('-orig')) value += 5;
    return value;
  };

  return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function readTranscript(
  directory: string,
  videoId: string,
  source: TranscriptSource,
  preferredLanguages: readonly string[],
): Promise<Transcript | null> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return null;
  }

  const chosen = pickFile(files, preferredLanguages);
  if (!chosen) return null;

  let payload: Json3Response;
  try {
    payload = JSON.parse(await readFile(join(directory, chosen), 'utf8')) as Json3Response;
  } catch {
    return null;
  }

  const cues = json3ToCues(payload);
  if (cues.length === 0) return null;

  const stats = cueStats(cues);
  const language = (chosen.split('.').at(-2) ?? 'en').replace(/-orig$/, '');

  return {
    videoId,
    source,
    language,
    cues,
    durationSec: stats.durationSec,
    wordCount: stats.wordCount,
  };
}

function diagnose(result: RunResult): { reason: string; blocked: boolean } {
  const output = `${result.stderr}\n${result.stdout}`;

  if (result.timedOut) {
    return { reason: 'yt-dlp timed out', blocked: false };
  }
  if (/sign in to confirm|not a bot/i.test(output)) {
    return {
      reason: 'blocked: YouTube demanded sign-in (supply cookies or a residential proxy)',
      blocked: true,
    };
  }
  if (/HTTP Error 429|too many requests/i.test(output)) {
    return { reason: 'blocked: rate limited by YouTube (429)', blocked: true };
  }
  if (/po token/i.test(output)) {
    return {
      reason: 'blocked: a proof-of-origin token is required for this player client',
      blocked: true,
    };
  }
  if (/no subtitles|there are no subtitles/i.test(output)) {
    return { reason: 'no subtitle track for the requested languages', blocked: false };
  }
  if (/video unavailable|private video|members-only/i.test(output)) {
    return { reason: 'video is unavailable, private or members-only', blocked: false };
  }

  const firstError = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('ERROR:'));

  return {
    reason: firstError ?? `yt-dlp exited with status ${result.status ?? 'unknown'}`,
    blocked: false,
  };
}

let binaryAvailable: boolean | null = null;

async function checkBinary(): Promise<boolean> {
  if (binaryAvailable !== null) return binaryAvailable;
  const result = await runYtDlp(['--version'], 10_000);
  binaryAvailable = result.status === 0;
  return binaryAvailable;
}

export const ytdlpProvider: TranscriptProvider = {
  id: 'ytdlp',

  async fetch(input: TranscriptFetchInput): Promise<TranscriptAttempt> {
    const { candidate, preferredLanguages } = input;

    if (!(await checkBinary())) {
      return attemptFailed(
        'ytdlp',
        `binary "${config.transcript.ytdlp.binary}" not found on PATH (pip install yt-dlp)`,
      );
    }

    /*
     * Scratch space for the subtitle files, removed in the `finally` block.
     *
     * Turbopack's file tracer emits a warning for the runtime-constructed paths
     * below: it cannot prove which files they reach, so it conservatively reports
     * that the whole project may have been traced. The warning is expected and
     * harmless - `outputFileTracingExcludes` in next.config.ts keeps the output
     * clean. Writing scratch files anywhere other than the OS temp directory,
     * purely to quieten a bundler heuristic, would be the worse trade.
     */
    const directory = await mkdtemp(join(tmpdir(), `ycm-${candidate.videoId}-`));
    const template = join(directory, '%(id)s');
    const timeout = config.transcript.ytdlp.timeoutMs;

    try {
      /*
       * Two passes rather than one. yt-dlp writes manual and auto-generated
       * tracks to identically named files, so a single combined pass makes it
       * impossible to tell which we got - and that distinction matters: the
       * confidence model rates human-authored captions well above ASR. Asking
       * for manual first and falling back is the only reliable way to label the
       * source correctly.
       */
      const manual = await runYtDlp(
        buildArgs({
          videoId: candidate.videoId,
          outputTemplate: template,
          subFlag: '--write-subs',
          subLangs: preferredLanguages.join(','),
        }),
        timeout,
      );

      const manualTranscript = await readTranscript(
        directory,
        candidate.videoId,
        'youtube_manual',
        preferredLanguages,
      );
      if (manualTranscript) return attemptSucceeded('ytdlp', manualTranscript);

      const auto = await runYtDlp(
        buildArgs({
          videoId: candidate.videoId,
          outputTemplate: template,
          subFlag: '--write-auto-subs',
          subLangs: preferredLanguages
            .flatMap((language) => [language, `${language}-orig`])
            .join(','),
        }),
        timeout,
      );

      const autoTranscript = await readTranscript(
        directory,
        candidate.videoId,
        'youtube_asr',
        preferredLanguages,
      );
      if (autoTranscript) return attemptSucceeded('ytdlp', autoTranscript);

      // Report whichever pass gave the more actionable diagnosis.
      const manualDiagnosis = diagnose(manual);
      const autoDiagnosis = diagnose(auto);
      const chosen = autoDiagnosis.blocked ? autoDiagnosis : manualDiagnosis.blocked ? manualDiagnosis : autoDiagnosis;

      return attemptFailed('ytdlp', chosen.reason, chosen.blocked);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};
