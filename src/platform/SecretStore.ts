/**
 * Platform-neutral contract for encrypted secret storage.
 *
 * Implementations must keep values in a platform credential store. Callers
 * should use SecretKey helpers for managed secret names rather than inventing
 * their own key prefixes.
 */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
  keys(): Thenable<string[]>;
}

/** Raised when the host has no usable encrypted credential-store backend. */
export class SecretStoreUnavailableError extends Error {
  constructor(platform: NodeJS.Platform, cause?: unknown) {
    super(
      `No encrypted OS credential store is available for ${platform}. ` +
        "Use env passthrough (export the credential's environment variable) " +
        "or install and enable the platform credential-store backend.",
      { cause }
    );
    this.name = "SecretStoreUnavailableError";
  }
}
