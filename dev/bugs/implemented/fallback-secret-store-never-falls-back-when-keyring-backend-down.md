# FallbackSecretStore never falls back when a keyring tool is installed but its backend is unreachable

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with a tsx probe using an injected `runCommand`
- **Area:** `src/platform/FallbackSecretStore.ts` (`probe` ~46-57), `src/platform/OsCredentialStore.ts` (`get`/`keys` error mapping)
- **Resolution:** fixed in this commit

## Symptom

On a Linux host where `secret-tool` is installed but no Secret Service/D-Bus
session is running (Remote-WSL, Remote-SSH to a headless box, containers with
libsecret-tools), storing a secret fails with
`secret-tool credential-store command failed: secret-tool: Cannot autolaunch D-Bus…`.
It never falls back to VS Code secret storage, and `onFallback` is never called.
`LicenseService` (~481/556) therefore can't persist a license on these hosts,
which are exactly the headless/remote hosts the class comment says the fallback
exists for.

## Steps to Reproduce

1. Wrap `new OsCredentialStore({platform:"linux", runCommand: <exit 1 with D-Bus stderr>})`
   in `FallbackSecretStore`.
2. `get()` returns `undefined`. `store()` throws a plain `Error`, the fallback store
   stays empty, and no fallback notification is sent.

## Root Cause

`probe()` calls `primary.keys()`, which only reads. `OsCredentialStore` treats
any non-zero `secret-tool lookup` exit as "not found", so the probe succeeds and
the OS store is memoized. The later write failure is a plain `Error`, not
`SecretStoreUnavailableError`, so it isn't treated as "backend unavailable".

## Suggested Fix (behaviour change, not queued)

Either probe with a real write/delete round-trip, or have `OsCredentialStore`
classify backend-unreachable failures (D-Bus autolaunch errors, a locked keychain
over SSH) as `SecretStoreUnavailableError` so `FallbackSecretStore` switches
stores, including on the first failing write. Both change when and how secrets
move between stores, so this needs a design decision.

## Decision

Decided 2026-10-03 by Nathan: classify errors, with no write probe. `OsCredentialStore` maps backend-unreachable failures (D-Bus autolaunch failure, no Secret Service, a locked keychain over SSH) to `SecretStoreUnavailableError` on reads, `keys()` and writes. A real "not found" still returns `undefined`. `FallbackSecretStore` switches to the fallback store on that error, including on the first failing write (which is then retried against the fallback), and calls `onFallback`. The keyring is never written just to probe it.
