import * as fs from "fs";
import * as path from "path";
import { INDEX_SCHEMA_VERSION } from "../core/orchestration/HistorySearchIndexLayout";
import {
  findNewerExtension,
  hasShownNotice,
  INSTALLATION_KINDS,
  markNoticeShown,
  mismatchNoticeKey,
  recordInstallation,
  type InstallationRecord,
} from "../utils/CtrlyokeInstallations";

/**
 * True when this CLI is the copy bundled inside a VS Code extension (its
 * package root is the extension folder), rather than the npm package.
 */
export function isBundledInExtension(packageRoot: string): boolean {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
    ) as { engines?: { vscode?: unknown } };
    return typeof manifest.engines?.vscode === "string";
  } catch {
    return false;
  }
}

export function formatNewerExtensionNotice(
  cliVersion: string,
  extensionVersion: string
): string {
  return (
    `ctrlyoke CLI ${cliVersion} is older than your VS Code extension ` +
    `(${extensionVersion}). Run \`npm install -g ctrlyoke@${extensionVersion}\`.`
  );
}

/**
 * Record this CLI in the installation registry and, once per version pair,
 * warn on stderr when a newer VS Code extension is installed. Warnings go to
 * stderr only, so `--json` stdout stays machine-readable. Never throws.
 */
export async function noteCliInstallation(
  version: string,
  packageRoot: string,
  writeErr: (message: string) => void
): Promise<void> {
  try {
    const self: InstallationRecord = {
      kind: INSTALLATION_KINDS.CLI,
      version,
      packageRoot,
      lastSeen: Date.now(),
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
    };
    const { others } = await recordInstallation(self);
    // The bundled copy always matches its own extension; advising an npm
    // install from inside VS Code would be wrong.
    if (isBundledInExtension(packageRoot)) {
      return;
    }
    const noticed = new Set<string>();
    for (const other of others) {
      const key = mismatchNoticeKey(self.kind, self, other);
      if (await hasShownNotice(key)) {
        noticed.add(key);
      }
    }
    const newer = findNewerExtension(self, others, (key) => noticed.has(key));
    if (!newer) {
      return;
    }
    writeErr(formatNewerExtensionNotice(version, newer.version));
    await markNoticeShown(mismatchNoticeKey(self.kind, self, newer));
  } catch {
    // Advisory only.
  }
}
