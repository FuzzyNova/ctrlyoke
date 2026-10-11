import type { SecretStore } from "./SecretStore";
import { getManagedSecretStorageKeyPair } from "./SecretKey";
import { FallbackSecretStore } from "./FallbackSecretStore";
import { parseSecretMetadata } from "./SecretMetadata";

export interface ManagedSecretMigrationResult {
  readonly migrated: number;
  readonly alreadyPresent: number;
  readonly conflicts: number;
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
  onError: (key: string | undefined, error: unknown) => void = () => {},
  onConflict: (key: string) => void = () => {}
): Promise<ManagedSecretMigrationResult> {
  let keys: string[];
  try {
    keys = await source.keys();
  } catch (error) {
    onError(undefined, error);
    return result(0, 0, 0, 1, false);
  }

  const pairs = new Map<string, string>();
  for (const key of keys) {
    const pair = getManagedSecretStorageKeyPair(key);
    if (pair) pairs.set(pair.valueKey, pair.metadataKey);
  }

  let migrated = 0;
  let alreadyPresent = 0;
  let conflicts = 0;
  let failed = 0;
  for (const [valueKey, metadataKey] of pairs) {
    try {
      const sourceValue = await source.get(valueKey);
      const sourceMetadata = await source.get(metadataKey);
      const targetValue = await target.get(valueKey);
      if (target.isUsingFallback) {
        return result(migrated, alreadyPresent, conflicts, failed, true);
      }

      if (targetValue !== undefined && sourceValue !== undefined) {
        if (targetValue === sourceValue) {
          const targetMetadata = await target.get(metadataKey);
          if (target.isUsingFallback) {
            return result(migrated, alreadyPresent, conflicts, failed, true);
          }
          const profileTimestamp =
            parseSecretMetadata(sourceMetadata)?.lastUpdated;
          const targetTimestamp =
            parseSecretMetadata(targetMetadata)?.lastUpdated;
          if (
            sourceMetadata !== undefined &&
            (targetMetadata === undefined ||
              (profileTimestamp !== undefined &&
                targetTimestamp !== undefined &&
                profileTimestamp > targetTimestamp))
          ) {
            await writeAndConfirm(target, metadataKey, sourceMetadata);
            if (target.isUsingFallback) {
              return result(migrated, alreadyPresent, conflicts, failed, true);
            }
          }
          await source.delete(valueKey);
          await source.delete(metadataKey);
          alreadyPresent += 1;
          continue;
        }

        conflicts += 1;
        const profileTimestamp =
          parseSecretMetadata(sourceMetadata)?.lastUpdated;
        const targetMetadata = await target.get(metadataKey);
        if (target.isUsingFallback) {
          return result(migrated, alreadyPresent, conflicts, failed, true);
        }
        const targetTimestamp =
          parseSecretMetadata(targetMetadata)?.lastUpdated;
        if (profileTimestamp === undefined || targetTimestamp === undefined) {
          onConflict(valueKey);
          continue;
        }
        if (profileTimestamp > targetTimestamp) {
          await writeAndConfirm(target, valueKey, sourceValue);
          await writeAndConfirm(target, metadataKey, sourceMetadata!);
          if (target.isUsingFallback) {
            return result(migrated, alreadyPresent, conflicts, failed, true);
          }
          await source.delete(valueKey);
          await source.delete(metadataKey);
          migrated += 1;
        } else {
          await source.delete(valueKey);
          await source.delete(metadataKey);
          alreadyPresent += 1;
        }
        continue;
      }

      if (sourceValue === undefined && sourceMetadata === undefined) continue;
      if (targetValue === undefined && sourceValue !== undefined) {
        await writeAndConfirm(target, valueKey, sourceValue);
      }
      // Profile metadata without its value is orphaned; never let it replace
      // the metadata paired with a value already in the shared store.
      if (sourceValue !== undefined && sourceMetadata !== undefined) {
        await writeAndConfirm(target, metadataKey, sourceMetadata);
      }
      if (target.isUsingFallback) {
        return result(migrated, alreadyPresent, conflicts, failed, true);
      }
      if (sourceValue !== undefined) {
        await source.delete(valueKey);
        migrated += 1;
      }
      if (sourceMetadata !== undefined) await source.delete(metadataKey);
    } catch (error) {
      failed += 1;
      onError(valueKey, error);
    }
  }
  return result(migrated, alreadyPresent, conflicts, failed, false);
}

async function writeAndConfirm(
  target: SecretStore,
  key: string,
  value: string
): Promise<void> {
  await target.store(key, value);
  if ((await target.get(key)) !== value) {
    throw new Error(`Secret store did not confirm writing key ${key}.`);
  }
}

function result(
  migrated: number,
  alreadyPresent: number,
  conflicts: number,
  failed: number,
  skipped: boolean
): ManagedSecretMigrationResult {
  return { migrated, alreadyPresent, conflicts, failed, skipped };
}
