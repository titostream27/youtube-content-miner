/**
 * Public surface of the AI layer.
 *
 * The pipeline imports from here only, so provider transports and prompt
 * internals stay private to this folder.
 */

export {
  AGENT_ROLES,
  AGENT_ROLE_DEFINITIONS,
  isAgentRole,
  type AgentRole,
  type AgentRoleDefinition,
} from './agents/roles';

export {
  PROVIDER_CATALOG,
  availableProviders,
  isProviderId,
  providerDefinition,
  resolveProviderRuntime,
  type ProviderDefinition,
  type ProviderId,
  type ProviderProtocol,
  type ProviderRuntime,
} from './providers/catalog';

export {
  AgentResponseError,
  AgentUnavailableError,
  UsageLedger,
  isAgentActive,
  resolveAgent,
  runJsonAgent,
  type AgentCallRecord,
  type AgentOverrides,
  type ResolvedAgent,
} from './client';

export { planDiscovery, fallbackDiscoveryPlan, type DiscoveryPlan } from './agents/discovery-agent';

export { triageEpisodes, type EpisodeTriageJudgement } from './agents/episode-triage-agent';

export { refineMoments } from './agents/moment-detection-agent';

export {
  isClipScoringAgentActive,
  scoreSegmentsWithAgent,
  type ClipScoringResult,
} from './agents/clip-scoring-agent';

export { refineClipMetadata } from './agents/clip-metadata-agent';

export { judgeSegmentHeuristically } from './heuristic-engine';
