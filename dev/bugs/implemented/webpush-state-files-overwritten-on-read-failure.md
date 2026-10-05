# Push notification VAPID keys and subscriptions are overwritten when a read fails

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code
- **Area:** `src/server/WebPushService.ts` (`getOrCreateVapidKeys` ~314-332, `readSubscriptions` ~334-349, `upsertSubscription`, `removeSubscription`)
- **Resolution:** fixed in this commit

## Symptom

Two read-modify-write paths treat _any_ failure to read their file as "file does not exist":

1. **VAPID keys.** `getOrCreateVapidKeys` catches every error from `readFile`,
   `JSON.parse`, and even the post-read `fsp.chmod`, then generates a new key pair and
   overwrites `vapid-keys.json`. Phone push subscriptions are bound to the
   `applicationServerKey` they were created with. After a regeneration the push service
   rejects every send (typically 401/403, not 404/410), so those subscriptions are
   never pruned. They stay registered, fail forever, and push-to-phone silently
   stops until the user re-subscribes on every device. Triggers include a transient
   `EBUSY`/`EPERM` read (antivirus, or OneDrive/Dropbox sync, which the docs say is a
   supported location for the user-scoped state home), a BOM or hand-edit in the file,
   or a filesystem where `chmod` fails.
2. **Subscriptions.** `readSubscriptions` returns `{ subscriptions: [] }` on any
   read, parse, or `chmod` error. `upsertSubscription` then writes a registry that
   contains only the new device, and every other registered device is deleted.
   `readSubscriptions` also drops entries that fail `isValidStoredSubscription`, so
   the next upsert, remove, or send deletes them for good.

This is the same class as the fixed
`dev/bugs/implemented/mcp-registry-write-wipes-unparseable-or-invalid-entries.md` and
`settings-file-unparseable-json-overwritten-on-write.md`, in a store those fixes didn't
cover.

## Steps to Reproduce

1. Register two devices for push-to-phone (`push-subscriptions.json` holds two entries).
2. Make the file unreadable for one read (lock it, or add a trailing comma/BOM).
3. Register a third device: the file now holds only the third device.
4. Separately, corrupt or lock `vapid-keys.json` once and trigger any push. New keys
   are written, and the existing devices never receive a notification again.

## Root Cause

Bare `catch {}` blocks that don't separate `ENOENT` from other failures, together with
`chmod` inside the same `try` as the read.

## Suggested Fix

- In both readers, only treat `ENOENT` as "missing". Strip a leading BOM before
  `JSON.parse`. Move the permission-tightening `chmod` out of the read's `try`, and
  make it best-effort (log on failure) so it can never trigger regeneration or a wipe.
- `getOrCreateVapidKeys`: generate keys only when the file is missing. For
  unparseable or invalid content, or a read error, throw a clear error naming the
  file instead of overwriting it.
- Subscriptions: for mutation, throw on unparseable or non-array content instead of
  starting from `[]`. Preserve entries that fail validation verbatim when writing
  back; only skip them when sending or listing.
- Extend `src/test/unit/WebPushService.test.ts`: a corrupt keys file is not
  overwritten; a corrupt or BOM subscriptions file is not wiped by upsert; an
  invalid entry survives upsert/remove; a missing keys file still generates keys.
