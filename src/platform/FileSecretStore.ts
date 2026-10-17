import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "../utils/AtomicFileUtils";
import { withFileLock } from "../utils/FileLockUtils";
import { ctrlyokeStateHome } from "../utils/ProjectStatePaths";
import type { SecretStore } from "./SecretStore";

const SECRET_FILE_NAME = "secrets.json";
const SECRET_FILE_MODE = 0o600;
const SECRET_DIRECTORY_MODE = 0o700;
/** Any group or other permission bit makes the file readable beyond its owner. */
const NON_OWNER_PERMISSION_BITS = 0o077;

/** Where the Node hosts keep secrets when no OS credential store is available. */
export function defaultSecretFilePath(): string {
  return path.join(ctrlyokeStateHome(), SECRET_FILE_NAME);
}

export interface FileSecretStoreOptions {
  readonly filePath?: string;
  /** Called once per instance when the file is readable by other users. */
  readonly onInsecurePermissions?: (filePath: string, mode: number) => void;
  /** Mode bits are meaningless on Windows, so the check is skipped there. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Plaintext JSON secret storage for headless hosts with no OS credential store
 * (containers, servers without a D-Bus session). Encryption with a key kept
 * beside the file would protect nothing, so the protection is the file mode:
 * `0600`, re-applied on every write. This matches how `gh`, `docker`, git's
 * `credential-store` and the harness CLIs store logins without a keyring.
 *
 * Every operation re-reads the file, because `ctrlyoke server` and
 * `ctrlyoke secret` write it concurrently from separate processes. Writes are
 * atomic replacements under a cross-process file lock.
 */
export class FileSecretStore implements SecretStore {
  readonly filePath: string;
  private readonly onInsecurePermissions: (
    filePath: string,
    mode: number
  ) => void;
  private readonly checksPermissions: boolean;
  private insecurePermissionsReported = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: FileSecretStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultSecretFilePath();
    this.onInsecurePermissions =
      options.onInsecurePermissions ?? (() => undefined);
    this.checksPermissions = (options.platform ?? process.platform) !== "win32";
  }

  async get(key: string): Promise<string | undefined> {
    const values = await this.readValues();
    return Object.hasOwn(values, key) ? values[key] : undefined;
  }

  async store(key: string, value: string): Promise<void> {
    await this.mutate((values) => {
      values[key] = value;
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    await this.mutate((values) => {
      if (!Object.hasOwn(values, key)) return false;
      delete values[key];
      return true;
    });
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.readValues()).sort();
  }

  /**
   * Serializes writes in this process (the file lock alone would only make
   * them poll each other) and, through the lock, against other processes.
   */
  private mutate(
    change: (values: Record<string, string>) => boolean
  ): Promise<void> {
    const queued = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: SECRET_DIRECTORY_MODE,
      });
      await withFileLock(this.filePath, async () => {
        const values = await this.readValues();
        if (!change(values)) return;
        await writeFileAtomic(
          this.filePath,
          `${JSON.stringify(values, null, 2)}\n`,
          { mode: SECRET_FILE_MODE }
        );
      });
    });
    this.writeChain = queued.catch(() => undefined);
    return queued;
  }

  private async readValues(): Promise<Record<string, string>> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    await this.checkPermissions();
    // A damaged file must surface rather than read as empty: the next write
    // would otherwise replace it and lose every secret it held.
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Secret file ${this.filePath} is not valid JSON.`, {
        cause: error,
      });
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((value) => typeof value === "string")
    ) {
      throw new Error(
        `Secret file ${this.filePath} must be a JSON object of string values.`
      );
    }
    return parsed as Record<string, string>;
  }

  private async checkPermissions(): Promise<void> {
    if (!this.checksPermissions || this.insecurePermissionsReported) return;
    const mode = (await fs.stat(this.filePath)).mode & 0o777;
    if ((mode & NON_OWNER_PERMISSION_BITS) === 0) return;
    this.insecurePermissionsReported = true;
    this.onInsecurePermissions(this.filePath, mode);
  }
}
