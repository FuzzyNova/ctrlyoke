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
  private fallbackNotified = false;

  constructor(
    private readonly primary: SecretStore,
    private readonly fallback: SecretStore,
    private readonly onFallback?: (error: SecretStoreUnavailableError) => void
  ) {}

  /** True after this instance has selected its fallback for this lifetime. */
  get isUsingFallback(): boolean {
    return this.resolvedStore !== undefined && this.fallbackNotified;
  }

  async get(key: string): Promise<string | undefined> {
    return this.run((store) => store.get(key));
  }

  async store(key: string, value: string): Promise<void> {
    await this.run((store) => store.store(key, value));
  }

  async delete(key: string): Promise<void> {
    await this.run((store) => store.delete(key));
  }

  async keys(): Promise<string[]> {
    return this.run((store) => store.keys());
  }

  private resolveStore(): Promise<SecretStore> {
    if (!this.resolvedStore) {
      // A transient probe failure (e.g. a dismissed keychain prompt) must not
      // poison every later call, so forget it and probe again next time.
      this.resolvedStore = this.probe().catch((error: unknown) => {
        this.resolvedStore = undefined;
        throw error;
      });
    }
    return this.resolvedStore;
  }

  private async probe(): Promise<SecretStore> {
    try {
      await this.primary.keys();
      return this.primary;
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return this.switchToFallback(error);
      }
      throw error;
    }
  }

  private async run<T>(
    operation: (store: SecretStore) => Thenable<T>
  ): Promise<T> {
    const store = await this.resolveStore();
    try {
      return await operation(store);
    } catch (error) {
      if (
        store !== this.primary ||
        !(error instanceof SecretStoreUnavailableError)
      ) {
        throw error;
      }
      return operation(await this.switchToFallback(error));
    }
  }

  private switchToFallback(error: SecretStoreUnavailableError): SecretStore {
    if (this.resolvedStore !== undefined && !this.fallbackNotified) {
      this.fallbackNotified = true;
      this.resolvedStore = Promise.resolve(this.fallback);
      this.onFallback?.(error);
    }
    return this.fallback;
  }
}
