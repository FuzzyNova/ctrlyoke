import { HARNESS_STATUS_STRINGS } from "../../../types/DashboardConstants";
import type {
  HarnessAvailabilityReport,
  HarnessStatusInfo,
} from "../../../types/WebviewMessageTypes";
import {
  assessHarnessVersion,
  type HarnessVersionAssessment,
} from "../../../utils/HarnessVersion";
import type { ICliProvider } from "./interfaces/ICliProvider";

export interface HarnessDetectionResult {
  /** Installed and answering. A version below the minimum never makes it unavailable. */
  available: boolean;
  /** Raw `--version` output, when the CLI answered. */
  rawVersion?: string;
  /** Absent when the CLI is not installed at all. */
  version?: HarnessVersionAssessment;
}

/**
 * The single definition of "this harness can run": the CLI answers. Its version
 * is assessed against `config.versionPolicy` for guidance only — a CLI below
 * `minimum` is still launched, with a warning. Every host's detection goes
 * through here — `CliIntegration.initialize()` (extension, CLI runs),
 * `IntegrationFactory.detectDefaultHarness()` (CLI auto-detected default), and
 * `HarnessCapabilityRegistry` — so they never disagree about an old CLI.
 */
export async function detectHarness(
  provider: Pick<ICliProvider, "checkAvailability" | "getVersion" | "config">
): Promise<HarnessDetectionResult> {
  if (!(await provider.checkAvailability())) {
    return { available: false };
  }
  const rawVersion = await provider.getVersion?.();
  const version = assessHarnessVersion(
    rawVersion,
    provider.config.versionPolicy
  );
  return {
    available: true,
    ...(rawVersion ? { rawVersion } : {}),
    version,
  };
}

/**
 * Project a detection report into the dashboard's status payload. Shared by
 * the VS Code panel (`WebviewSettingsSync`) and the hosted server so the two
 * transports cannot drift.
 */
export function toHarnessStatusInfo(
  report: HarnessAvailabilityReport
): HarnessStatusInfo {
  return {
    available: report.available,
    status: report.available
      ? HARNESS_STATUS_STRINGS.AVAILABLE
      : HARNESS_STATUS_STRINGS.UNAVAILABLE,
    installCommand: report.installCommand,
    ...(report.version ? { version: report.version } : {}),
  };
}
