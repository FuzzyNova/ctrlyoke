/**
 * Platform-neutral contract for encrypted secret storage.
 *
 * Implementations must keep values in a platform credential store. Callers
 * should use SecretKey helpers for managed secret names rather than inventing
 * their own key prefixes.
 */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
  keys(): PromiseLike<string[]>;
}

/** Raised when the host has no usable encrypted credential-store backend. */
export class SecretStoreUnavailableError extends Error {
  constructor(platform: NodeJS.Platform, cause?: unknown) {
    super(
      `No encrypted OS credential store is available for ${platform}. ` +
        "Use env passthrough (export the credential's environment variable) " +
        "or install and enable the platform credential-store backend."
    );
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: cause,
      });
    }
    this.name = "SecretStoreUnavailableError";
  }
}
