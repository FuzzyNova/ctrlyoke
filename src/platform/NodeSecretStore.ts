import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";
import { FallbackSecretStore } from "./FallbackSecretStore";
import { FileSecretStore } from "./FileSecretStore";
import { OsCredentialStore } from "./OsCredentialStore";
import type { SecretStore } from "./SecretStore";

export interface NodeSecretStoreOptions {
  /**
   * Receives each warning in addition to the log file. Commands a person runs
   * pass stderr here; in CLI mode `Log` writes only to the log file.
   */
  readonly warn?: (message: string) => void;
  /** Tests substitute both backends. */
  readonly primary?: SecretStore;
  readonly fallback?: FileSecretStore;
}

/** The OS credential store, falling back to a `FileSecretStore`. */
export class NodeSecretStore extends FallbackSecretStore {
  constructor(
    primary: SecretStore,
    readonly fileStore: FileSecretStore,
    onFallback: ConstructorParameters<typeof FallbackSecretStore>[2]
  ) {
    super(primary, fileStore, onFallback);
  }
}

/**
 * The one secret store for every Node host: `ctrlyoke server`, `ctrlyoke
 * secret`, the server's pre-start license check and `CliAdapter`'s default.
 * Building it in one place keeps them on the same backend, so a license or
 * secret saved by one is found by the others.
 *
 * The OS credential store is preferred. Where it is unavailable (a container
 * or headless server with no D-Bus keyring), secrets go to an unencrypted
 * `0600` file in the state home, which persists on the same volume as run
 * history.
 */
export function createNodeSecretStore(
  options: NodeSecretStoreOptions = {}
): NodeSecretStore {
  const warn = (message: string, logDetail?: string): void => {
    Log.warn(logDetail ? `${message} ${logDetail}` : message);
    options.warn?.(message);
  };
  const fileStore =
    options.fallback ??
    new FileSecretStore({
      onInsecurePermissions: (filePath, mode) =>
        warn(
          `ctrlyoke: ${filePath} is readable by other users (mode ${mode.toString(8).padStart(4, "0")}); restrict it with chmod 600.`
        ),
    });
  return new NodeSecretStore(
    options.primary ?? new OsCredentialStore(),
    fileStore,
    (error) =>
      warn(
        `ctrlyoke: OS credential store unavailable, so secrets are stored unencrypted in ${fileStore.filePath}, readable only by this user.`,
        getErrorMessage(error.cause ?? error)
      )
  );
}
