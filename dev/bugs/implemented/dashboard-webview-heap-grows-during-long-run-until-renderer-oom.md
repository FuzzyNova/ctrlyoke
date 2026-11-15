# Dashboard webview heap grows during a long run until the renderer OOMs and every window's panel goes gray

- **Found:** 2026-11-15 by user (overnight "bug hunt" run in `~/dev/haddy`), diagnosed from session logs and heap snapshots
- **Area:** `src/ui/webview-react/hooks/useOutputScrollTarget.ts`
- **Resolution:** fixed in this commit

## Symptom

On 2026-11-14, with two VS Code windows open (`ctrlyoke` and `~/dev/haddy`), the ctrlyoke panel in
**both** windows turned solid gray at the same moment and never recovered. The extension hosts kept
running (the hosted dashboard still worked from a phone). The VS Code DevTools consoles captured
afterwards show nothing useful, because the renderer that crashed is gone.

## Evidence

Session logs: `ctrlyoke/.ctrlyoke/logs/ctrlyoke-1794701348736.log` and
`haddy/.ctrlyoke/logs/ctrlyoke-1794701429933.log`.

- `[panel] [PanelMemory]` in both logs reports the **same** `heapUsed`/`heapTotal` at the same instants
  (e.g. `04:01:09Z heapUsed=3909.6MB heapTotal=3985MB` in both). VS Code appears to give an
  extension's webviews the same origin in every window (the Claude Code webview has the same
  `origin=` in both DevTools logs), so Chromium put both ctrlyoke dashboards in one renderer process
  with one V8 heap and one `heapLimit=4192MB`. That is why both windows died together.
- The shared heap rose from ~40 MB (00:09Z) to 3.91 GB (04:01Z). The `ctrlyoke` panel was idle; the
  `haddy` panel was following the running `bug hunt` workflow (`liveActivity` 0 → 4730).
- From ~01:53Z the 15 s panel sampler fired only once a minute, on the minute: Chromium's intensive
  throttling of hidden pages. Both panels were not painting for the rest of the night.
- Last native `[panel]` lines: 04:01Z (ctrlyoke) and 04:07Z (haddy). `[MemoryWatchdog]` (extension
  host) stayed small, so this was a webview OOM.

Reproduced 2026-11-15 in the shared dev host (`CTRLYOKE_DEV_HOST_RENDERER_PORT`), resuming the same
run with ~6,500 activity entries loaded, watching post-GC retained heap over CDP:

- Idle with the run loaded: flat at ~126 MB for 20 minutes.
- Run streaming, window visible: slow growth, frames flushing.
- Run streaming while a full-screen app covered the window (19:43Z–20:23Z, panel sampler again at
  one per minute): retained heap 140 MB → 2.3 GB.
- The window came back on screen at 20:23:39Z: retained heap fell by 2 GB in one step to ~290 MB.
- Heap snapshots: the stale copies were `rows` (~6,000 rows) and `allMessages` arrays (5 → 15 distinct
  `rows` arrays alive). Their retainer path ran through a closure whose scope holds `phase`, then to
  the `useOutputScrollTarget` render scope, then to a `V8FrameRequestCallback` in Blink's
  `ScriptedAnimationController`: a queued `requestAnimationFrame` callback. Every pending frame
  callback in the snapshot came from that one site. After the window was visible again none were
  pending.

## Root Cause

`applyScrollTarget` in `hooks/useOutputScrollTarget.ts` queued
`requestAnimationFrame(() => { isProgrammaticScrollRef.current = false; })` on every programmatic
`scrollTop` write, and the workflow-target restore effect queued another frame per run. While the
webview is not painting, Chromium never runs animation frames, so each streamed update added one more
pending callback. V8 gives all closures created in one call a single shared context, so each tiny
callback kept its whole render scope alive, the row model and message list included. The cost per
update grew with the run, and the queue only drained when the panel painted again. Overnight it
never did.

## Fix

Each of those call sites keeps at most one pending frame (the id is held in a ref and the callback
skips scheduling while one is pending; both are cancelled on unmount). All callbacks queued before a
frame ran in that same frame anyway, so behavior is unchanged while visible, and memory stays bounded
while hidden. `test/hooks/useOutputScrollTarget.test.ts` covers it by pausing frames and issuing 50
writes. The rule is recorded in `webview-react-hooks.instructions.md`.
