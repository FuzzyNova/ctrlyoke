import type {
  AttemptCostSource,
  HarnessId,
  HarnessObservedPeriod,
  HarnessQuotaSource,
  HarnessUsageConfidence,
  HarnessUsageUnit,
  HarnessUsageWindowKind,
} from "./DashboardConstants";

export interface HarnessUsageWindow {
  /** Stable normalized key used to replace a pushed/refreshed window. */
  id: string;
  kind: HarnessUsageWindowKind;
  label: string;
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  /** Normalized Unix epoch milliseconds. */
  resetAt?: number;
  windowMinutes?: number;
  unit: HarnessUsageUnit;
  confidence: HarnessUsageConfidence;
}

export interface HarnessObservedTokens {
  input: number;
  cachedInput?: number;
  cacheCreated?: number;
  output: number;
  reasoningOutput?: number;
  total: number;
  /** Summed attempt cost where priceable. */
  costUsd?: number;
  /** Distinct cost provenances represented in costUsd, in stable display order. */
  costSources?: AttemptCostSource[];
  /** True when at least one token-bearing attempt in the window was unpriceable. */
  costPartial?: boolean;
  /** True when at least one attempt in the window had no usable total. */
  partial?: boolean;
  /** Inclusive start of the observed calendar window, in epoch milliseconds. */
  since: number;
}

export interface HarnessQuotaSnapshot {
  harnessId: HarnessId;
  source: HarnessQuotaSource;
  /** Last successful quota fetch/ingest; absent when quota was never available. */
  fetchedAt?: number;
  staleAfterMs: number;
  windows: HarnessUsageWindow[];
  planType?: string;
  message?: string;
  errorCode?: string;
}

export interface HarnessUsageSnapshot {
  harnessId: HarnessId;
  /** When this merged provider + observed snapshot was emitted. */
  updatedAt: number;
  quota: HarnessQuotaSnapshot;
  /** Calendar observed totals; each value carries its own since boundary. */
  observed: Partial<Record<HarnessObservedPeriod, HarnessObservedTokens>>;
}
