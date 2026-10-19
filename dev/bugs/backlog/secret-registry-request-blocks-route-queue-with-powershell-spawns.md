# Secret registry requests block every client for seconds by spawning PowerShell per credential

- **Found:** 2026-10-19 by Claude Code (performance investigation, `[RouteTiming]` instrumentation)
- **Area:** `src/ui/SecretRegistryService.ts`, `src/platform/OsCredentialStore.ts`, `src/ui/WebviewMessageRouter.ts`
- **Severity:** high

## Symptom

Every dashboard load (panel or hosted tab) sends `requestSecretRegistry` for both scopes
(`useSecretGrantOptions`, mounted by `WorkflowPropertiesPanel` and `SecretGrantsEditor`, and
`workflowValueDataSource.ensureSecretsRequested`). On Windows each request runs for 1.4–3.7 s
inside the router's shared queue, so every later message from every client waits behind it.
The dev-host session log (shared state, 2026-10-19) shows, per hosted page load:

```
[RouteTiming] slow route type=requestSecretRegistry client=browser:s2605k9gp waitMs=7154 runMs=3744
[RouteTiming] slow route type=requestSecretRegistry client=browser:s2605k9gp waitMs=10898 runMs=1786
...
[RouteTiming] slow route type=getRecentWorkflows client=browser:s2605k9gp waitMs=4750 runMs=0
```

`getRecentWorkflows` itself takes 0 ms, but opening the **Show workflows** dropdown took
16.5 s to list entries in Playwright, because the request queued behind registry work left by
earlier page loads. Requests for tabs that have already closed still run, so loading tabs
back-to-back adds about 5 s of backlog per load. That is the 10 s → 20 s → 30 s+ growth recorded
in `hosted-tab-startup-stalls-with-loaded-workflows.md`.

## Steps to Reproduce

1. On Windows, run `npm run dev:host:start:shared`.
2. Open the hosted URL (`.ctrlyoke/dev/server-url.txt`) in a browser tab, reload it 3–4 times
   quickly, then click **Show workflows**.
3. Grep the newest `.ctrlyoke/logs/ctrlyoke-*.log` for `[RouteTiming]`: each load contributes
   two `requestSecretRegistry` routes taking seconds, and later messages report multi-second
   `waitMs`.

## Root Cause

`SecretRegistryService.list()` (`src/ui/SecretRegistryService.ts:277`) calls
`secretStore.keys()` (via `getManagedNames`), then for every candidate name awaits
`secretStore.get(key)` and `readMetadata()` (another `get`) **sequentially** (lines 301–304).
On Windows each `get` is a `WindowsCredentialBackend.readCredential`
(`src/platform/OsCredentialStore.ts:625`), which spawns a fresh `powershell.exe` with an
encoded script that `Add-Type`-compiles a C# P/Invoke wrapper before calling `CredRead`
(`execute`, line 653). Process creation alone blocks the extension host: `spawn` was the top
self-time frame (5.3 s of a 45 s startup profile), with ~4 s inclusive under `readCredential`.
Values that fill a chunk cost one more spawn for `#count`. Nothing caches results across
requests, and the handler (`WebviewMessageRouter.ts:1534`) runs inside the shared
`routeQueue`, so the whole duration stalls every client.

## Suggested Fix

- Keep a single long-lived credential helper process per session (PowerShell, or a tiny
  native helper) that compiles the `CredRead` type once and answers line-delimited requests,
  instead of one process plus a C# compile per read.
- Answer the registry from an in-memory snapshot. `list()` only needs to know whether each
  name is set plus its metadata, so cache `keys()` and metadata and invalidate them on
  `set`/`delete` (which already go through this service). Batch the per-name reads so one
  helper call returns all of them.
- Run the registry request outside the shared `routeQueue` (reply via the request's own
  `ctx.emit`), and drop queued requests from clients that have since disconnected.
