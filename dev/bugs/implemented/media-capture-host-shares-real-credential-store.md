# Media capture host shares the real OS credential store

- **Found:** 2026-10-20 by Claude Code, while scripting a Settings → License still
- **Area:** `src/platform/OsCredentialStore.ts`, `scripts/dev-host.mjs` (`media` mode)
- **Resolution:** fixed in this commit

## Symptom

The `media` dev host replaces the user home and VS Code profile, but the dashboard's
License tab still shows the capturing machine's own license (Pro, Online activation) and
loads its real activated-machines list from Keygen. Any capture that shows the License
tab, a tier badge or a managed secret shows the capturer's real state, and a capture
that activates or deactivates a license would change the real one.

## Steps to Reproduce

1. On a machine with Pro activated, `npm run media -- host properties-tabs`.
2. Open the hosted dashboard, Settings → License.
3. The status reads Pro / Online activation, and **Activated machines** loads the real list.

## Root Cause

`OsCredentialStore` writes under the fixed service `ctrlyoke` (`CREDENTIAL_SERVICE`,
`CREDENTIAL_INDEX_KEY`, `WINDOWS_TARGET_PREFIX` in `src/platform/OsCredentialStore.ts`).
The credential store belongs to the OS user, not to `USERPROFILE`/`HOME`, so the media
mode's fake home doesn't isolate it (see the comment on `defaultIndexLockTarget`). The
extension builds that store directly (`src/extension.ts`, `new OsCredentialStore()`).

## Suggested Fix

Give the media mode its own credential namespace in dev builds only: an `IS_DEV_MODE`-gated
environment variable (set by `scripts/dev-host.mjs` for `media`) that changes the service
name, index key and Windows target prefix together, or swaps the extension to a
`FileSecretStore` in the fake home. Production builds must keep the fixed names. Then a
License-tab still (the activation steps in `docs/pro/index.md#activate-online`) can show
the Free state with a pasted key.
