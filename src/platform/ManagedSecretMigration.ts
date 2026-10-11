import type { SecretStore } from "./SecretStore";
import { isManagedSecretStorageKey } from "./SecretKey";
import { FallbackSecretStore } from "./FallbackSecretStore";

export interface ManagedSecretMigrationResult {
  readonly migrated: number;
  readonly failed: number;
  readonly skipped: boolean;
}

/**
 * Move legacy managed secrets from VS Code profile storage into the shared
 * store. Non-managed entries (including license and server tokens) are never
 * touched. If the shared store selected the VS Code fallback, leave the
 * source entries in place because source and destination are the same store.
 */
export async function migrateManagedSecrets(
  source: SecretStore,
  target: FallbackSecretStore,
  onError: (key: string | undefined, error: unknown) => void = () => {}
): Promise<ManagedSecretMigrationResult> {
  let keys: string[];
  try {
    keys = (await source.keys()).filter(isManagedSecretStorageKey);
  } catch (error) {
    onError(undefined, error);
    return { migrated: 0, failed: 1, skipped: false };
  }

  let migrated = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      const existing = await target.get(key);
      if (target.isUsingFallback) {
        return { migrated, failed, skipped: true };
      }
      if (existing === undefined) {
        const value = await source.get(key);
        if (value === undefined) continue;
        await target.store(key, value);
      }
      if (target.isUsingFallback) {
        return { migrated, failed, skipped: true };
      }
      await source.delete(key);
      migrated += 1;
    } catch (error) {
      failed += 1;
      onError(key, error);
    }
  }
  return { migrated, failed, skipped: false };
}
