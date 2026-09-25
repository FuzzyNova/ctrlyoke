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
import {
  findOlderCli,
  hasShownNotice,
  INSTALLATION_KINDS,
  markNoticeShown,
  mismatchNoticeKey,
  recordInstallation,
  type InstallationRecord,
} from "../utils/CtrlyokeInstallations";
import type { UserInteractionPort } from "./UserInteractionPort";

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

const OLDER_CLI_NOTICE_ID = "ctrlyoke.olderCliNotice";
const UPDATE_CLI_CHOICE = "update";
const DISMISS_CHOICE = "dismiss";

/**
 * Record this extension in the installation registry and, once per version
 * pair, tell the user when an older npm CLI shares this machine's state
 * (CLI_DISTRIBUTION_PLAN.md §3.4 rule 2). The registry write happens at once;
 * the notice waits for a dashboard client that can show it. Never throws.
 */
export async function noteExtensionInstallation(
  context: vscode.ExtensionContext,
  getInteractionPort: () => Promise<UserInteractionPort>
): Promise<void> {
  try {
    const self: InstallationRecord = {
      kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
      version: String(context.extension.packageJSON.version),
      packageRoot: context.extensionPath,
      lastSeen: Date.now(),
    };
    const { others } = await recordInstallation(self);
    const olderCli = findOlderCli(self, others);
    if (!olderCli) {
      return;
    }
    const noticeKey = mismatchNoticeKey(self.kind, olderCli, self);
    if (await hasShownNotice(noticeKey)) {
      return;
    }
    const port = await getInteractionPort();
    if (!port.canPrompt()) {
      return;
    }
    await markNoticeShown(noticeKey);
    const choice = await port.requestChoice({
      id: OLDER_CLI_NOTICE_ID,
      title: `ctrlyoke CLI ${olderCli.version} is older than this extension (${self.version})`,
      detail:
        `The CLI installed at ${olderCli.packageRoot} shares run history and settings with ` +
        `this extension. Keep both on the same version so they read that state the same way.`,
      choices: [
        { value: UPDATE_CLI_CHOICE, label: "Show Update Command" },
        { value: DISMISS_CHOICE, label: "Dismiss" },
      ],
    });
    if (choice === UPDATE_CLI_CHOICE) {
      await vscode.commands.executeCommand(VSCODE_COMMANDS.INSTALL_CLI);
    }
  } catch (error) {
    Log.debug(`[CtrlyokeCli] Installation registry check failed: ${error}`);
  }
}
