/**
 * RuntimeMode — identifies whether the process is running as the VS Code
 * extension or the standalone CLI binary.
 *
 * Set once at process startup (cli.ts calls setRuntimeMode('cli')); the
 * default is 'vscode' so the extension never needs to call setRuntimeMode.
 *
 * Use isCli() instead of checking for the absence of a dashboard sink —
 * that proxy breaks if a TUI or other dashboard implementation is ever added.
 */

import { RUNNER_IDS } from "../types/DashboardConstants";
import type { RunnerId } from "../types/DashboardConstants";

let _mode: RunnerId = RUNNER_IDS.VSCODE;

/**
 * Set the runtime mode for this process.
 * Must be called once, early in the startup path, before any module that
 * reads isCli() is imported or used.
 */
export function setRuntimeMode(mode: RunnerId): void {
  _mode = mode;
}

/**
 * Returns true when the current process is the standalone FlightPath CLI
 * binary (i.e. `flightpath run`), false when running inside the VS Code
 * extension host.
 */
export function isCli(): boolean {
  return _mode === RUNNER_IDS.CLI;
}
