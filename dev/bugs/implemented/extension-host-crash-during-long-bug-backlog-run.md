# Extension host crashes repeatedly during one long-running workflow

- **Found:** 2026-10-01 by claude-cli (user-reported)
- **Area:** extension test runner (`src/test/runTest.ts`) with no guard against a runaway test; hosted run-view delivery (secondary)
- **Resolution:** fixed by a58f19257 (event-loop stall watchdog for extension-test hosts). The
  looping test landed already bounded (`onPass: "continue"`) in 8bb91406b. Run-view payload work
  is closed in `dev/implemented/RUN_VIEW_PAYLOAD_PAGING_PLAN.md`. The 17:14 crash with no
  Event 2004 is still unexplained and has no repro.

## Symptom

During the `bug-backlog` run (`run-2026-09-30T13-41-01-546Z`, 38 steps, a 45.7 MB
`events.jsonl`), VS Code windows and extension hosts crashed repeatedly. Twice the whole machine
was affected: dwm, Task Manager and the NVIDIA container crashed too, and one crash needed a
reboot. The user was also watching the run from an iPhone over the hosted dashboard, which made
the phone look like the cause.

## Root cause: a test retried forever and exhausted the machine's commit memory

Windows logged a low-virtual-memory event (System log, Event 2004,
`Resource-Exhaustion-Detector`) for each machine-wide crash. Every one has the same signature:
system commit at its 127.9 GB limit, topped by a **freshly started `Code.exe` holding
~700,000 handles**:

| Event (local)    | Top process                      | Started (UTC) | Codex ran `npm test` (UTC) |
| ---------------- | -------------------------------- | ------------- | -------------------------- |
| 2026-09-30 19:07 | Code.exe 3.0 GB, 773,511 handles | 00:03:13      | 00:02:13                   |
| 2026-09-30 20:52 | Code.exe 3.1 GB, 720,041 handles | 01:48:46      | 01:47:51                   |
| 2026-09-30 22:21 | Code.exe 3.4 GB, 675,837 handles | 03:16:50      | 03:15:47                   |

Each of those processes was the VS Code **test instance** that the run's own Codex step (step 34,
working in the `bug-fix` worktree) launched through `npm test`. The leftover test user-data dirs
(`%TEMP%/ctrlyoke-extension-test-user-data-4-*`) show the cause: the first `EndConditionHandler`
test, which Codex added for unlimited-retry formatting
(`formats unlimited retry status denominators`), sets up unlimited retries with an evaluator that
ends in success. The handler then re-runs on every pass,
`End condition passed, re-running (pass retry N/∞)`, more than 100,000 times in about 90 s.
Nothing in the loop waits on a timer, so Mocha's timeout never fires. Every iteration logs, the
test window's renderer grows to millions of log lines and hundreds of thousands of handles, and
system commit runs out within about four minutes.

The 20:52 "renderer process gone (oom)" in the dev host window was another process hitting that
same exhaustion, not a fault in the dashboard.

The first crash, around 17:14 local (2026-09-30), has no Event 2004 and remains unexplained. Its
log shows a separate extension-host heap jump, 403 MB to 1,867 MB at 16:24–16:29Z.

## What the memory samplers ruled out

`MemoryWatchdog` (extension host) and `[PanelMemory]` (dashboard) ran through the 22:21 repro:

- The extension-host heap never stayed high. It always fell back to ~270 MB, and was 272 MB at the
  last sample before the machine failed.
- `hosted.queuedMB` stayed at 0 throughout. The phone always read what it was sent, so there was
  no backpressure buildup.

## Secondary problem: every run-view open is very expensive

These don't cause the crash, but they are real problems:

- Each `runViewLoaded` for this run is a **42.7 MB** hosted message (61 history entries, 8,062
  activity entries). Building it spikes the extension-host heap by 300–650 MB. The panel's heap
  spikes by about 420 MB per load.
- The iPhone PWA reconnected (close code 1006) and reloaded the run about 25 times in 12 minutes,
  sometimes every 5–10 s. iOS was probably killing the page while it handled the 43 MB payload.
  Overlapping loads pushed the extension-host heap to 1,736 MB (limit 4,192 MB).
- The heap snapshot `.ctrlyoke/logs/ctrlyoke-heap-2026-10-01T03-10-39-364Z.heapsnapshot` was
  taken during one of these spikes.

## Suggested Fix

1. Done: the looping test now uses `onPass: "continue"` (landed that way in 8bb91406b).
2. Done: `src/test/suite/eventLoopStallWatchdog.ts` kills an extension host whose event loop
   stays blocked for 30 s, and the shard's failure names the test that was running.
3. Checked, no change: in production every pass retry awaits a real harness run and a script
   process, and checks the stop flag. An unlimited `onPass: retry` loop is documented behavior
   that costs harness runs, but it never starves the event loop.
4. Moved to `dev/implemented/RUN_VIEW_PAYLOAD_PAGING_PLAN.md`, which records the phone
   reload loop and the history sent twice on resume (the latter fixed there). Open
   follow-ups are in `dev/backlog/RUN_VIEW_PAYLOAD_FOLLOWUPS.md`.

Logs: `.ctrlyoke/logs/ctrlyoke-1790824029160.log`; `%APPDATA%/Code/logs/20260930T194052/main.log`;
`%TEMP%/ctrlyoke-extension-test-user-data-4-WHTXG4/logs/20260930T221650/window1/renderer*.log`.
