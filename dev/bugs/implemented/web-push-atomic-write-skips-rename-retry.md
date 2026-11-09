# Web Push Atomic Writes Skip Shared Rename Retry

- **Found:** 2026-11-08 by smell-hunt pass 5
- **Area:** `src/server/WebPushService.ts`
- **Resolution:** fixed in this commit

## Symptom

Writing the subscriptions registry or creating VAPID keys could fail outright when Windows temporarily refused the rename because antivirus or an indexer was sharing a file. Concurrent writes in the same process and millisecond could also choose the same temporary filename.

## Steps to Reproduce

1. Trigger a Web Push subscriptions write or first-use VAPID key creation.
2. Have another process briefly hold the destination during replacement, or cause two writes to select the same millisecond timestamp.
3. Observe the write fail instead of retrying a transient sharing violation, or collide on the temporary path.

## Root Cause

`WebPushService.atomicWriteJson` constructed a temp path from the process ID and current millisecond, then wrote and renamed it directly. This duplicated `writeFileAtomic` without its exclusive random temp creation or `renameWithTransientRetry` behavior.

## Suggested Fix

Delegate the temp-file write and rename to `writeFileAtomic` with `PRIVATE_FILE_MODE`, then chmod the destination to preserve the existing final permission tightening.
