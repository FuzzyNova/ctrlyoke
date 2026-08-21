import * as assert from "assert";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  HarnessQuotaSnapshot,
  HarnessUsageSnapshot,
} from "../../types/UsageTypes";
import { buildUsageSelectionWarning } from "../../core/harness/shared/usage/UsageSelectionAssist";

suite("UsageSelectionAssist", () => {
  const now = 1_800_000_000_000;
  const resetAt = now + 60 * 60 * 1000;

  function snapshot(
    harnessId: (typeof HARNESS_IDS)[keyof typeof HARNESS_IDS],
    percentUsed: number,
    options: {
      source?: HarnessQuotaSnapshot["source"];
      fetchedAt?: number;
      staleAfterMs?: number;
      windowMinutes?: number;
    } = {}
  ): HarnessUsageSnapshot {
    return {
      harnessId,
      updatedAt: now,
      quota: {
        harnessId,
        source: options.source ?? HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
        fetchedAt: options.fetchedAt ?? now,
        staleAfterMs: options.staleAfterMs ?? 5 * 60 * 1000,
        windows: [
          {
            id: "five-hour",
            kind: HARNESS_USAGE_WINDOW_KINDS.ROLLING,
            label: "5h",
            percentUsed,
            resetAt,
            windowMinutes: options.windowMinutes ?? 300,
            unit: HARNESS_USAGE_UNITS.PERCENT,
            confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
          },
        ],
      },
      observed: {},
    };
  }

  function input(
    snapshots: readonly HarnessUsageSnapshot[],
    queuedHarness: HarnessId = HARNESS_IDS.CLAUDE_CLI
  ) {
    return {
      queuedAttempts: [{ harnessId: queuedHarness }],
      snapshots,
      warningPercentUsed: 80,
      now,
    };
  }

  test("warns at the threshold boundary, but not below it", () => {
    assert.ok(
      buildUsageSelectionWarning(input([snapshot(HARNESS_IDS.CLAUDE_CLI, 80)]))
    );
    assert.strictEqual(
      buildUsageSelectionWarning(
        input([snapshot(HARNESS_IDS.CLAUDE_CLI, 79.99)])
      ),
      undefined
    );
  });

  test("suppresses unavailable and stale quota snapshots", () => {
    assert.strictEqual(
      buildUsageSelectionWarning(
        input([
          snapshot(HARNESS_IDS.CLAUDE_CLI, 95, {
            source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
          }),
        ])
      ),
      undefined
    );
    assert.strictEqual(
      buildUsageSelectionWarning(
        input([
          snapshot(HARNESS_IDS.CLAUDE_CLI, 95, {
            fetchedAt: now - 6 * 60 * 1000,
          }),
        ])
      ),
      undefined
    );
  });

  test("warns for a fresh finite Copilot monthly window, but not stale or unlimited data", () => {
    const copilotSnapshot = snapshot(HARNESS_IDS.COPILOT_CLI, 95, {
      windowMinutes: undefined,
    });
    copilotSnapshot.quota.windows[0] = {
      ...copilotSnapshot.quota.windows[0],
      id: "copilot:premium_interactions",
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      label: "Premium interactions",
      windowMinutes: undefined,
      used: 1_425,
      limit: 1_500,
    };
    assert.ok(
      buildUsageSelectionWarning(
        input([copilotSnapshot], HARNESS_IDS.COPILOT_CLI)
      )
    );

    const stale = snapshot(HARNESS_IDS.COPILOT_CLI, 95, {
      fetchedAt: now - 6 * 60 * 1000,
      windowMinutes: undefined,
    });
    stale.quota.windows[0] = {
      ...stale.quota.windows[0],
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      windowMinutes: undefined,
    };
    assert.strictEqual(
      buildUsageSelectionWarning(input([stale], HARNESS_IDS.COPILOT_CLI)),
      undefined
    );

    const unavailable = snapshot(HARNESS_IDS.COPILOT_CLI, 95, {
      source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
      windowMinutes: undefined,
    });
    unavailable.quota.windows[0] = {
      ...unavailable.quota.windows[0],
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      windowMinutes: undefined,
    };
    assert.strictEqual(
      buildUsageSelectionWarning(input([unavailable], HARNESS_IDS.COPILOT_CLI)),
      undefined
    );

    const unlimited = snapshot(HARNESS_IDS.COPILOT_CLI, 95, {
      windowMinutes: undefined,
    });
    unlimited.quota.windows[0] = {
      ...unlimited.quota.windows[0],
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      windowMinutes: undefined,
      percentUsed: undefined,
      used: 1_425,
      limit: undefined,
      isUnlimited: true,
    };
    assert.strictEqual(
      buildUsageSelectionWarning(input([unlimited], HARNESS_IDS.COPILOT_CLI)),
      undefined
    );
  });

  test("names the triggering window and reset time", () => {
    const warning = buildUsageSelectionWarning(
      input([snapshot(HARNESS_IDS.CLAUDE_CLI, 95)])
    );
    assert.ok(warning);
    assert.match(warning.message, /5h/);
    assert.ok(warning.message.includes(new Date(resetAt).toISOString()));
  });

  test("does not warn when no AI attempt remains queued", () => {
    assert.strictEqual(
      buildUsageSelectionWarning({
        ...input([snapshot(HARNESS_IDS.CLAUDE_CLI, 95)]),
        queuedAttempts: [],
      }),
      undefined
    );
  });

  test("respects the master off switch", () => {
    assert.strictEqual(
      buildUsageSelectionWarning({
        ...input([snapshot(HARNESS_IDS.CLAUDE_CLI, 99)]),
        usageTrackingEnabled: false,
      }),
      undefined
    );
  });
});
