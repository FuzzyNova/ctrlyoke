import * as fs from "node:fs/promises";
import type { LicenseService } from "./LicenseService";

/** Path to a file holding the license key, e.g. a Docker secret under `/run/secrets/`. */
export const LICENSE_KEY_FILE_ENV = "CTRLYOKE_LICENSE_KEY_FILE";
/** The license key itself; removed from the environment once read. */
export const LICENSE_KEY_ENV = "CTRLYOKE_LICENSE_KEY";

/** Where a license key supplied to `ctrlyoke server` came from. */
export interface EnvironmentLicenseKey {
  readonly key: string;
  readonly source: typeof LICENSE_KEY_FILE_ENV | typeof LICENSE_KEY_ENV;
}

/**
 * Reads a license key supplied through the environment. The file form wins
 * because a harness subprocess inherits every environment variable; the bare
 * variable is still accepted for convenience but deleted from `environment`
 * here, before anything is spawned, so no child process ever sees it.
 */
export async function takeEnvironmentLicenseKey(
  environment: NodeJS.ProcessEnv = process.env,
  readFile: (filePath: string) => Promise<string> = (filePath) =>
    fs.readFile(filePath, "utf8")
): Promise<EnvironmentLicenseKey | undefined> {
  const inlineKey = environment[LICENSE_KEY_ENV]?.trim();
  delete environment[LICENSE_KEY_ENV];
  const keyFile = environment[LICENSE_KEY_FILE_ENV]?.trim();
  if (keyFile) {
    let contents: string;
    try {
      contents = await readFile(keyFile);
    } catch (error) {
      throw new Error(
        `Could not read the license key file named by ${LICENSE_KEY_FILE_ENV} (${keyFile}).`,
        { cause: error }
      );
    }
    const key = contents.trim();
    if (!key) {
      throw new Error(
        `The license key file named by ${LICENSE_KEY_FILE_ENV} (${keyFile}) is empty.`
      );
    }
    return { key, source: LICENSE_KEY_FILE_ENV };
  }
  return inlineKey ? { key: inlineKey, source: LICENSE_KEY_ENV } : undefined;
}

/**
 * Activates a key supplied through the environment unless it is already the
 * stored one. A container restarted with the same key therefore reuses its
 * stored activation and Keygen machine instead of registering a new one; a
 * changed key goes through the normal activation path. Returns whether it
 * activated.
 */
export async function applyEnvironmentLicenseKey(
  licenseService: Pick<
    LicenseService,
    "getStoredLicenseKey" | "activateWithKey"
  >,
  key: string
): Promise<boolean> {
  if ((await licenseService.getStoredLicenseKey()) === key) {
    return false;
  }
  await licenseService.activateWithKey(key);
  return true;
}
