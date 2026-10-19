# New hosted dashboard tabs take 10-30 s to start once workflows are loaded

- **Found:** 2026-10-18 by Claude Code (media capture automation, phase 1)
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/server/CtrlYokeHostedServer.ts`
- **Severity:** medium

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

Not yet identified. The silent gaps cover forwarded browser logs too, so something
on the extension host holds the message route queue (or the event loop) for about 10 s at a time
while a new client starts. No 10 s timer was found on the READY path; the only 10 s timeouts
nearby (`WorkflowOrchestrator.ts` sibling stop request, `ExternalRunWatchSession.ts`) don't log
in these runs. Also note that loading the same file again creates a new workflow instance each
time (`Show workflows: 11 total` after 12 loads), so the registry grows with every load.

## Suggested Fix

Profile the extension host during a slow client start (CPU profile from the dev host's
`Developer: Show Running Extensions`, or timestamps around `handleClientReady`,
`replayWorkflowStateTo` and `sendInitialState`). Check whether the per-instance replay or summary
work grows with the registry, and whether reloading an already-open file should reuse its
instance. `media/lib/dashboard.ts` waits up to 120 s for the overlay until this is fixed.
