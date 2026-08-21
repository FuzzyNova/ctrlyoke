import {
  HARNESS_INFO,
  HARNESS_QUOTA_SOURCES,
  type HarnessId,
} from "../../../../types/DashboardConstants";
import type {
  HarnessQuotaSnapshot,
  HarnessUsageSnapshot,
  HarnessUsageWindow,
} from "../../../../types/UsageTypes";
import {
  isHarnessQuotaStale,
  isHarnessUsageWindowStale,
} from "../../../../types/UsageTypes";

export interface QueuedHarnessAttempt {
  harnessId: HarnessId;
}

export interface UsageSelectionAssistInput {
  usageTrackingEnabled?: boolean;
  /** Remaining AI attempts, used for context only and never quota math. */
  queuedAttempts: readonly QueuedHarnessAttempt[];
  snapshots: readonly HarnessUsageSnapshot[];
  warningPercentUsed: number;
  now?: number;
}

export interface UsageSelectionWarning {
  triggeringHarnessId: HarnessId;
  triggeringWindow: HarnessUsageWindow;
  message: string;
}

function isProviderQuotaFresh(
  quota: HarnessQuotaSnapshot,
  now: number
): boolean {
  return (
    quota.source !== HARNESS_QUOTA_SOURCES.UNAVAILABLE &&
    quota.fetchedAt !== undefined &&
    !isHarnessQuotaStale(quota, now)
  );
}

function normalizeThreshold(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 80;
}

function formatResetTime(resetAt: number | undefined): string {
  return resetAt === undefined
    ? "an unknown time"
    : new Date(resetAt).toISOString();
}

/**
 * Decide whether a cached provider quota should produce a pre-launch warning.
 * This function is intentionally synchronous: it never refreshes providers or
 * reads the filesystem, and it never turns queue length into a quota estimate.
 */
export function buildUsageSelectionWarning(
  input: UsageSelectionAssistInput
): UsageSelectionWarning | undefined {
  if (
    input.usageTrackingEnabled === false ||
    input.queuedAttempts.length === 0
  ) {
    return undefined;
  }

  const now = input.now ?? Date.now();
  const threshold = normalizeThreshold(input.warningPercentUsed);
  const queuedHarnesses = new Set(
    input.queuedAttempts.map((attempt) => attempt.harnessId)
  );

  let trigger: { harnessId: HarnessId; window: HarnessUsageWindow } | undefined;
  for (const snapshot of input.snapshots) {
    if (
      !queuedHarnesses.has(snapshot.harnessId) ||
      !isProviderQuotaFresh(snapshot.quota, now)
    ) {
      continue;
    }
    for (const window of snapshot.quota.windows) {
      if (
        window.percentUsed !== undefined &&
        !isHarnessUsageWindowStale(snapshot.quota, window, now) &&
        window.percentUsed >= threshold &&
        (!trigger ||
          window.percentUsed >
            (trigger.window.percentUsed ?? Number.NEGATIVE_INFINITY))
      ) {
        trigger = { harnessId: snapshot.harnessId, window };
      }
    }
  }

  if (!trigger) return undefined;

  const triggeringHarnessName = HARNESS_INFO[trigger.harnessId].name;
  const queueContext = `${input.queuedAttempts.length} remaining AI attempt${input.queuedAttempts.length === 1 ? "" : "s"} queued`;
  const message = `Quota warning: ${queueContext}. ${triggeringHarnessName}'s ${trigger.window.label} window is ${trigger.window.percentUsed}% used and resets at ${formatResetTime(trigger.window.resetAt)}.`;

  return {
    triggeringHarnessId: trigger.harnessId,
    triggeringWindow: { ...trigger.window },
    message,
  };
}
