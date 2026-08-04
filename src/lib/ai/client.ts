import { agentAssignment, config, type AgentAssignment } from '@/lib/config';
import { AGENT_ROLE_DEFINITIONS, type AgentRole } from './agents/roles';
import { getTransport } from './providers';
import {
  AiProviderError,
  isProviderId,
  resolveProviderRuntime,
  type ChatMessage,
  type ChatUsage,
  type ProviderId,
} from './providers';

/**
 * Agent runner.
 *
 * Everything the pipeline needs from an AI provider goes through here:
 * per-role provider selection, optional per-request overrides, timeouts,
 * retries with backoff, JSON recovery, and usage accounting.
 *
 * Individual agents stay thin - they own a prompt and a result shape, and
 * nothing else.
 */

/** Per-request provider/model override, e.g. from an API call body. */
export type AgentOverrides = Partial<
  Record<AgentRole, { provider?: string | null; model?: string | null }>
>;

export interface ResolvedAgent extends AgentAssignment {
  providerLabel: string;
  active: boolean;
}

export function resolveAgent(role: AgentRole, overrides?: AgentOverrides): ResolvedAgent {
  const base = agentAssignment(role);
  const override = config.ai.allowRequestOverrides ? overrides?.[role] : undefined;

  let providerId: ProviderId | null = base.providerId;
  let model: string | null = base.model;

  if (override?.provider !== undefined && override.provider !== null) {
    const requested = override.provider.toLowerCase();
    if (requested === 'heuristic' || requested === 'none') {
      providerId = null;
      model = null;
    } else if (isProviderId(requested)) {
      const runtime = resolveProviderRuntime(requested);
      if (runtime.configured) {
        providerId = requested;
        model = runtime.defaultModel;
      }
    }
  }

  if (override?.model) {
    model = override.model;
  }

  return {
    ...base,
    providerId,
    model,
    providerLabel: providerId
      ? resolveProviderRuntime(providerId).definition.label
      : 'Heuristic engine',
    active: providerId !== null && Boolean(model),
  };
}

export function isAgentActive(role: AgentRole, overrides?: AgentOverrides): boolean {
  return resolveAgent(role, overrides).active;
}

/* -------------------------------------------------------------------------- */
/* Usage accounting                                                           */
/* -------------------------------------------------------------------------- */

export interface AgentCallRecord {
  role: AgentRole;
  providerId: ProviderId;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  attempts: number;
}

/** Collects per-run AI usage so a run can report what it cost. */
export class UsageLedger {
  private readonly records: AgentCallRecord[] = [];

  add(record: AgentCallRecord): void {
    this.records.push(record);
  }

  get calls(): readonly AgentCallRecord[] {
    return this.records;
  }

  summary(): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    byRole: Partial<Record<AgentRole, { calls: number; inputTokens: number; outputTokens: number }>>;
  } {
    const byRole: Partial<
      Record<AgentRole, { calls: number; inputTokens: number; outputTokens: number }>
    > = {};

    let inputTokens = 0;
    let outputTokens = 0;

    for (const record of this.records) {
      inputTokens += record.inputTokens ?? 0;
      outputTokens += record.outputTokens ?? 0;

      const bucket = byRole[record.role] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
      bucket.calls += 1;
      bucket.inputTokens += record.inputTokens ?? 0;
      bucket.outputTokens += record.outputTokens ?? 0;
      byRole[record.role] = bucket;
    }

    return { calls: this.records.length, inputTokens, outputTokens, byRole };
  }
}

/* -------------------------------------------------------------------------- */
/* JSON extraction                                                            */
/* -------------------------------------------------------------------------- */

export class AgentResponseError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = 'AgentResponseError';
    this.raw = raw;
  }
}

/**
 * Recover a JSON value from a model response.
 *
 * Even with JSON mode enabled, providers wrap output in prose or fences often
 * enough that a bare `JSON.parse` loses real results. We strip fences, then
 * fall back to the outermost balanced object or array.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Strip a markdown code fence wherever it appears. The 9router `deepseek`
  // combo can route to different backends (DeepSeek returns bare JSON, Claude
  // wraps it in ```json … ```), sometimes with a line of prose before the
  // fence, so anchoring to the start/end of the string is not enough. Prefer
  // the content *inside* the first fenced block when one exists.
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const withoutFence = (fenced?.[1] ?? trimmed)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const attempt = (candidate: string): unknown | undefined => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  const direct = attempt(withoutFence);
  if (direct !== undefined) return direct;

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = withoutFence.indexOf(open);
    const end = withoutFence.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const sliced = attempt(withoutFence.slice(start, end + 1));
      if (sliced !== undefined) return sliced;
    }
  }

  throw new AgentResponseError('Model response did not contain parseable JSON', text);
}

/* -------------------------------------------------------------------------- */
/* Agent invocation                                                           */
/* -------------------------------------------------------------------------- */

export interface RunAgentParams<T> {
  role: AgentRole;
  system: string;
  user: string;
  /** Validates and narrows the parsed payload. Throw to trigger a retry. */
  parse: (value: unknown) => T;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
  /** Overrides the role's default temperature for this call. */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface RunAgentResult<T> {
  data: T;
  providerId: ProviderId;
  model: string;
  usage: ChatUsage;
  attempts: number;
}

export class AgentUnavailableError extends Error {
  readonly role: AgentRole;

  constructor(role: AgentRole) {
    super(`No AI provider configured for the ${AGENT_ROLE_DEFINITIONS[role].label}`);
    this.name = 'AgentUnavailableError';
    this.role = role;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invoke an agent and return validated, typed JSON.
 *
 * Retries cover both transport failures (429, 5xx, network) and semantic
 * failures (unparseable or schema-invalid output), because in practice the
 * second is at least as common as the first.
 */
export async function runJsonAgent<T>(params: RunAgentParams<T>): Promise<RunAgentResult<T>> {
  const agent = resolveAgent(params.role, params.overrides);

  if (!agent.active || !agent.providerId || !agent.model) {
    throw new AgentUnavailableError(params.role);
  }

  const transport = getTransport(agent.providerId);
  const messages: ChatMessage[] = [
    { role: 'system', content: params.system },
    { role: 'user', content: params.user },
  ];

  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.ai.maxRetries + 1; attempt += 1) {
    const timeout = AbortSignal.timeout(config.ai.requestTimeoutMs);
    const signal = params.signal
      ? AbortSignal.any([params.signal, timeout])
      : timeout;

    try {
      const result = await transport.complete({
        model: agent.model,
        messages,
        temperature: params.temperature ?? agent.temperature,
        maxOutputTokens: params.maxOutputTokens ?? agent.maxOutputTokens,
        jsonMode: true,
        signal,
      });

      const data = params.parse(extractJson(result.text));

      params.ledger?.add({
        role: params.role,
        providerId: result.providerId,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
      });

      return {
        data,
        providerId: result.providerId,
        model: result.model,
        usage: result.usage,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      // The caller aborted deliberately; do not burn retries on it.
      if (params.signal?.aborted) throw error;

      const isLastAttempt = attempt === config.ai.maxRetries + 1;
      const retryable =
        error instanceof AgentResponseError ||
        (error instanceof AiProviderError && error.retryable) ||
        !(error instanceof AiProviderError);

      if (isLastAttempt || !retryable) break;

      await delay(Math.min(8_000, 500 * 2 ** (attempt - 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Agent ${params.role} failed for an unknown reason`);
}
