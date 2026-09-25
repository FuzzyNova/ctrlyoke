/**
 * Exposes the `ctrlyoke` CLI bundled in the VSIX (dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.1).
 *
 * - Integrated terminals get `<extensionPath>/bin` prepended to PATH through
 *   the extension's environment-variable collection. VS Code replaces the
 *   collection on every activation and drops it on uninstall, so an update
 *   never leaves a stale, versioned path behind. The user's system PATH is
 *   never touched.
 * - Harness processes do not inherit that collection; they pick the same
 *   directory up from `registerCtrlyokeBinDirectory()` via
 *   `CliProviderUtils.buildProcessEnv()`.
 * - "Install CLI for Use Outside VS Code" types the matching npm install
 *   command into a terminal without running it.
 */

import * as path from "path";
import * as vscode from "vscode";
import { VSCODE_COMMANDS } from "../types/DashboardConstants";
import {
  ensureCtrlyokeShimsExecutable,
  getCtrlyokeBinDirectory,
  registerCtrlyokeBinDirectory,
} from "../utils/CtrlyokeCliPath";
import { Log } from "../utils/Log";

/** npm package name the CLI is published under. */
export const CTRLYOKE_NPM_PACKAGE = "ctrlyoke";

const INSTALL_CLI_TERMINAL_NAME = "ctrlyoke CLI";

/** `npm install -g ctrlyoke@<version>`, pinned so the CLI matches the extension. */
export function buildCliInstallCommand(version: string): string {
  return `npm install -g ${CTRLYOKE_NPM_PACKAGE}@${version}`;
}

/**
 * Register the bundled launcher directory for harness spawns and put it on
 * PATH for integrated terminals. Call once during activation.
 */
export function exposeBundledCli(context: vscode.ExtensionContext): void {
  registerCtrlyokeBinDirectory(context.extensionPath);
  const collection = context.environmentVariableCollection;
  collection.clear();

  const binDirectory = getCtrlyokeBinDirectory();
  if (!binDirectory) {
    Log.debug(
      `[CtrlyokeCli] No launcher directory under ${context.extensionPath}; terminal PATH left unchanged`
    );
    return;
  }

  ensureCtrlyokeShimsExecutable(binDirectory);
  collection.description = new vscode.MarkdownString(
    "Adds the `ctrlyoke` command-line tool bundled with this extension to `PATH`."
  );
  collection.prepend("PATH", `${binDirectory}${path.delimiter}`);
}

/** Register `ctrlyoke.installCli`. */
export function registerInstallCliCommand(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand(VSCODE_COMMANDS.INSTALL_CLI, () => {
    const version = String(context.extension.packageJSON.version);
    const terminal = vscode.window.createTerminal({
      name: INSTALL_CLI_TERMINAL_NAME,
    });
    terminal.show();
    // Typed, not run: installing a global package is the user's call.
    terminal.sendText(buildCliInstallCommand(version), false);
  });
}
