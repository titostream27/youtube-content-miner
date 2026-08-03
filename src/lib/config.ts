import { DEFAULT_EPISODE_SCORE_THRESHOLD } from '@/lib/scoring/episode-opportunity';
import { LIBRARY_MIN_SCORE } from '@/lib/domain/thresholds';
import {
  AGENT_ROLES,
  AGENT_ROLE_DEFINITIONS,
  type AgentRole,
} from '@/lib/ai/agents/roles';
import {
  availableProviders,
  isProviderId,
  resolveProviderRuntime,
  type ProviderId,
} from '@/lib/ai/providers/catalog';

/**
 * Declared locally rather than imported from `lib/transcript/providers` to keep
 * config free of dependencies on the modules that read it.
 */
type TranscriptProviderId = 'hosted' | 'ytdlp' | 'captions' | 'stt';

/**
 * Runtime configuration, resolved once from the environment.
 *
 * A deliberate design goal: the app must be fully runnable with an empty
 * `.env`. Without a YouTube key it serves a deterministic fixture catalogue,
 * and without any AI key it scores with the heuristic engine. Nothing throws at
 * import time, so a reviewer can clone, `npm run dev`, and watch the whole
 * pipeline run before signing up for anything.
 */

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function readString(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/* -------------------------------------------------------------------------- */
/* AI provider + agent resolution                                             */
/* -------------------------------------------------------------------------- */

export interface AgentAssignment {
  role: AgentRole;
  /** `null` means no usable provider, so this role falls back to heuristics. */
  providerId: ProviderId | null;
  model: string | null;
  temperature: number;
  maxOutputTokens: number;
}

/**
 * The global default provider.
 *
 * `AI_PROVIDER=heuristic` (or `none`) forces the deterministic engine, which is
 * useful for reproducible scoring runs and for CI.
 */
function resolveDefaultProvider(): ProviderId | null {
  const explicit = readString('AI_PROVIDER')?.toLowerCase();

  if (explicit === 'heuristic' || explicit === 'none') return null;

  if (explicit && isProviderId(explicit)) {
    const runtime = resolveProviderRuntime(explicit);
    // An explicitly requested provider with no key is a configuration mistake,
    // not a reason to silently use a different vendor.
    return runtime.configured ? explicit : null;
  }

  // Auto-detect: first configured provider in catalogue order.
  return availableProviders()[0]?.definition.id ?? null;
}

const defaultProvider = resolveDefaultProvider();

/** Per-role overrides, falling back to the global default. */
function resolveAgentAssignments(): Record<AgentRole, AgentAssignment> {
  const assignments = {} as Record<AgentRole, AgentAssignment>;

  for (const role of AGENT_ROLES) {
    const definition = AGENT_ROLE_DEFINITIONS[role];
    const requested = readString(definition.providerEnv)?.toLowerCase();

    let providerId: ProviderId | null = defaultProvider;

    if (requested === 'heuristic' || requested === 'none') {
      providerId = null;
    } else if (requested && isProviderId(requested)) {
      providerId = resolveProviderRuntime(requested).configured ? requested : null;
    }

    const model =
      readString(definition.modelEnv) ??
      (providerId ? resolveProviderRuntime(providerId).defaultModel : null);

    assignments[role] = {
      role,
      providerId,
      model,
      temperature: Number(readString(`${definition.providerEnv}_TEMPERATURE`) ?? definition.temperature),
      maxOutputTokens: definition.maxOutputTokens,
    };
  }

  return assignments;
}

export const config = {
  youtube: {
    apiKey: readString('YOUTUBE_API_KEY'),
    /** Serve fixture data instead of calling the API. */
    demoMode: readBool('DEMO_MODE') || !readString('YOUTUBE_API_KEY'),
    /** Preferred caption languages, in order. */
    transcriptLanguages: (readString('TRANSCRIPT_LANGUAGES') ?? 'en,en-US,en-GB')
      .split(',')
      .map((language) => language.trim())
      .filter(Boolean),
  },

  ai: {
    /** Global default; individual agents may override it. */
    defaultProvider,
    agents: resolveAgentAssignments(),
    /** Segments scored per LLM request. */
    batchSize: readInt('AI_BATCH_SIZE', 6),
    /** Concurrent in-flight requests per episode. */
    concurrency: readInt('AI_CONCURRENCY', 3),
    requestTimeoutMs: readInt('AI_TIMEOUT_MS', 90_000),
    maxRetries: readInt('AI_MAX_RETRIES', 2),
    /**
     * Let API callers choose the provider per request. Off by default: in a
     * hosted deployment the operator, not the caller, should decide where
     * transcripts are sent.
     */
    allowRequestOverrides: readBool('AI_ALLOW_REQUEST_OVERRIDES', true),
  },

  pipeline: {
    /** Episodes pulled from discovery per run. */
    maxEpisodesPerRun: readInt('MAX_EPISODES_PER_RUN', 12),
    /** Episodes actually transcribed and scored per run - the real cost cap. */
    maxEpisodesAnalysedPerRun: readInt('MAX_EPISODES_ANALYSED_PER_RUN', 4),
    /**
     * Cost ceiling per episode. Only the highest-salience segments are scored;
     * the rest are discarded before any model sees them.
     */
    maxScoredSegmentsPerEpisode: readInt('MAX_SCORED_SEGMENTS_PER_EPISODE', 40),
    episodeScoreThreshold: readInt('EPISODE_SCORE_THRESHOLD', DEFAULT_EPISODE_SCORE_THRESHOLD),
    clipScoreThreshold: readInt('CLIP_SCORE_THRESHOLD', LIBRARY_MIN_SCORE),
    segment: {
      minDurationSec: readInt('SEGMENT_MIN_SEC', 18),
      maxDurationSec: readInt('SEGMENT_MAX_SEC', 60),
      targetDurationSec: readInt('SEGMENT_TARGET_SEC', 38),
    },
    // Phase 1 (Correctness) — two-pass highlight selection + topic boundary.
    highlight: {
      preferredMinSec: readInt('HIGHLIGHT_PREFERRED_MIN_S', 25),
      preferredMaxSec: readInt('HIGHLIGHT_PREFERRED_MAX_S', 50),
      hardMinSec: readInt('CLIP_HARD_MIN_SEC', 14),
      hardMaxSec: readInt('CLIP_HARD_MAX_SEC', 60),
      allowShortCompleteClip: readInt('HIGHLIGHT_ALLOW_SHORT_COMPLETE_CLIP', 1) === 1,
      minCompleteDurationSec: readInt('HIGHLIGHT_MIN_COMPLETE_DURATION_S', 14),
      nextTopicLookaheadSec: readInt('HIGHLIGHT_NEXT_TOPIC_LOOKAHEAD_S', 12),
      topicChangeThreshold: readFloat('HIGHLIGHT_TOPIC_CHANGE_THRESHOLD', 0.58),
      endGuardSec: readFloat('HIGHLIGHT_END_GUARD_S', 0.2),
      minEndingConfidence: readFloat('HIGHLIGHT_MIN_ENDING_CONFIDENCE', 0.82),
      minBoundaryConfidence: readFloat('HIGHLIGHT_MIN_BOUNDARY_CONFIDENCE', 0.82),
      maxNextTopicContamination: readFloat('HIGHLIGHT_MAX_NEXT_TOPIC_CONTAMINATION', 0.18),
      contextBeforeSec: readInt('HIGHLIGHT_CONTEXT_BEFORE_S', 15),
      contextAfterSec: readInt('HIGHLIGHT_CONTEXT_AFTER_S', 20),
    },
  },

  /**
   * PRD Step 3 - transcript acquisition.
   *
   * Mining third-party podcasts means YouTube's anti-bot layer is a first-class
   * engineering constraint, not an edge case. Measured from a datacenter IP the
   * direct scrape is refused outright, so the acquisition method has to be
   * deployment-specific: hence an ordered, pluggable chain rather than one path.
   */
  transcript: {
    order: (readString('TRANSCRIPT_PROVIDERS') ?? 'hosted,ytdlp,captions,stt')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is TranscriptProviderId =>
        (['hosted', 'ytdlp', 'captions', 'stt'] as const).includes(entry as TranscriptProviderId),
      ),

    /** Vendor-neutral hosted transcript API. */
    hosted: {
      /** Supports a `{videoId}` placeholder, otherwise the id is added as a query param. */
      url: readString('TRANSCRIPT_API_URL'),
      apiKey: readString('TRANSCRIPT_API_KEY'),
      authHeader: readString('TRANSCRIPT_API_AUTH_HEADER') ?? 'x-api-key',
      /** e.g. `Bearer`. Empty means the key is sent raw. */
      authScheme: readString('TRANSCRIPT_API_AUTH_SCHEME'),
      videoIdParam: readString('TRANSCRIPT_API_VIDEO_PARAM') ?? 'videoId',
      /**
       * Declared rather than inferred. Several vendors report offsets in
       * milliseconds, and guessing from magnitude fails precisely where it
       * matters: an offset of 5000 is 5 seconds in ms, but a magnitude heuristic
       * reads it as 5000 seconds and misplaces every timecode in the first
       * hundred seconds of the episode.
       */
      timeUnit: (readString('TRANSCRIPT_API_TIME_UNIT') === 'ms' ? 'ms' : 's') as 'ms' | 's',
      timeoutMs: readInt('TRANSCRIPT_API_TIMEOUT_MS', 30_000),
      /** Poll URL for asynchronous jobs; `{jobId}` is substituted. */
      pollUrlTemplate: readString('TRANSCRIPT_API_JOB_URL'),
      /** Ceiling for polling an asynchronous transcript job. */
      jobTimeoutMs: readInt('TRANSCRIPT_API_JOB_TIMEOUT_MS', 180_000),
    },

    ytdlp: {
      enabled: readBool('YTDLP_ENABLED', true),
      binary: readString('YTDLP_BINARY') ?? 'yt-dlp',
      /**
       * Default player clients are refused without a proof-of-origin token.
       * `android` was measured to return caption files from a datacenter IP
       * without one. YouTube changes this, so it stays configurable.
       */
      playerClient: readString('YTDLP_PLAYER_CLIENT') ?? 'android',
      proxy: readString('YTDLP_PROXY'),
      cookiesFile: readString('YTDLP_COOKIES_FILE'),
      cookiesFromBrowser: readString('YTDLP_COOKIES_FROM_BROWSER'),
      extraArgs: (readString('YTDLP_EXTRA_ARGS') ?? '')
        .split(' ')
        .map((arg) => arg.trim())
        .filter(Boolean),
      timeoutMs: readInt('YTDLP_TIMEOUT_MS', 60_000),
    },
  },

  stt: {
    /** Speech-to-text fallback for episodes with no caption track. */
    provider: readString('STT_PROVIDER'),
    apiKey: readString('STT_API_KEY'),
    model: readString('STT_MODEL') ?? 'whisper-1',
  },

  /**
   * Hybrid render integration — the external shorts render service.
   *
   * The render service is the AI-Youtube-Shorts-Generator fork running as a
   * separate FastAPI process (port 8084). It only cuts + reframes clips; all
   * scoring happens here in the miner.
   */
  render: {
    /**
     * Base URL of the render service. Inside the Docker network the host is
     * reached via host.docker.internal; `npm run dev` on the same machine can
     * use 127.0.0.1 directly.
     */
    baseUrl: readString('RENDER_SERVICE_URL') ?? 'http://host.docker.internal:8084',
    /**
     * URL the browser can reach the render service at. The server-side call
     * goes through the Docker network (baseUrl), but the file link embedded in
     * the UI must be reachable from the user's browser.
     */
    publicBaseUrl: readString('RENDER_PUBLIC_URL') ?? 'http://localhost:8084',
    /**
     * Request timeout. Rendering a clip from a long source video re-encodes
     * every frame through OpenCV; a 90-minute episode can take ~5 minutes.
     * Generous so the synchronous render completes in one request.
     */
    timeoutMs: readInt('RENDER_SERVICE_TIMEOUT_MS', 900_000),
    /** Optional auth token sent as `x-render-token` if configured. */
    token: readString('RENDER_SERVICE_TOKEN'),
  },
  /**
   * Phase 3 — publish integration.
   *
   * The poster service uploads rendered shorts to YouTube/TikTok/Reels using
   * platform OAuth. Same Docker-network pattern as the render service.
   */
  publish: {
    baseUrl: readString('POSTER_SERVICE_URL') ?? 'http://host.docker.internal:8085',
    timeoutMs: readInt('POSTER_SERVICE_TIMEOUT_MS', 900_000),
    token: readString('POSTER_SERVICE_TOKEN'),
    /** Default privacy for published videos: 'public' | 'private' | 'unlisted' */
    privacy: (readString('PUBLISH_PRIVACY') ?? 'public') as 'public' | 'private' | 'unlisted',
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Introspection helpers                                                      */
/* -------------------------------------------------------------------------- */

export function agentAssignment(role: AgentRole): AgentAssignment {
  return config.ai.agents[role];
}

/** True when at least one agent has a usable provider. */
export function isAiEnabled(): boolean {
  return AGENT_ROLES.some((role) => config.ai.agents[role].providerId !== null);
}

/** True when the agent that actually determines quality has a provider. */
export function isClipScoringAgentEnabled(): boolean {
  return config.ai.agents.clip_scoring.providerId !== null;
}

export interface ConfigSummary {
  youtube: 'live' | 'demo';
  scoring: 'llm' | 'heuristic';
  /** Short label for the clip scoring agent, e.g. "Anthropic / claude-sonnet-4-5". */
  llmModelLabel: string;
  defaultProvider: ProviderId | null;
  configuredProviders: { id: ProviderId; label: string; model: string }[];
  agents: {
    role: AgentRole;
    label: string;
    purpose: string;
    provider: ProviderId | null;
    providerLabel: string;
    model: string | null;
    active: boolean;
  }[];
  stt: 'configured' | 'unavailable';
}

function clipScoringLabel(): string {
  const assignment = config.ai.agents.clip_scoring;
  if (!assignment.providerId) return 'Heuristic scoring';

  const label = resolveProviderRuntime(assignment.providerId).definition.label;
  return assignment.model ? `${label} / ${assignment.model}` : label;
}

export function describeConfig(): ConfigSummary {
  return {
    youtube: config.youtube.demoMode ? 'demo' : 'live',
    scoring: isClipScoringAgentEnabled() ? 'llm' : 'heuristic',
    llmModelLabel: clipScoringLabel(),
    defaultProvider,
    configuredProviders: availableProviders().map((runtime) => ({
      id: runtime.definition.id,
      label: runtime.definition.label,
      model: runtime.defaultModel,
    })),
    agents: AGENT_ROLES.map((role) => {
      const assignment = config.ai.agents[role];
      const definition = AGENT_ROLE_DEFINITIONS[role];
      return {
        role,
        label: definition.label,
        purpose: definition.purpose,
        provider: assignment.providerId,
        providerLabel: assignment.providerId
          ? resolveProviderRuntime(assignment.providerId).definition.label
          : 'Heuristic engine',
        model: assignment.model,
        active: assignment.providerId !== null,
      };
    }),
    stt: config.stt.provider && config.stt.apiKey ? 'configured' : 'unavailable',
  };
}
