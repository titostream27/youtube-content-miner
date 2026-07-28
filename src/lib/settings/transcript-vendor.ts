import { config } from '@/lib/config';
import { getDb, nowIso } from '@/lib/db/client';
import {
  isTranscriptVendorId,
  vendorPreset,
  type TranscriptVendorId,
  type TranscriptVendorPreset,
} from '@/lib/transcript/vendors';

/**
 * Runtime-configurable transcript vendor credentials.
 *
 * Environment variables are the right place for secrets in a deployed service,
 * but they force a restart to change and cannot support "pick a vendor, paste a
 * key" from the UI. So both are supported with a clear precedence: environment
 * wins, database fills the gap.
 *
 * That ordering matters. A hosted deployment can pin credentials in the
 * environment and be certain no UI action can override them, while a local
 * operator can switch vendors without touching a file.
 *
 * Security, stated plainly: keys saved through the UI are stored in the local
 * SQLite file as plaintext. That is acceptable for a single-operator tool where
 * the database sits on the operator's own disk, and it is not acceptable for a
 * shared or multi-tenant deployment - use the environment there. The key is
 * never returned by any API route or rendered in any page; only whether one is
 * present.
 */

const KEYS = {
  vendorId: 'transcript.vendor.id',
  apiKey: 'transcript.vendor.apiKey',
  urlTemplate: 'transcript.vendor.urlTemplate',
  authHeader: 'transcript.vendor.authHeader',
  authScheme: 'transcript.vendor.authScheme',
  timeUnit: 'transcript.vendor.timeUnit',
  pollUrlTemplate: 'transcript.vendor.pollUrlTemplate',
} as const;

function readSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;

  const value = row?.value?.trim();
  return value && value.length > 0 ? value : null;
}

function writeSetting(key: string, value: string | null): void {
  const db = getDb();

  if (value === null || value.trim().length === 0) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value.trim(), nowIso());
}

/** Fully resolved vendor configuration, or null when nothing is configured. */
export interface ResolvedTranscriptVendor {
  vendorId: TranscriptVendorId;
  preset: TranscriptVendorPreset;
  apiKey: string | null;
  urlTemplate: string;
  authHeader: string;
  authScheme: string | null;
  timeUnit: 'ms' | 's';
  /**
   * Poll URL for asynchronous jobs, or null when the vendor is always
   * synchronous.
   */
  pollUrlTemplate: string | null;
  /** Where the credential came from, for the settings UI. */
  source: 'env' | 'database';
}

/**
 * Resolve the job poll URL.
 *
 * The preset's poll URL points at the vendor's own host. If the operator has
 * pointed the request URL somewhere else - their own proxy, a staging endpoint, a
 * mock - then polling the vendor's host is wrong, and worse, it sends a request
 * to a third party the operator did not intend to call. So an overridden request
 * origin is carried across to the poll URL.
 */
export function derivePollUrl(
  preset: TranscriptVendorPreset,
  urlTemplate: string,
  explicit: string | null,
): string | null {
  if (explicit) return explicit;

  const presetPoll = preset.response.asyncJob?.pollUrlTemplate ?? null;
  if (!presetPoll) return null;

  try {
    const requested = new URL(urlTemplate.replace('{videoUrl}', 'x').replace('{videoId}', 'x'));
    const presetRequest = new URL(preset.request.urlTemplate.replace('{videoUrl}', 'x'));
    if (requested.origin === presetRequest.origin) return presetPoll;

    const poll = new URL(presetPoll);
    poll.protocol = requested.protocol;
    poll.host = requested.host;
    return poll.toString();
  } catch {
    return presetPoll;
  }
}

export function resolveTranscriptVendor(): ResolvedTranscriptVendor | null {
  const envUrl = config.transcript.hosted.url;
  const envKey = config.transcript.hosted.apiKey;

  // Environment first, and treated as complete on its own so a deployment can
  // pin it without any database row existing.
  if (envUrl) {
    return {
      vendorId: 'custom',
      preset: vendorPreset('custom'),
      apiKey: envKey,
      urlTemplate: envUrl,
      authHeader: config.transcript.hosted.authHeader,
      authScheme: config.transcript.hosted.authScheme,
      timeUnit: config.transcript.hosted.timeUnit,
      pollUrlTemplate: config.transcript.hosted.pollUrlTemplate,
      source: 'env',
    };
  }

  const storedVendor = readSetting(KEYS.vendorId);
  if (!storedVendor || !isTranscriptVendorId(storedVendor)) return null;

  const preset = vendorPreset(storedVendor);
  const urlTemplate = readSetting(KEYS.urlTemplate) ?? preset.request.urlTemplate;
  if (urlTemplate.length === 0) return null;

  const storedUnit = readSetting(KEYS.timeUnit);

  return {
    vendorId: storedVendor,
    preset,
    apiKey: readSetting(KEYS.apiKey),
    urlTemplate,
    authHeader: readSetting(KEYS.authHeader) ?? preset.request.authHeader,
    authScheme: readSetting(KEYS.authScheme) ?? preset.request.authScheme,
    timeUnit: storedUnit === 'ms' || storedUnit === 's' ? storedUnit : preset.response.timeUnit,
    pollUrlTemplate: derivePollUrl(preset, urlTemplate, readSetting(KEYS.pollUrlTemplate)),
    source: 'database',
  };
}

export interface SaveTranscriptVendorInput {
  vendorId: TranscriptVendorId;
  apiKey?: string | null;
  urlTemplate?: string | null;
  authHeader?: string | null;
  authScheme?: string | null;
  timeUnit?: 'ms' | 's' | null;
  pollUrlTemplate?: string | null;
}

export function saveTranscriptVendor(input: SaveTranscriptVendorInput): void {
  writeSetting(KEYS.vendorId, input.vendorId);

  // An omitted key leaves the stored one alone, so the settings form can be
  // re-submitted to change the URL without re-entering the secret.
  if (input.apiKey !== undefined) writeSetting(KEYS.apiKey, input.apiKey);
  if (input.urlTemplate !== undefined) writeSetting(KEYS.urlTemplate, input.urlTemplate);
  if (input.authHeader !== undefined) writeSetting(KEYS.authHeader, input.authHeader);
  if (input.authScheme !== undefined) writeSetting(KEYS.authScheme, input.authScheme);
  if (input.timeUnit !== undefined) writeSetting(KEYS.timeUnit, input.timeUnit);
  if (input.pollUrlTemplate !== undefined) {
    writeSetting(KEYS.pollUrlTemplate, input.pollUrlTemplate);
  }
}

export function clearTranscriptVendor(): void {
  for (const key of Object.values(KEYS)) writeSetting(key, null);
}

/**
 * Safe view for the UI and API.
 *
 * Deliberately never includes the key, not even a masked suffix - the last four
 * characters of a credential are still credential material and buy the operator
 * nothing they do not already know.
 */
export interface TranscriptVendorStatus {
  configured: boolean;
  vendorId: TranscriptVendorId | null;
  vendorLabel: string | null;
  urlTemplate: string | null;
  authHeader: string | null;
  timeUnit: 'ms' | 's' | null;
  pollUrlTemplate: string | null;
  hasApiKey: boolean;
  source: 'env' | 'database' | null;
  /** True when credentials come from the environment and the UI cannot change them. */
  managedByEnvironment: boolean;
}

export function describeTranscriptVendor(): TranscriptVendorStatus {
  const resolved = resolveTranscriptVendor();

  if (!resolved) {
    return {
      configured: false,
      vendorId: null,
      vendorLabel: null,
      urlTemplate: null,
      authHeader: null,
      timeUnit: null,
      pollUrlTemplate: null,
      hasApiKey: false,
      source: null,
      managedByEnvironment: Boolean(config.transcript.hosted.url),
    };
  }

  return {
    configured: resolved.urlTemplate.length > 0,
    vendorId: resolved.vendorId,
    vendorLabel: resolved.preset.label,
    urlTemplate: resolved.urlTemplate,
    authHeader: resolved.authHeader,
    timeUnit: resolved.timeUnit,
    pollUrlTemplate: resolved.pollUrlTemplate,
    hasApiKey: Boolean(resolved.apiKey),
    source: resolved.source,
    managedByEnvironment: resolved.source === 'env',
  };
}
