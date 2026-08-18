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
