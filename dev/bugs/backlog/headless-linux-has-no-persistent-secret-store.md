# Headless Linux (containers, servers) has no persistent secret store

- **Found:** 2026-10-15 by Claude Code (code reading while planning a Docker deployment of `ctrlyoke server`; not yet reproduced in a container)
- **Area:** `src/platform/OsCredentialStore.ts`, `src/platform/NodeHostServices.ts`, `src/cli/ServerCommand.ts`, `src/cli/SecretCommands.ts`, `src/license/LicenseService.ts`
- **Severity:** high

## Symptom

On Linux, the only persistent secret backend is `secret-tool` (libsecret over D-Bus,
`LinuxCredentialBackend`). A Docker container or a headless Ubuntu server usually has no D-Bus
session bus or keyring daemon, and often no `secret-tool` binary. `OsCredentialStore` then
raises `SecretStoreUnavailableError`, and every host handles that differently:

- **`ctrlyoke server`** wraps the store in `FallbackSecretStore(OsCredentialStore, MemorySecretStore)`
  (`NodeHostServices.ts:110`). It logs "OS credential store unavailable; server secrets will only
  last for this process", and from then on:
  - A Pro license activated from the hosted dashboard is held only in memory. After a restart the
    server is back to Free, and non-loopback clients are refused (`isClientAllowed`).
  - The license machine fingerprint is a random UUID kept in the same store
    (`LicenseService.getMachineFingerprint`, `LicenseService.ts:914`). Activating again after a
    restart registers a **new Keygen machine** each time, which uses up the license's machine
    limit.
  - Managed secrets (`!SECRET` grants, Settings → Secrets) disappear on restart.
- **`ctrlyoke server --https`** does its pre-start license check with a bare
  `OsCredentialStore` (`ServerCommand.ts:225`), not the fallback. `computeEntitlement` swallows
  the error and returns Free. The CLI's `LicenseService` has no `trialState`, so the trial reads
  as unavailable too. Result: with a non-loopback bind, LAN certificate generation is skipped
  with "Remote access is a Pro feature", even for a licensed user. The message is misleading:
  the problem is storage, not entitlement.
- **`ctrlyoke secret set`** builds a bare `OsCredentialStore` (`SecretCommands.ts:71`) and fails
  outright.

Net effect: an always-on `ctrlyoke server` in a container, which is the main reason to run the
server headless, can't keep Pro remote access across restarts.

## Steps to Reproduce

1. `docker run --rm -it -p 4747:4747 node:22-bookworm-slim bash`
2. `npm install -g ctrlyoke && mkdir /work && cd /work && git init`
3. `ctrlyoke server --bind 0.0.0.0 --verbose`
4. Observe the "OS credential store unavailable" warning in the log.
5. Activate a Pro license from the dashboard's License tab (reached via `docker exec` +
   loopback, or with `--network host`), then restart the container. The license is gone, and
   Keygen shows a second machine for the license.
6. Separately: `ctrlyoke server --https` with a non-loopback bind prints "Remote access is a Pro
   feature. HTTPS LAN certificate generation was skipped."

Not run yet. The steps above come from reading the code; confirm them before fixing.

## Root Cause

- `OsCredentialStore` has no file-backed Linux backend. `secret-tool` is the only option
  (`OsCredentialStore.ts:450`), and the unavailable patterns at `:41-45` cover the
  no-D-Bus and no-`$DISPLAY` cases.
- The Node host's fallback is `MemorySecretStore` (`NodeHostServices.ts:53`), which
  doesn't persist anything.
- `ServerCommand.ts:225` and `SecretCommands.ts:71` construct `OsCredentialStore` directly, so
  they don't share the server's fallback. Each host decides its own fallback, which is why they
  disagree.
- The machine fingerprint lives in the same store, so losing the store loses the
  Keygen identity too.

## Suggested Fix

1. **Single-source the Node secret store.** One factory (e.g. `createNodeSecretStore()` in
   `src/platform/`) used by `NodeHostServices`, `ServerCommand` and `SecretCommands`, so the
   pre-start license check and `ctrlyoke secret` see the same backend as the running server.
2. **Add a persistent file-backed fallback** for hosts with no OS keyring: an encrypted file
   under `ctrlyokeStateHome()`, mode `0600`. The key could come from a `CTRLYOKE_SECRET_KEY`
   env var or Docker secret file, or fall back to a key file next to it. A key file next to the
   data protects against little beyond casual reads, so say so in the warning. That is still
   strictly better than losing everything on restart, and it matches what other headless CLIs
   do (`gh`, `docker` credential fallbacks).
3. **Let a license come from outside the store:** e.g. `CTRLYOKE_LICENSE_KEY` /
   `CTRLYOKE_LICENSE_FILE` env vars, or a mounted license file. Then a container can be
   recreated without touching the store at all.
4. **Persist a stable machine fingerprint** independent of the secret store (e.g. a file in
   the state home, or derived from `/etc/machine-id` when it is stable), so a container rebuilt
   on the same volume reuses its Keygen machine.
5. **Fix the misleading message** in `ServerCommand.ts`: when the store is unavailable, say
   so instead of "Remote access is a Pro feature".
6. Tests: an `OsCredentialStore` with a stub runner reporting the D-Bus error should route to
   the file store; `ServerCommand` with an unavailable keyring and a license in the file store
   should generate the LAN certificate.

Related plan: `dev/backlog/DOCKER_SERVER_IMAGE_PLAN.md`; this bug is its first prerequisite.
