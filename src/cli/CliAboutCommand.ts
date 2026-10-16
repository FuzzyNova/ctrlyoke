import * as path from "path";
import {
  INSTALLATION_KINDS,
  readLiveInstallations,
  type InstallationKind,
  type InstallationRecord,
} from "../utils/CtrlyokeInstallations";
import { foldPathForCompare } from "../utils/PathCasing";
import { ctrlyokeStateHome } from "../utils/ProjectStatePaths";
import { isBundledInExtension } from "./CliInstallationNotice";

export const CLI_ABOUT_JSON_SCHEMA_VERSION = 1;

/** How this copy of the CLI was installed. */
export const CLI_DISTRIBUTIONS = {
  NPM: "npm",
  VSCODE_EXTENSION: "vscode-extension",
} as const;

export type CliDistribution =
  (typeof CLI_DISTRIBUTIONS)[keyof typeof CLI_DISTRIBUTIONS];

export interface CliAboutInfo {
  schemaVersion: typeof CLI_ABOUT_JSON_SCHEMA_VERSION;
  version: string;
  packageRoot: string;
  distribution: CliDistribution;
  nodeVersion: string;
  stateHome: string;
  /** Other live installations from `installations.json`, newest first. */
  otherInstallations: Array<{
    kind: InstallationKind;
    version: string;
    packageRoot: string;
    lastSeen: string;
  }>;
}

/**
 * What `ctrlyoke about` reports. `--version` stays a bare version string
 * because scripts compare it; this is where support tells the npm copy from
 * the one bundled in the VS Code extension (CLI_DISTRIBUTION_PLAN.md §3.4).
 */
export function buildCliAboutInfo(
  version: string,
  packageRoot: string,
  installations: readonly InstallationRecord[]
): CliAboutInfo {
  const self = foldPathForCompare(path.resolve(packageRoot));
  return {
    schemaVersion: CLI_ABOUT_JSON_SCHEMA_VERSION,
    version,
    packageRoot,
    distribution: isBundledInExtension(packageRoot)
      ? CLI_DISTRIBUTIONS.VSCODE_EXTENSION
      : CLI_DISTRIBUTIONS.NPM,
    nodeVersion: process.version,
    stateHome: ctrlyokeStateHome(),
    otherInstallations: installations
      .filter(
        (record) =>
          record.kind !== INSTALLATION_KINDS.CLI ||
          foldPathForCompare(path.resolve(record.packageRoot)) !== self
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((record) => ({
        kind: record.kind,
        version: record.version,
        packageRoot: record.packageRoot,
        lastSeen: new Date(record.lastSeen).toISOString(),
      })),
  };
}

const DISTRIBUTION_LABELS: Record<CliDistribution, string> = {
  [CLI_DISTRIBUTIONS.NPM]: "npm package",
  [CLI_DISTRIBUTIONS.VSCODE_EXTENSION]: "bundled with the VS Code extension",
};

export const INSTALLATION_KIND_LABELS: Record<InstallationKind, string> = {
  [INSTALLATION_KINDS.CLI]: "CLI",
  [INSTALLATION_KINDS.VSCODE_EXTENSION]: "VS Code extension",
};

export function formatCliAboutInfo(info: CliAboutInfo): string {
  const lines = [
    `ctrlyoke ${info.version}`,
    `  Installed as:  ${DISTRIBUTION_LABELS[info.distribution]}`,
    `  Package root:  ${info.packageRoot}`,
    `  Node.js:       ${info.nodeVersion}`,
    `  State home:    ${info.stateHome}`,
  ];
  if (info.otherInstallations.length > 0) {
    lines.push("", "Other installations on this machine:");
    for (const other of info.otherInstallations) {
      lines.push(
        `  ${INSTALLATION_KIND_LABELS[other.kind]} ${other.version}  ${other.packageRoot}  (last used ${other.lastSeen})`
      );
    }
  }
  return lines.join("\n");
}

export async function aboutCommand(
  version: string,
  packageRoot: string,
  options: { json?: boolean },
  writeOut: (message: string) => void
): Promise<void> {
  const info = buildCliAboutInfo(
    version,
    packageRoot,
    await readLiveInstallations()
  );
  writeOut(options.json ? JSON.stringify(info) : formatCliAboutInfo(info));
}
