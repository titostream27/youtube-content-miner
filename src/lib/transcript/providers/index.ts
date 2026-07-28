import { config } from '@/lib/config';
import { isSttConfigured } from '../stt';
import { describeTranscriptVendor } from '@/lib/settings/transcript-vendor';
import type {
  TranscriptProvider,
  TranscriptProviderDescriptor,
  TranscriptProviderId,
} from './types';

/**
 * Provider registry.
 *
 * Descriptors carry identity and availability, which are resolvable from
 * configuration alone. Implementations are dynamically imported on first use, so
 * rendering the status panel or hitting `/api/health` never loads the subprocess
 * and filesystem code in the yt-dlp provider.
 */

const DESCRIPTORS: Record<TranscriptProviderId, TranscriptProviderDescriptor> = {
  hosted: {
    id: 'hosted',
    label: 'Hosted transcript API',
    unavailableReason: () => {
      const status = describeTranscriptVendor();
      if (!status.configured) {
        return 'no vendor selected - choose one and add an API key in AI Agents settings';
      }
      // A vendor with no key is a half-finished setup, not a usable provider.
      if (!status.hasApiKey) return `${status.vendorLabel ?? 'vendor'} selected but no API key saved`;
      return null;
    },
    load: async () => (await import('./hosted')).hostedProvider,
  },

  ytdlp: {
    id: 'ytdlp',
    label: 'yt-dlp caption extraction',
    unavailableReason: () =>
      config.transcript.ytdlp.enabled ? null : 'disabled by YTDLP_ENABLED',
    load: async () => (await import('./ytdlp')).ytdlpProvider,
  },

  captions: {
    id: 'captions',
    label: 'YouTube watch page (timedtext)',
    // Needs no configuration. Usually refused from a datacenter IP, which is
    // reported per attempt rather than pretended to be unavailable up front.
    unavailableReason: () => null,
    load: async () => (await import('./youtube-captions')).youtubeCaptionsProvider,
  },

  stt: {
    id: 'stt',
    label: 'Speech-to-text',
    unavailableReason: () =>
      isSttConfigured() ? null : 'STT_PROVIDER and STT_API_KEY are not set',
    load: async () => (await import('./stt-provider')).sttProvider,
  },
};

export function allDescriptors(): TranscriptProviderDescriptor[] {
  return Object.values(DESCRIPTORS);
}

/**
 * The chain in configured order, skipping providers that cannot run.
 *
 * Default order reflects measured reliability rather than preference: a hosted
 * vendor absorbs the anti-bot problem entirely, yt-dlp tracks YouTube's client
 * and token changes, the direct scrape is free but usually refused from a
 * datacenter IP, and speech-to-text is the expensive last resort.
 */
export function resolveProviderChain(): {
  active: TranscriptProviderDescriptor[];
  skipped: { descriptor: TranscriptProviderDescriptor; reason: string }[];
} {
  const active: TranscriptProviderDescriptor[] = [];
  const skipped: { descriptor: TranscriptProviderDescriptor; reason: string }[] = [];

  for (const id of config.transcript.order) {
    const descriptor = DESCRIPTORS[id];
    if (!descriptor) continue;

    const reason = descriptor.unavailableReason();
    if (reason) skipped.push({ descriptor, reason });
    else active.push(descriptor);
  }

  return { active, skipped };
}

export async function loadProvider(
  descriptor: TranscriptProviderDescriptor,
): Promise<TranscriptProvider> {
  return descriptor.load();
}

/** Status for the settings page and `/api/health`. */
export function describeProviderChain(): {
  id: TranscriptProviderId;
  label: string;
  position: number | null;
  ready: boolean;
  reason: string | null;
}[] {
  const order = config.transcript.order;

  return allDescriptors().map((descriptor) => {
    const reason = descriptor.unavailableReason();
    const index = order.indexOf(descriptor.id);

    return {
      id: descriptor.id,
      label: descriptor.label,
      position: index === -1 ? null : index + 1,
      ready: index !== -1 && reason === null,
      reason: index === -1 ? 'not in TRANSCRIPT_PROVIDERS order' : reason,
    };
  });
}

export * from './types';
