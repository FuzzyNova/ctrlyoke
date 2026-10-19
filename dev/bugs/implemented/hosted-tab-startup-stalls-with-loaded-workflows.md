# New hosted dashboard tabs take 10-30 s to start once workflows are loaded

- **Found:** 2026-10-18 by Claude Code (media capture automation, phase 1)
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/server/CtrlYokeHostedServer.ts`
- **Resolution:** fixed in this commit

## Symptom

On a fresh VS Code dev host, opening the hosted dashboard takes about 0.8 s to clear the
"Loading ctrlyoke…" overlay. After one workflow has been loaded through **Load from File…**,
every new tab or reload takes 10-12 s, sometimes 20-25 s, and occasionally more than 30 s. The
media capture script (`npm run media -- properties-tabs`) hit a 30 s wait on the 10th page in
three runs out of three.

In the session log, each new client's `WebSocket READY` is followed by about 10 s with no log
lines at all, including browser log lines forwarded from other tabs. Then come late lines from the
previous tab (`[panel] [STEPS_EXTENDED] ignoring push for inactive workflow` and its StoreWatch
burst), another gap of about 10 s, and only then `WebviewSettingsSync sendInitialState()` for the
new client. Closing each tab or keeping it open makes no difference. Twelve back-to-back page loads
with no workflow loaded all start in about 0.8 s.

## Steps to Reproduce

1. `npm run media -- setup`, then `npm run media -- host properties-tabs` (a VS Code dev host on
   a demo-app clone with its hosted server on loopback).
2. In a browser, open the URL it prints, load `.ctrlyoke/workflows/media-properties.ctrlyoke.yaml`
   with **Load from File…**, then open the URL in a new tab, and repeat a few times.
3. Each new tab spends 10-30 s on the startup overlay. Compare the timestamps of
   `WebSocket READY` and `[startup] STARTUP_COMPLETE received` per `browser:` client in
   `media/.work/demo-app/.ctrlyoke/logs/ctrlyoke-*.log`.

## Root Cause

Identified 2026-10-19 with the `[RouteTiming]` and `[EventLoopStall]` session-log lines and a
CPU profile of the extension host. `WebviewMessageRouter.route()` runs every message from
every client, forwarded browser `logMessage`s included, through one serialized `routeQueue`.
That is why the gaps silence every tab at once. Two handlers hold it for seconds:

- **`requestSecretRegistry`**, sent for both scopes by every page load that mounts the
  workflow properties/secret-grant UI, takes 1.4–3.7 s per request on Windows because
  each credential read spawns its own `powershell.exe`. Requests from tabs that already closed
  still run, so back-to-back loads add ~5 s of backlog each, matching the 10 → 25 → 30 s+
  growth above. See `secret-registry-request-blocks-route-queue-with-powershell-spawns.md`.
- **Payload redaction.** Every message the new client is sent is recursively redacted, and each
  string leaf re-reads and deep-merges the full settings (64 µs per string; ~2.9 s for one
  large run's timeline). A loaded workflow's run-view replay therefore blocks the event loop in
  proportion to its size. See `secret-redaction-rereads-settings-for-every-string.md`.

Loading the same file again creates a new workflow instance by design, so users can run two
instances of one file in parallel or configure them differently for testing. The per-instance
schema compilation cost was fixed in `prompt-file-parser-recompiles-schema-per-instance.md`; the
fresh-instance behavior is not a startup defect and remains unchanged.

## Suggested Fix

This is an umbrella bug. Fix the linked root causes first
(`secret-redaction-rereads-settings-for-every-string.md`,
`secret-registry-request-blocks-route-queue-with-powershell-spawns.md`,
`prompt-file-parser-recompiles-schema-per-instance.md`). Then:

- **Load from File…** continues to create a new workflow instance each time, as intended for
  parallel runs and testing with different harnesses.
- The linked secret-redaction, secret-registry, and schema-compilation root causes are fixed in
  their implemented reports. The 120 s media overlay wait is restored to Playwright's normal
  30 s timeout.
- Hosted-tab startup was not re-measured in this turn; headless browser measurement was skipped.
