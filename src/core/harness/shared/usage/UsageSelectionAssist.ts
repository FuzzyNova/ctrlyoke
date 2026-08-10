import {
  HARNESS_IDS,
  HARNESS_INFO,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_WINDOW_KINDS,
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

/** Percentage-point difference required before a fallback is actionable. */
export const MATERIALLY_LESS_USED_PERCENT = 10;

export interface QueuedHarnessAttempt {
  harnessId: HarnessId;
}

export interface UsageSelectionAssistInput {
  usageTrackingEnabled?: boolean;
  /** Remaining AI attempts, used for context only and never quota math. */
  queuedAttempts: readonly QueuedHarnessAttempt[];
  snapshots: readonly HarnessUsageSnapshot[];
  warningPercentUsed: number;
  preferredFallbackOrder: readonly HarnessId[];
  now?: number;
}

export interface UsageSelectionWarning {
  triggeringHarnessId: HarnessId;
  triggeringWindow: HarnessUsageWindow;
  fallbackHarnessId?: HarnessId;
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

function isComparableWindow(
  triggeringWindow: HarnessUsageWindow,
  candidateWindow: HarnessUsageWindow
): boolean {
  if (triggeringWindow.unit !== candidateWindow.unit) return false;
  if (
    triggeringWindow.windowMinutes !== undefined &&
    candidateWindow.windowMinutes !== undefined
  ) {
    return triggeringWindow.windowMinutes === candidateWindow.windowMinutes;
  }
  return (
    triggeringWindow.kind === candidateWindow.kind &&
    triggeringWindow.kind !== HARNESS_USAGE_WINDOW_KINDS.UNKNOWN
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

function orderedHarnessIds(
  preferredFallbackOrder: readonly HarnessId[]
): readonly HarnessId[] {
  const validIds = new Set(Object.values(HARNESS_IDS) as HarnessId[]);
  const ordered: HarnessId[] = [];
  for (const harnessId of preferredFallbackOrder) {
    if (validIds.has(harnessId) && !ordered.includes(harnessId)) {
      ordered.push(harnessId);
    }
  }
  for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
    if (!ordered.includes(harnessId)) ordered.push(harnessId);
  }
  return ordered;
}

function findFallbackHarness(
  triggeringHarnessId: HarnessId,
  triggeringWindow: HarnessUsageWindow,
  snapshotsByHarness: ReadonlyMap<HarnessId, HarnessUsageSnapshot>,
  preferredFallbackOrder: readonly HarnessId[],
  now: number
): HarnessId | undefined {
  for (const harnessId of orderedHarnessIds(preferredFallbackOrder)) {
    if (harnessId === triggeringHarnessId) continue;
    const snapshot = snapshotsByHarness.get(harnessId);
    if (!snapshot || !isProviderQuotaFresh(snapshot.quota, now)) continue;

    const candidate = snapshot.quota.windows.find(
      (window) =>
        window.percentUsed !== undefined &&
        !isHarnessUsageWindowStale(snapshot.quota, window, now) &&
        isComparableWindow(triggeringWindow, window) &&
        window.percentUsed <=
          (triggeringWindow.percentUsed ?? 100) - MATERIALLY_LESS_USED_PERCENT
    );
    if (candidate) return harnessId;
  }
  return undefined;
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
  const snapshotsByHarness = new Map(
    input.snapshots.map((snapshot) => [snapshot.harnessId, snapshot])
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

  const fallbackHarnessId = findFallbackHarness(
    trigger.harnessId,
    trigger.window,
    snapshotsByHarness,
    input.preferredFallbackOrder,
    now
  );
  const triggeringHarnessName = HARNESS_INFO[trigger.harnessId].name;
  const queueContext = `${input.queuedAttempts.length} remaining AI attempt${input.queuedAttempts.length === 1 ? "" : "s"} queued`;
  const fallbackContext = fallbackHarnessId
    ? ` Consider ${HARNESS_INFO[fallbackHarnessId].name}; its comparable window is materially less used.`
    : "";
  const message = `Quota warning: ${queueContext}. ${triggeringHarnessName}'s ${trigger.window.label} window is ${trigger.window.percentUsed}% used and resets at ${formatResetTime(trigger.window.resetAt)}.${fallbackContext}`;

  return {
    triggeringHarnessId: trigger.harnessId,
    triggeringWindow: { ...trigger.window },
    ...(fallbackHarnessId ? { fallbackHarnessId } : {}),
    message,
  };
}
