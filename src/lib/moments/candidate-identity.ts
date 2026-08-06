import { createHash } from 'node:crypto';

/**
 * Hardening v3 C6 (#19): stable, content/window-based candidate identity.
 *
 * A fingerprint that survives re-runs even when the rough segment index
 * shifts, derived from the video, the rounded rough window, and the FIRST and
 * LAST normalized phrases of the window text. Same clip across runs -> same
 * fingerprint; a different window or video -> a different one.
 */
export function candidateFingerprint(
  videoId: string,
  roughStartSec: number,
  roughEndSec: number,
  firstPhrase: string,
  lastPhrase: string,
): string {
  const hash = createHash('sha256');
  hash.update(String(videoId));
  hash.update('\x00');
  hash.update(String(Math.round(roughStartSec)));
  hash.update('\x00');
  hash.update(String(Math.round(roughEndSec)));
  hash.update('\x00');
  hash.update(normalizePhrase(firstPhrase));
  hash.update('\x00');
  hash.update(normalizePhrase(lastPhrase));
  return hash.digest('hex');
}

function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Short stable readable candidate id derived from the fingerprint (the full
 * hash is the identity; a short prefix keeps logs/DB readable).
 */
export function candidateIdFromFingerprint(fingerprint: string): string {
  return `c=${fingerprint.slice(0, 12)}`;
}