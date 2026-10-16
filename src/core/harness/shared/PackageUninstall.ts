/**
 * PackageUninstall — undo ctrlyoke's machine-global harness integration when a
 * ctrlyoke package is uninstalled. Shared by the VS Code extension's
 * `vscode:uninstall` hook (`src/vscode-uninstall.ts`) and `ctrlyoke uninstall`
 * for the npm package, which has no uninstall hook of its own (npm 7+ never
 * runs a removed package's uninstall scripts).
 *
 * The extension and the npm CLI share one statusline integration: the harness
 * config entries and the `~/.ctrlyoke/bin` launcher they point at. Removing a
 * package therefore only takes the integration out when no other live
 * installation is recorded in `installations.json`; otherwise it is left for
 * that installation, and whichever one is removed last cleans up.
 *
 * Node-only and `vscode`-free. The caller seeds `configService` with the user
 * settings backend, which holds each harness's captured custom command.
 */

import * as os from "os";
import {
  forgetInstallation,
  type InstallationRecord,
} from "../../../utils/CtrlyokeInstallations";
import {
  StatuslineManager,
  type StatuslineRemovalResult,
} from "./StatuslineManager";

export interface PackageUninstallResult extends StatuslineRemovalResult {
  /**
   * Other live installations, newest first. When any exist, nothing was
   * removed: they still use the integration.
   */
  readonly otherInstallations: readonly InstallationRecord[];
}

export async function uninstallPackageIntegration(
  packageRoot: string
): Promise<PackageUninstallResult> {
  const { others } = await forgetInstallation(packageRoot);
  if (others.length > 0) {
    return {
      otherInstallations: others,
      restored: [],
      failed: [],
      launcherRemoved: false,
    };
  }
  // Harness config lives under the real home, never under a workspace.
  return {
    otherInstallations: [],
    ...(await StatuslineManager.removeFromAllHarnesses(os.homedir())),
  };
}
