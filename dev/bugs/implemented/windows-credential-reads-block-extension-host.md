# Windows credential reads block the extension host for seconds at startup

- **Found:** 2026-10-23 by Claude (extension-host CPU profile, `npm run dev:host:profile:startup`)
- **Area:** `src/platform/OsCredentialStore.ts`
- **Resolution:** fixed in this commit. A persistent `WindowsCredentialHelper` replaces the process per operation; a startup re-profile shows one 313 ms launch instead of 16 launches totalling 5.9 s.

## Symptom

On Windows the extension host's event loop is blocked for about 6 seconds in
the first 30 seconds after activation. Every dashboard message waits behind it
(the session log shows `[EventLoopStall]` entries of 0.5–5.6 s and a `ready`
route with `runMs` over 10 s), so the panel is slow to appear and the first
workflow switch or prompt send feels stuck.

A 50 s startup capture of the dev host (shared state) attributed **5.9 s of
blocked event loop to 16 credential-store subprocess launches**. The median
launch was 329 ms and the longest 2,335 ms. All the time is `spawn`'s own
synchronous `CreateProcess` call under
`runCommand` (`OsCredentialStore.ts:897`) ← `WindowsCredentialItems.execute`
(`:790`) ← `read` (`:762`) ← `ChunkedCredentialBackend.get` (`:615`).

## Steps to Reproduce

1. On Windows, with at least a license key stored, run
   `npm run dev:host:profile:startup`.
2. Read the "Busy stretches" section of the summary, or run
   `node scripts/profile-dev-host.mjs --summarize <file>` on the capture.
3. The longest ctrlyoke-attributed stretches are under `OsCredentialStore`.

## Root Cause

`WindowsCredentialItems` starts a new `powershell.exe` for every single
credential item read. A logical `get` can cost two or more launches (the value,
then `#count` chunk metadata once the first chunk is full), and `keys()` reads
the chunked index the same way. Secrets are read one key at a time from
several places that run around startup: `migrateManagedSecrets` (awaited in
`activate`), `LicenseService` (license key, machine id, license id, source and
file, each a separate `get`) and `SecretRegistryService`. The profile cannot
say which of these issued each of the 16 launches, because they resume as
async continuations; most of the blocking falls between 6 s and 13 s after
activation starts, with a second cluster from 21 s to 29 s.

Node's `spawn` is asynchronous only after the process exists. On Windows,
creating it (more so for PowerShell under real-time antivirus scanning) runs
synchronously on the calling thread, so each launch freezes the extension
host for hundreds of milliseconds.

## Suggested Fix

- Read many keys in one PowerShell invocation. A `batch` operation already
  exists in `WindowsCredentialItems.execute`; route `getMany` and the startup
  readers (`LicenseService`'s grouped reads, `migrateManagedSecrets`) through it.
- Cache values read in this process and invalidate them on this process's own
  writes. Cross-process changes (the CLI, `ctrlyoke server`) still need the
  existing index integrity checks on a miss.
- Consider a long-lived helper process (one PowerShell reading requests from
  stdin) so the launch cost is paid once per session.
- Re-profile with `npm run dev:host:profile:startup`; the target is no
  credential-store stretch over 50 ms.
