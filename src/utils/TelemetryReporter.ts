import { TelemetryReporter } from "@vscode/extension-telemetry";
import { TELEMETRY_CONNECTION_STRING } from "./BuildConfig";

let reporter: TelemetryReporter | undefined;

/**
 * Creates the singleton telemetry reporter. No-op (returns undefined) when
 * no connection string was injected at build time — see BuildConfig.ts.
 * The reporter itself still respects `vscode.env.isTelemetryEnabled` and the
 * user's `telemetry.telemetryLevel` setting before sending anything.
 */
export function initTelemetry(): TelemetryReporter | undefined {
  if (!TELEMETRY_CONNECTION_STRING) {
    return undefined;
  }
  reporter = new TelemetryReporter(TELEMETRY_CONNECTION_STRING);
  return reporter;
}

export function getTelemetry(): TelemetryReporter | undefined {
  return reporter;
}

export function disposeTelemetry(): void {
  reporter?.dispose();
  reporter = undefined;
}

/**
 * Test-only seam: inject a fake reporter, bypassing initTelemetry()'s real
 * Application Insights client. Call with undefined to reset between tests.
 */
export function setTelemetryReporterForTests(
  fake: TelemetryReporter | undefined
): void {
  reporter = fake;
}
