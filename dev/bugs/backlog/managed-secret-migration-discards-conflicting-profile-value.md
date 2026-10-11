# Managed-secret migration discards a newer profile value, and concurrent writes can drop index entries

- **Found:** 2026-10-11 by Claude (bug-drain review of 77906c992)
- **Area:** `src/platform/ManagedSecretMigration.ts`, `src/platform/OsCredentialStore.ts`, `src/extension.ts`
- **Severity:** medium

## Symptom

1. **A conflicting value is lost.** When the OS credential store already
   holds a value for a managed-secret key, `migrateManagedSecrets` deletes
   the per-profile value without comparing the two, and still logs it as
   "migrated". This bites in two cases:
   - Before 77906c992, the docs told users to set a secret in both the
     dashboard and the CLI. A user who later rotated it only in the dashboard
     gets the stale CLI value back on activation.
   - When the OS store is temporarily unreachable, `FallbackSecretStore`
     writes to profile storage. The next activation then silently reverts
     that write to the older OS value.

   Each value and its metadata key also migrate separately, so a kept OS
   value can end up paired with the profile's metadata (`lastUpdated`,
   description).
2. **Index entries can be lost.** `OsCredentialStore.addKeyToIndex` and
   `removeKeyFromIndex` read and rewrite the whole `ctrlyoke.secret.index`
   entry with no serialization. The migration starts as a fire-and-forget
   (`void`) in `extension.ts`, alongside `licenseService.refresh()` and
   server-token writes. Two overlapping updates can drop a key from the
   index. Its value survives, but `SecretRegistryService.getManagedNames`
   stops listing it in both the dashboard and the CLI.

## Steps to Reproduce

1. Before 77906c992, set `API_TOKEN` in the CLI to `old`, then in the
   dashboard to `new`.
2. Upgrade and activate: the dashboard now shows `old`.

## Root Cause

- `ManagedSecretMigration.ts` treats "the target already has the key" as
  "already migrated" and deletes the source.
- `OsCredentialStore`'s index is a read-modify-write with no queue.

## Suggested Fix

- Migrate each secret's value and metadata together. If both stores hold
  different values, keep the one whose metadata `lastUpdated` is newer and
  move its metadata with it. If that can't be decided, leave the profile
  entry in place and log a conflict warning. Count entries that were already
  present separately from migrated ones.
- Inside `OsCredentialStore`, run index mutations one at a time through a
  promise chain. Await the migration before `LicenseService` refreshes, or
  otherwise order the startup writes.
- Make `VsCodeAdapter`'s `secretStore` constructor parameter required, so
  nothing can quietly build a per-profile managed store again.
- Tests in `src/test/unit/ManagedSecretMigration.test.ts`:
  - a differing value already in the target (newer wins; metadata travels
    with its value)
  - `target.store` throws (source kept)
  - `source.keys()` throws
  - the OS store becomes unavailable mid-run
  - an `OsCredentialStore` index test with concurrent `store` calls

  Replace the "extension adapter and CLI adapter" test, which uses two
  stores over the same `Map` and so can't fail, with assertions on the real
  store types the two adapters receive.
