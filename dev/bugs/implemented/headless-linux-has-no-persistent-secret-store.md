# Headless Linux (containers, servers) has no persistent secret store

- **Found:** 2026-10-15 by Claude Code (code reading while planning a Docker deployment of `ctrlyoke server`; not yet reproduced in a container)
- **Area:** `src/platform/OsCredentialStore.ts`, `src/platform/NodeHostServices.ts`, `src/cli/ServerCommand.ts`, `src/cli/SecretCommands.ts`, `src/license/LicenseService.ts`
- **Resolution:** fixed in this commit

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
  with "Remote access is a Pro feature", even for a licensed user. The message is true (no
  license is present), but it doesn't say why: a license activated in an earlier server run was
  only ever held in memory, because there was nowhere persistent to store it.
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

**Decision (2026-10-16):** approved as written below. It replaces the earlier list, which
proposed an encrypted file with the key stored beside it.

### Threat model

On a headless host, the realistic attacker is another user on the same machine, or someone who
gets a copy of the volume. File mode `0600` in a `0700` directory stops the first. Encryption
whose key sits in the same home directory stops neither, because whoever can read the data can
read the key. An encryption key passed as an env var doesn't help either: ctrlyoke doesn't scrub
its environment before spawning harness CLIs and scripts, so every agent inherits it.

The harnesses ctrlyoke drives already store their logins this way on Linux, in the same home
volume (`~/.claude/.credentials.json`, `~/.codex/auth.json`). So does the wider CLI ecosystem when
no keyring is available:

- `gh` falls back to plaintext `hosts.yml` with a warning.
- `docker` keeps auths in `config.json` unless a credential helper is set.
- git's `credential-store` keeps `~/.git-credentials`.
- the AWS CLI keeps `~/.aws/credentials`.
- Electron/VS Code's `basic_text` safeStorage backend uses a hard-coded key.

Agents running in the container can read the store whatever format it uses. The container is the
sandbox, as `DOCKER_SERVER_IMAGE_PLAN.md` already says.

### Fix

1. **One Node secret-store factory** in `src/platform/` (e.g. `createNodeSecretStore()`),
   returning `FallbackSecretStore(OsCredentialStore, FileSecretStore)`. Use it in
   `NodeHostServices`, `ServerCommand`'s pre-start license check, `SecretCommands`, and as
   `CliAdapter`'s default. Then the server, `ctrlyoke secret`, and the license check always see
   the same backend. This part needs no decision and can ship first.
2. **`FileSecretStore`: plaintext JSON, not encrypted.**
   - It lives at `ctrlyokeStateHome()/secrets.json`, so `CTRLYOKE_HOME` and the Docker volume
     already cover it.
   - The file is mode `0600` in a `0700` directory. Re-apply the mode on every write, and warn if
     the file is group- or world-readable on read, as ssh does.
   - Writes are atomic (temp file + rename) under `withFileLock`, because the server and
     `ctrlyoke secret` can write concurrently.
   - It implements `keys()` directly, so it needs no separate index.
   - Replace the "secrets will only last for this process" warning with one that names the file
     and says it is unencrypted, as `gh` does.
   - Keep `MemorySecretStore` only for tests.
   - Encryption can come later as an opt-in key file (`CTRLYOKE_SECRET_KEY_FILE`) for volumes
     that are backed up apart from the key. Don't build it now.
3. **License from a mounted file: `CTRLYOKE_LICENSE_KEY_FILE`.**
   - This follows the official Postgres/MySQL image convention for Docker secrets
     (`/run/secrets/…`). A file is preferred over a bare env var because harness subprocesses
     would inherit the env var.
   - Also accept `CTRLYOKE_LICENSE_KEY` for convenience, but delete it from `process.env` after
     reading so children don't inherit it.
   - On start, if the provided key differs from the stored one, activate it through the normal
     path. Store the result in the secret store as usual.
   - This is needed, not just convenient. On Docker's bridge network every browser is remote, and
     remote access needs Pro, so a container can't be activated from its own dashboard without
     `docker exec` or host networking. There is also no `ctrlyoke license` CLI command today.
   - A `ctrlyoke license activate|status|deactivate` command would be the natural companion, and
     could be done as a separate change.
4. **Machine fingerprint: no separate mechanism.**
   - It stays a persisted random value. Once the store is a file on the volume, the fingerprint
     survives container recreation and a rebuild reuses its Keygen machine.
   - Don't derive it from `/etc/machine-id`. In containers it is usually absent, or baked into
     the image and shared by every container started from it, which would merge distinct
     machines.
   - Losing the volume costs one machine activation. That's acceptable; deactivate the old
     machine from the Keygen portal.
5. **Make the message say why** in `ServerCommand.ts`. Item 1 alone doesn't change it: with
   only the in-memory fallback the store is empty at startup, so the check still reads Free.
   Items 1 and 2 together let the check find a license saved by an earlier run. Separately, when
   no persistent store is available, add the reason to the message (e.g. "no credential store is
   available, so a license activated earlier was not saved") instead of only "Pro feature".
6. **Out of scope here:** the CLI server's missing `trialState` (the Docker plan owns it). A trial
   kept on a volume can be reset by deleting the volume, so it needs its own decision.
7. **Tests:**
   - `OsCredentialStore` with a stub runner returning the D-Bus error routes to
     `FileSecretStore`.
   - `FileSecretStore` round-trips values, keeps mode `0600`, and survives concurrent writers.
   - `ServerCommand` with no keyring and a stored license generates the LAN certificate.
   - `CTRLYOKE_LICENSE_KEY_FILE` activates once and is a no-op on the next start.
   - `CTRLYOKE_LICENSE_KEY` is removed from `process.env`.
8. **Docs:** the CLI/server page gets the storage location and its unencrypted status, and the
   env vars.

The extension is unaffected: on a host without a keyring it already falls back to VS Code's own
secret storage (`extension.ts`). On a headless Linux box running both the extension and the
server, their stores will differ. That already happens today and is outside this bug.

Related plan: `dev/backlog/DOCKER_SERVER_IMAGE_PLAN.md`; this bug is its first prerequisite.
