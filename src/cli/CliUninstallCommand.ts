import {
  uninstallPackageIntegration,
  type PackageUninstallResult,
} from "../core/harness/shared/PackageUninstall";
import { statuslineLauncherDirectory } from "../core/harness/shared/StatuslineLauncher";
import { getHarnessDisplayName } from "../types/DashboardConstants";
import type { InstallationKind } from "../utils/CtrlyokeInstallations";
import { ctrlyokeStateHome } from "../utils/ProjectStatePaths";
import { INSTALLATION_KIND_LABELS } from "./CliAboutCommand";
import { CLI_USAGE_EXIT_CODE } from "./CliExitCode";
import { isBundledInExtension } from "./CliInstallationNotice";

export const CLI_UNINSTALL_JSON_SCHEMA_VERSION = 1;

/** What `ctrlyoke uninstall` did. */
export const CLI_UNINSTALL_OUTCOMES = {
  /** No other installation was live, so the integration was taken out. */
  REMOVED: "removed",
  /** Another installation still uses the integration, so it was left. */
  KEPT: "kept",
} as const;

export type CliUninstallOutcome =
  (typeof CLI_UNINSTALL_OUTCOMES)[keyof typeof CLI_UNINSTALL_OUTCOMES];

export interface CliUninstallInfo {
  schemaVersion: typeof CLI_UNINSTALL_JSON_SCHEMA_VERSION;
  outcome: CliUninstallOutcome;
  restoredHarnesses: string[];
  failedHarnesses: Array<{ harnessId: string; message: string }>;
  launcherRemoved: boolean;
  otherInstallations: Array<{
    kind: InstallationKind;
    version: string;
    packageRoot: string;
  }>;
}

export function buildCliUninstallInfo(
  result: PackageUninstallResult
): CliUninstallInfo {
  return {
    schemaVersion: CLI_UNINSTALL_JSON_SCHEMA_VERSION,
    outcome:
      result.otherInstallations.length > 0
        ? CLI_UNINSTALL_OUTCOMES.KEPT
        : CLI_UNINSTALL_OUTCOMES.REMOVED,
    restoredHarnesses: [...result.restored],
    failedHarnesses: result.failed.map(({ harnessId, message }) => ({
      harnessId,
      message,
    })),
    launcherRemoved: result.launcherRemoved,
    otherInstallations: result.otherInstallations.map(
      ({ kind, version, packageRoot }) => ({ kind, version, packageRoot })
    ),
  };
}

export function formatCliUninstallInfo(info: CliUninstallInfo): string {
  const lines: string[] = [];
  if (info.outcome === CLI_UNINSTALL_OUTCOMES.KEPT) {
    lines.push(
      "Left the harness statusline in place. These ctrlyoke installations still use it:"
    );
    for (const other of info.otherInstallations) {
      lines.push(
        `  ${INSTALLATION_KIND_LABELS[other.kind]} ${other.version}  ${other.packageRoot}`
      );
    }
    lines.push("Whichever one is uninstalled last removes it.");
  } else {
    lines.push(
      info.restoredHarnesses.length > 0
        ? `Removed ctrlyoke's statusline from ${info.restoredHarnesses
            .map(getHarnessDisplayName)
            .join(", ")}, restoring your own command where you had one.`
        : "No harness config had ctrlyoke's statusline."
    );
    if (info.launcherRemoved) {
      lines.push(
        `Removed the statusline scripts from ${statuslineLauncherDirectory()}.`
      );
    }
  }
  // A failure is reported on stderr with its fix; uninstalling now would
  // leave that harness running a script nothing can remove.
  if (info.failedHarnesses.length === 0) {
    lines.push(
      `Settings and run history in ${ctrlyokeStateHome()} are kept; delete that folder to remove them too.`,
      "Now run: npm uninstall -g ctrlyoke"
    );
  }
  return lines.join("\n");
}

export function formatCliUninstallFailures(info: CliUninstallInfo): string {
  return [
    ...info.failedHarnesses.map(
      ({ harnessId, message }) =>
        `Could not update ${getHarnessDisplayName(harnessId)}'s settings: ${message}`
    ),
    "Fix or remove the statusLine entry there by hand, then run `ctrlyoke uninstall` again.",
  ].join("\n");
}

export const BUNDLED_CLI_UNINSTALL_MESSAGE =
  "This is the ctrlyoke CLI bundled with the VS Code extension. Uninstall the " +
  "extension from VS Code instead; it cleans up after itself.";

/**
 * Undo this npm package's machine-global harness integration before
 * `npm uninstall -g ctrlyoke`, which runs no uninstall script of its own.
 * Returns the exit code.
 */
export async function uninstallCommand(
  packageRoot: string,
  options: { json?: boolean },
  writeOut: (message: string) => void,
  writeErr: (message: string) => void
): Promise<number> {
  // The bundled copy shares the extension's package root, so forgetting it
  // would forget the extension while it is still installed.
  if (isBundledInExtension(packageRoot)) {
    writeErr(BUNDLED_CLI_UNINSTALL_MESSAGE);
    return CLI_USAGE_EXIT_CODE;
  }
  const info = buildCliUninstallInfo(
    await uninstallPackageIntegration(packageRoot)
  );
  writeOut(options.json ? JSON.stringify(info) : formatCliUninstallInfo(info));
  if (info.failedHarnesses.length > 0) {
    if (!options.json) {
      writeErr(formatCliUninstallFailures(info));
    }
    return CLI_USAGE_EXIT_CODE;
  }
  return 0;
}
