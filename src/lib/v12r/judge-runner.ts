/**
 * Brief V12R Phase H — Judge runner.
 *
 * Runs one judge tier against one candidate packet through the existing
 * provider transport layer (getTransport), with retries, JSON recovery and
 * honest failure isolation: provider failures and parse failures are
 * recorded as separate outcomes (R6). The runner does NOT use the production
 * agent roles — judges are configured explicitly per tier via environment
 * variables so they stay independent of the production selector (R4).
 */
import { getTransport } from '@/lib/ai/providers';
import { AiProviderError } from '@/lib/ai/providers/types';
import { extractJson } from '@/lib/ai/client';
import type { ProviderId } from '@/lib/ai/providers/catalog';
import { buildJudgePrompt } from './judge-prompts';
import { judgeOutputSchema, type JudgeCall, type JudgeTier } from './judge-types';
import type { JudgeInputContract } from './judge-types';

export interface JudgeTierConfig {
  provider: ProviderId;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  /** Extra body fields, e.g. `{ thinking: { type: 'disabled' } }` for 9router. */
  extraBody?: Record<string, unknown>;
}

const DEFAULT_TIER_CONFIG: Record<JudgeTier, JudgeTierConfig> = {
  A: {
    provider: 'deepseek',
    model: 'ds/deepseek-v4-flash',
    maxOutputTokens: 1500,
    temperature: 0.2,
    extraBody: { thinking: { type: 'disabled' } },
  },
  B: {
      provider: 'openrouter',
      model: 'tr/moonshotai/kimi-k3-free',
      maxOutputTokens: 1500,
      temperature: 0.2,
    },
  C: {
    provider: 'openai',
    model: 'cx/gpt-5.6-luna',
    maxOutputTokens: 1500,
    temperature: 0.2,
  },
};

/** Override any tier from the environment (V12R_JUDGE_A_PROVIDER=...). */
export function judgeTierConfig(tier: JudgeTier): JudgeTierConfig {
  const base = DEFAULT_TIER_CONFIG[tier];
  const envProvider = process.env[`V12R_JUDGE_${tier}_PROVIDER`]?.trim();
  const envModel = process.env[`V12R_JUDGE_${tier}_MODEL`]?.trim();
  return {
    ...base,
    provider: (envProvider as ProviderId) ?? base.provider,
    model: envModel ?? base.model,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call one judge on one candidate. Never throws for a model/provider failure:
 * it returns a `JudgeCall` with status `provider_error` or `parse_failure`,
 * which the consensus layer treats as a separate outcome (R6).
 */
export async function callJudge(
  tier: JudgeTier,
  contract: JudgeInputContract,
  opts: { maxRetries?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JudgeCall> {
  const config = judgeTierConfig(tier);
  const template = judgeTierConfig(tier);
  const prompt = buildJudgePrompt(tier, contract);
  const transport = getTransport(config.provider);
  const maxRetries = opts.maxRetries ?? 1;
  const startedAt = Date.now();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 90_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const result = await transport.complete({
        model: config.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: config.temperature ?? 0.2,
        maxOutputTokens: config.maxOutputTokens,
        jsonMode: true,
        signal,
        extraBody: config.extraBody,
      });
      const raw = result.text;
      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch (error) {
        return {
          tier,
          providerId: config.provider,
          model: result.model,
          raw_text: raw,
          output: null,
          status: 'parse_failure',
          error: error instanceof Error ? error.message : String(error),
          attempts: attempt,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          duration_ms: Date.now() - startedAt,
        };
      }
      const validated = judgeOutputSchema.safeParse(parsed);
      if (!validated.success) {
        return {
          tier,
          providerId: config.provider,
          model: result.model,
          raw_text: raw,
          output: null,
          status: 'parse_failure',
          error: `schema mismatch: ${validated.error.issues.map((i) => i.path.join('.') + ':' + i.message).join('; ')}`,
          attempts: attempt,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          duration_ms: Date.now() - startedAt,
        };
      }
      return {
        tier,
        providerId: config.provider,
        model: result.model,
        raw_text: raw,
        output: validated.data,
        status: 'ok',
        error: null,
        attempts: attempt,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        duration_ms: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;
      if (opts.signal?.aborted) {
        return {
          tier,
          providerId: config.provider,
          model: template.model,
          raw_text: '',
          output: null,
          status: 'provider_error',
          error: 'aborted by caller',
          attempts: attempt,
          input_tokens: null,
          output_tokens: null,
          duration_ms: Date.now() - startedAt,
        };
      }
      const retryable =
        error instanceof AiProviderError && error.retryable;
      if (attempt <= maxRetries && retryable) {
        await delay(Math.min(8_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      return {
        tier,
        providerId: config.provider,
        model: template.model,
        raw_text: '',
        output: null,
        status: 'provider_error',
        error: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        input_tokens: null,
        output_tokens: null,
        duration_ms: Date.now() - startedAt,
      };
    }
  }
  return {
    tier,
    providerId: config.provider,
    model: template.model,
    raw_text: '',
    output: null,
    status: 'provider_error',
    error: lastError instanceof Error ? lastError.message : String(lastError),
    attempts: maxRetries + 1,
    input_tokens: null,
    output_tokens: null,
    duration_ms: Date.now() - startedAt,
  };
}