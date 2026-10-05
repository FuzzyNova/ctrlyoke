import {
  HARNESS_DISPLAY_ORDER,
  pickFirstAvailableHarness,
  type HarnessId,
} from "../types/DashboardConstants";

/**
 * Process-wide record of which harness CLIs were found installed.
 *
 * Each host feeds it from its own detection: the extension from its
 * integrations' status events, the standalone CLI from an on-demand probe.
 * `ConfigurationUtils.getIntegrationMode()` reads it to resolve an
 * auto-detected (empty) `defaults.harness`. Must stay `vscode`-free; the CLI
 * loads it.
 */
export class HarnessAvailabilityRegistry {
  private readonly available = new Map<HarnessId, boolean>();
  private readonly listeners = new Set<() => void>();

  /** Record one harness's detection result. */
  record(harnessId: HarnessId, available: boolean): void {
    const before = this.getFirstAvailable();
    this.available.set(harnessId, available);
    if (this.getFirstAvailable() !== before) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  /** The first installed harness in display order, if any has been found. */
  getFirstAvailable(): HarnessId | undefined {
    return pickFirstAvailableHarness(
      (harnessId) => this.available.get(harnessId) === true
    );
  }

  /**
   * Probe harnesses in display order until one is installed, reusing earlier
   * results, so a CLI run launches as few `--version` checks as possible.
   */
  async detectFirstAvailable(
    checkAvailability: (harnessId: HarnessId) => Promise<boolean>
  ): Promise<HarnessId | undefined> {
    for (const harnessId of HARNESS_DISPLAY_ORDER) {
      let available = this.available.get(harnessId);
      if (available === undefined) {
        available = await checkAvailability(harnessId).catch(() => false);
        this.record(harnessId, available);
      }
      if (available) {
        return harnessId;
      }
    }
    return undefined;
  }

  /** Subscribe to changes of {@link getFirstAvailable}. Returns an unsubscribe. */
  onFirstAvailableChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forget every detection result (tests). */
  reset(): void {
    this.available.clear();
  }
}

export const harnessAvailability = new HarnessAvailabilityRegistry();
