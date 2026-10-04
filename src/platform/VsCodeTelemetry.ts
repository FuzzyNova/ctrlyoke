import { TelemetryReporter } from "@vscode/extension-telemetry";
import { TELEMETRY_CONNECTION_STRING } from "../utils/BuildConfig";
import { setTelemetrySink } from "../utils/TelemetryReporter";

/**
 * Creates the extension's telemetry reporter and installs it as the shared
 * telemetry sink. No-op when no connection string was injected at build time
 * — see BuildConfig.ts. The reporter itself still respects
 * `vscode.env.isTelemetryEnabled` and the user's `telemetry.telemetryLevel`
 * setting before sending anything.
 */
export function initVsCodeTelemetry(): void {
  if (!TELEMETRY_CONNECTION_STRING) {
    return;
  }
  setTelemetrySink(new TelemetryReporter(TELEMETRY_CONNECTION_STRING));
}
