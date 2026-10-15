# A failed hosted-server listen() drops the server without dispose(), leaking its hub client, heartbeat timer and language host

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/extension.ts`
- **Severity:** low

## Symptom

When "Enable Server" fails with "Failed to bind server", the half-built `CtrlYokeHostedServer` is never disposed. It stays registered as a client on the dashboard broadcast hub and keeps receiving every orchestrator broadcast. Its heartbeat `setInterval` keeps running, its `"hosted"` memory-context sampler stays registered, and its viewer service and `LanguageIntelligenceHost` are never disposed. Each failed retry leaks one more instance, and they all live until the extension host shuts down.

## Steps to Reproduce

1. With a remote-access (Pro) entitlement active, set `server.bindAddress` in `.ctrlyoke/settings.json` to an IP this machine does not own, such as a stale LAN address.
2. Run the "Enable Server" command. `httpServer.listen` emits `EADDRNOTAVAIL`, `listen()` rejects, and VS Code shows `ctrlyoke: Failed to bind server — ...`.
3. Inspect the `DashboardBroadcastHub` client set, or the `[MemoryWatchdog]` memory contexts. The failed server instance is still registered and its heartbeat interval is still scheduled.
4. Run "Enable Server" again. Each failure adds one more leaked instance.

## Root Cause

The constructor in `src/server/CtrlYokeHostedServer.ts` creates side effects before anything is bound. It calls `registerMemoryContext` at :612, `setupHeartbeat()` at :615 (which calls `setInterval` at :2787) and `hub.addClient(this)` at :616. `listen()` (:2997-3059) rejects at :3018 and :3036 without undoing any of these.

In `src/extension.ts`, the catch around `await hostedServer.listen()` (:1763, catch at :1772-1780) sets `hostedServer = undefined` and clears `unprotectServerToken`, but it never calls `hostedServer.dispose()`. The branch at :1764-1770 does dispose when `listen()` resolves to `undefined`. However, `listen()` only ever resolves with `this.publicUrl` or rejects. That makes the disposing branch effectively dead, so the leaking catch is the path that actually runs.

The `languageIntelligenceHost` is built at :1714 and attached with `dashboardApplication.setLanguageIntelligenceHost` at :1726. The only thing that releases it is the server's `dispose()` (`CtrlYokeHostedServer.ts:3283`), so it leaks as well.

## Suggested Fix

- In the catch block at `src/extension.ts:1772`, call `hostedServer?.dispose()` before setting `hostedServer = undefined`. A cleaner version is one local cleanup helper that both failure branches call. Then the dispose, the reference reset and the token unprotect all live in one place.
- Consider making `listen()` roll back its own constructor-time registrations when it rejects. Another option is to move `hub.addClient` and `setupHeartbeat` out of the constructor and into the on-listening path. Either change would also protect the CLI and MCP callers.
- Add a unit test where `listen()` rejects (for example, a stubbed `httpServer` that emits `EADDRNOTAVAIL`) and assert that the hub no longer holds the client.
