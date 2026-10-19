# Secret registry cache never sees secrets set or deleted by another process

- **Found:** 2026-10-19 by Claude Code (bug-drain review of ~2a9bee28a)
- **Area:** `src/ui/SecretRegistryService.ts`
- **Severity:** low

## Symptom

The dashboard's secret registry (Settings → Secrets, and each workflow's secret-grant state)
keeps showing a secret as "not set" after it has been set, or as "set" after it has been deleted,
when the change came from outside this extension host. Examples:

- `ctrlyoke secret set NAME` / `ctrlyoke secret delete NAME` from the CLI while VS Code is open.
- A second VS Code window, or a standalone `ctrlyoke server`, changing a **user-scope** secret.
  User-scope secrets are shared by every workspace on the machine, so this is the common case.

The stale state lasts until the extension host restarts. Before ~2a9bee28a every
`REQUEST_SECRET_REGISTRY` read the credential store again, so this did not happen.

## Steps to Reproduce

1. Open the dashboard's secret registry, so the user scope gets cached.
2. In a terminal, run `ctrlyoke secret set SOME_NAME` at user scope.
3. Reopen or refresh the registry in the dashboard. `SOME_NAME` is still missing or shown as unset.

## Root Cause

~2a9bee28a added `SecretRegistryService.registryCache`
(#selection:src/ui/SecretRegistryService.ts:249-252), a per-scope snapshot of managed names and
each name's set/metadata state. `getManagedNames` (#selection:src/ui/SecretRegistryService.ts:383-399)
and `ensureCredentialSnapshot` serve from it indefinitely. The only invalidation is in this
service's own `set`/`delete` (`:344`, `:358`), so a write made by another process is never noticed.

## Suggested Fix

Keep the batching (one PowerShell call per refresh), but bound how long a snapshot can stay stale.
Pick whichever of these is simplest:

- Give each scope's snapshot a short TTL (for example 30 s), so a later `REQUEST_SECRET_REGISTRY`
  re-reads `keys()` plus one batched `getMany`. Every request inside a dashboard load still shares
  one snapshot.
- Or let the webview mark a request as user-initiated (opening the Secrets page, or a refresh
  button) and drop the cache for that request only. Background re-requests keep using the cache.

Don't reintroduce per-name `get` calls or running the request inside the shared `routeQueue`.
Add a `SecretRegistryService` unit test where the backing `SecretStore` changes behind the
service's back and a later `list()` reflects it, after the TTL or the forced refresh.
