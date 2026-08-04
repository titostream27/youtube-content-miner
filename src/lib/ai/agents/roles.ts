/**
 * Agent roles.
 *
 * The pipeline is not one prompt. It is a small crew of specialised agents,
 * each doing a different kind of thinking, and each with different cost and
 * quality characteristics:
 *
 *   discovery         cheap, fast, high volume  -> a small model is fine
 *   episode_triage    cheap, structured         -> a small model is fine
 *   moment_detection  medium, long context      -> a mid model
 *   clip_scoring      the product's core value  -> spend the money here
 *   clip_metadata     creative copywriting      -> mid model, higher temperature
 *
 * Each role can be pointed at a different provider and model via environment
 * variables, which is what makes it practical to score a 400-episode archive
 * without either bankrupting the user or degrading the judgement that matters.
 */

export const AGENT_ROLES = [
  'discovery',
  'episode_triage',
  'moment_detection',
  'clip_scoring',
  'clip_metadata',
  'clip_seo',
  'clip_hook',
  'clip_variants',
  'trending_topic',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentRoleDefinition {
  role: AgentRole;
  label: string;
  purpose: string;
  /** Environment variable selecting this role's provider. */
  providerEnv: string;
  /** Environment variable selecting this role's model. */
  modelEnv: string;
  temperature: number;
  maxOutputTokens: number;
  /** Whether the pipeline can proceed without this agent. */
  optional: boolean;
}

export const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  discovery: {
    role: 'discovery',
    label: 'Discovery Agent',
    purpose:
      'Expands a topic into the search queries a human researcher would actually run, and names the shows worth watching.',
    providerEnv: 'AGENT_DISCOVERY_PROVIDER',
    modelEnv: 'AGENT_DISCOVERY_MODEL',
    temperature: 0.4,
    maxOutputTokens: 1_200,
    optional: true,
  },
  episode_triage: {
    role: 'episode_triage',
    label: 'Episode Triage Agent',
    purpose:
      'Judges topical fit and expected clip density from episode metadata, refining the deterministic opportunity score.',
    providerEnv: 'AGENT_EPISODE_TRIAGE_PROVIDER',
    modelEnv: 'AGENT_EPISODE_TRIAGE_MODEL',
    temperature: 0.1,
    maxOutputTokens: 1_500,
    optional: true,
  },
  moment_detection: {
    role: 'moment_detection',
    label: 'Moment Detection Agent',
    purpose:
      'Reads a transcript window and picks the exact in and out points where a self-contained moment begins and ends.',
    providerEnv: 'AGENT_MOMENT_DETECTION_PROVIDER',
    modelEnv: 'AGENT_MOMENT_DETECTION_MODEL',
    temperature: 0.2,
    maxOutputTokens: 2_000,
    optional: true,
  },
  clip_scoring: {
    role: 'clip_scoring',
    label: 'Clip Scoring Agent',
    purpose:
      'Scores each candidate moment across the ten dimensions and explains why it works. This is the agent that determines product quality.',
    providerEnv: 'AGENT_CLIP_SCORING_PROVIDER',
    modelEnv: 'AGENT_CLIP_SCORING_MODEL',
    temperature: 0.15,
    maxOutputTokens: 8_000,
    optional: false,
  },
  clip_metadata: {
    role: 'clip_metadata',
    label: 'Clip Metadata Agent',
    purpose:
      'Writes the publish-ready title, hook, caption and editing notes for clips that clear the threshold.',
    providerEnv: 'AGENT_CLIP_METADATA_PROVIDER',
    modelEnv: 'AGENT_CLIP_METADATA_MODEL',
    temperature: 0.55,
    maxOutputTokens: 2_000,
    optional: true,
  },
  clip_seo: {
    role: 'clip_seo',
    label: 'Clip SEO Agent',
    purpose:
      'Generates optimized YouTube/TikTok/Reels titles, descriptions and hashtags for a rendered short.',
    providerEnv: 'AGENT_CLIP_SEO_PROVIDER',
    modelEnv: 'AGENT_CLIP_SEO_MODEL',
    temperature: 0.7,
    maxOutputTokens: 1_200,
    optional: true,
  },
  clip_hook: {
    role: 'clip_hook',
    label: 'Clip Hook Agent',
    purpose:
      'Writes a single attention-grabbing spoken hook line (~2-3 seconds) for the short intro scene.',
    providerEnv: 'AGENT_CLIP_HOOK_PROVIDER',
    modelEnv: 'AGENT_CLIP_HOOK_MODEL',
    temperature: 0.8,
    maxOutputTokens: 300,
    optional: true,
  },
  clip_variants: {
    role: 'clip_variants',
    label: 'Clip Variant Agent',
    purpose:
      'Proposes up to three metadata variants (outcome-first, question, controversial) for A/B testing high-quality clips.',
    providerEnv: 'AGENT_CLIP_VARIANTS_PROVIDER',
    modelEnv: 'AGENT_CLIP_VARIANTS_MODEL',
    temperature: 0.7,
    maxOutputTokens: 1_500,
    optional: true,
  },
  trending_topic: {
    role: 'trending_topic',
    label: 'Trending Topic Agent',
    purpose:
      'Turns today mostPopular YouTube videos into the topics worth mining, so scheduled discovery can run with no manual topic input.',
    providerEnv: 'AGENT_TRENDING_TOPIC_PROVIDER',
    modelEnv: 'AGENT_TRENDING_TOPIC_MODEL',
    temperature: 0.3,
    maxOutputTokens: 600,
    optional: true,
  },
};

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}
