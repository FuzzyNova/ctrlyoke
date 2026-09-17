import { SecretStoreUnavailableError, type SecretStore } from "./SecretStore";

/**
 * Composes a preferred SecretStore with a fallback used only when the
 * preferred one reports SecretStoreUnavailableError — e.g. no OS keyring
 * daemon/CLI reachable, such as a headless Linux container or a remote/
 * Codespaces extension host with no local credential store to shell out to.
 *
 * The choice is probed once (a real read, since OsCredentialStore only
 * discovers a missing backend on first use) and memoized for this
 * instance's lifetime, so a permanently-unavailable primary doesn't pay its
 * failure cost on every call.
 */
export class FallbackSecretStore implements SecretStore {
  private resolvedStore: Promise<SecretStore> | undefined;

  constructor(
    private readonly primary: SecretStore,
    private readonly fallback: SecretStore,
    private readonly onFallback?: (error: SecretStoreUnavailableError) => void
  ) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.resolveStore()).get(key);
  }

  async store(key: string, value: string): Promise<void> {
    await (await this.resolveStore()).store(key, value);
  }

  async delete(key: string): Promise<void> {
    await (await this.resolveStore()).delete(key);
  }

  async keys(): Promise<string[]> {
    return (await this.resolveStore()).keys();
  }

  private resolveStore(): Promise<SecretStore> {
    if (!this.resolvedStore) {
      this.resolvedStore = this.probe();
    }
    return this.resolvedStore;
  }

  private async probe(): Promise<SecretStore> {
    try {
      await this.primary.keys();
      return this.primary;
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        this.onFallback?.(error);
        return this.fallback;
      }
      throw error;
    }
  }
}
