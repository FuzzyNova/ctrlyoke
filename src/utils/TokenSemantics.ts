import {
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  ATTEMPT_COST_REASONING_RELATIONSHIPS,
  HARNESS_IDS,
  type AttemptCostCacheRelationship,
  type AttemptCostReasoningRelationship,
  type HarnessId,
} from "../types/DashboardConstants";

export interface HarnessTokenSemantics {
  /** Whether cache-read tokens are included in the harness input count. */
  cacheInputRelationship: AttemptCostCacheRelationship;
  /** Whether separately reported reasoning tokens are already in output. */
  reasoningRelationship: AttemptCostReasoningRelationship;
}

/**
 * Provider token relationships shared by cost calculation and display formatting.
 * Keep this module free of extension-host dependencies because webview formatters
 * consume the same table.
 */
export const HARNESS_TOKEN_SEMANTICS: Record<HarnessId, HarnessTokenSemantics> =
  {
    [HARNESS_IDS.CLAUDE_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNREPORTED,
    },
    [HARNESS_IDS.CODEX_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET,
      reasoningRelationship:
        ATTEMPT_COST_REASONING_RELATIONSHIPS.INCLUDED_IN_OUTPUT,
    },
    [HARNESS_IDS.QWEN_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN,
    },
    [HARNESS_IDS.OPENCODE_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN,
    },
    [HARNESS_IDS.ANTIGRAVITY_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN,
    },
    [HARNESS_IDS.COPILOT_CLI]: {
      cacheInputRelationship: ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
      reasoningRelationship: ATTEMPT_COST_REASONING_RELATIONSHIPS.UNREPORTED,
    },
  };
