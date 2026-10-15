# Windows CredMan read errors are treated as 'missing', silently truncating chunked secrets and clobbering the key index

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/platform/OsCredentialStore.ts`
- **Resolution:** fixed in this commit

## Symptom

On Windows, a Credential Manager read that fails (as opposed to one that finds nothing) is reported as "credential absent". The effect depends on which read fails:

- **`<key>#count` read:** `get()` returns only the first 1280 characters of a chunked secret, such as a license file or PEM key. It raises no error and runs no integrity check.
- **Index read during `store()`/`delete()`:** the managed-secret index is rewritten with only the key being stored. Every other managed secret is permanently dropped from `keys()`, the secret registry listing and migration.
- **`store()`/`delete()`:** both can also leave orphaned continuation chunks in the vault.

## Steps to Reproduce

1. Construct `OsCredentialStore({ platform: "win32", runCommand })` with a fake runner backed by an in-memory map. The runner returns exit 0 with base64 stdout for present targets and exit 44 for absent ones.
2. Call `store("ctrlyoke.pro.license-key", "x")` and `store("ctrlyoke.pro.license-file", "a".repeat(1280 * 2))`. The second value is chunked, and the index now holds both keys.
3. Make the runner return `{ exitCode: 45, stdout: "", stderr: "CredRead failed with Win32 error 5." }` only for the target `ctrlyoke.ctrlyoke.pro.license-file#count`. An exit 1 with a PowerShell `Add-Type` error reproduces it too.
4. Call `get("ctrlyoke.pro.license-file")`. It resolves to a 1280-character string instead of rejecting.
5. Make the runner fail the same way (exit 45) for the index target `ctrlyoke.ctrlyoke.secret.index`, then call `store("other", "y")`.
6. Restore normal runner behavior and call `keys()`. It returns only `["other"]`: both license keys have been dropped from the index for good.

## Root Cause

`WindowsCredentialBackend.readCredential` (`src/platform/OsCredentialStore.ts:537-543`) returns `result.exitCode === 0 ? decoded : undefined`. Apart from a stderr match on Win32 error 1312, which `throwIfBackendUnavailable` escalates, every non-zero exit therefore means "not found". That includes:

- exit 45: `CredRead` failed with some other Win32 error (script lines 93-97)
- exit 1: a terminating PowerShell error

Only exit 44 (`ERROR_NOT_FOUND`, script line 95) should mean "not found". The false "absent" then spreads downstream:

- `readChunkMetadata` (lines 521-535) turns `undefined` into `{ count: 1 }` with no integrity tag. `get()` (lines 433-437) then returns the truncated first chunk as the whole value. The comment at lines 472-476 calls this exact outcome "far worse than a failed store".
- `keys()` (lines 216-232) turns a missing index into `[]`. `addKeyToIndex`/`removeKeyFromIndex` (lines 247-269) then rewrite the index from that empty set.
- `store()` (line 470) and `delete()` (line 507) read the chunk count through `readChunkCount`, get 1, and leave continuation chunks orphaned.

The macOS and Linux backends throw on unrecognized failures (lines 321-325 and 375-379). The Windows backend never does.

## Suggested Fix

- In `WindowsCredentialBackend.readCredential`, return `undefined` only for exit 44, or use `isMissingCredential(result)`. For any other non-zero exit, call `throwCommandFailure("CredMan", result)` after `throwIfBackendUnavailable`, as the macOS and Linux backends do. `get()`, `keys()`, the index mutations and `readChunkCount` will then fail loudly instead of acting on a false "absent".
- Consider having `keys()` rethrow when the index exists but cannot be parsed, rather than returning `[]`. This keeps a corrupt index from being overwritten by the next `store()`.
- Add unit tests that use an exit-45 or exit-1 runner on the `#count` target and on the index target. Assert that `get()`, `store()` and `keys()` reject and that the index is left unchanged.
