/**
 * Host-neutral telemetry destination. The VS Code extension installs one
 * backed by `@vscode/extension-telemetry` (`src/platform/VsCodeTelemetry.ts`);
 * the standalone CLI installs none, so every report is a no-op there.
 *
 * This module must stay free of `@vscode/extension-telemetry`: that package
 * requires `vscode` at load time, and shared code that reports events is
 * loaded by the CLI in plain Node.
 */
export interface TelemetrySink {
  sendTelemetryEvent(
    eventName: string,
    properties?: Record<string, string>
  ): void;
  sendTelemetryErrorEvent(
    eventName: string,
    properties?: Record<string, string>
  ): void;
  dispose(): Promise<unknown> | void;
}

let reporter: TelemetrySink | undefined;

/** Install (or, with `undefined`, clear) the host's telemetry sink. */
export function setTelemetrySink(sink: TelemetrySink | undefined): void {
  reporter = sink;
}

export function getTelemetry(): TelemetrySink | undefined {
  return reporter;
}

export function disposeTelemetry(): void {
  void reporter?.dispose();
  reporter = undefined;
}
