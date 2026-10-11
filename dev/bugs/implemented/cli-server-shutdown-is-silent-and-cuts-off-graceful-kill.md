# `ctrlyoke server` never says how to stop it, and Ctrl+C shutdown is silent and can cut off child cleanup

- **Found:** 2026-10-10 by Nathan (manual observation), confirmed in code by claude-cli
- **Area:** `src/cli/ServerCommand.ts` (`formatServerBanner`, `installServerShutdown`), `src/platform/NodeHostServices.ts` (`createNodeHostedServer().dispose`)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke server` prints the dashboard URL, LAN URLs and a QR code, then
nothing more. It never says how to stop the server. Pressing Ctrl+C exits with
no output, so the user cannot tell a graceful shutdown from a hard kill. A
second Ctrl+C exits at once, also with no output.

## Steps to Reproduce

1. `ctrlyoke server` → the banner has no "press Ctrl+C to stop" line.
2. Start a workflow from the dashboard so a harness process is running.
3. Press Ctrl+C. The process exits with code 0 and prints nothing. There is no
   way to see whether running workflows and terminals were shut down cleanly.

## Root Cause

Ctrl+C is already handled. `installServerShutdown` (`ServerCommand.ts`
~119-137) traps `SIGINT`/`SIGTERM` and calls `runtime.dispose()`.
`NodeHostServices.ts` ~398-410 runs
`ptyManager.gracefulShutdownAllAiCliSessions()` alongside
`orchestrator.shutdown()`, then `orchestrator.dispose()`. That dispose tears
down the integrations, whose `CliProcessManager.dispose()` →
`disposeProcess()` → `killGracefully()`. The intended path exists. The
problems are in how it is presented and how it ends:

1. **No stop hint.** `formatServerBanner` (~65-82) prints the URL, the LAN
   URLs, the QR code and the HTTPS cert note, but no stop instruction.
2. **No shutdown feedback.** `installServerShutdown` prints nothing on the
   first or second signal, so the user never sees the graceful path happen.
3. **`process.exit` runs straight after dispose and cuts off async kills.**
   `.finally(() => exit(0))` runs as soon as `dispose()` resolves.
   `killGracefully` (`CliProcessManager.ts` ~386-420) only *starts* a SIGTERM
   and arms a 3 s timer (`KILL_ESCALATION_DELAY_MS`) to escalate to SIGKILL.
   Exiting at once means the escalation timer never fires, so a child that
   ignores SIGTERM is orphaned. On POSIX, `tree-kill` first runs `ps` to find
   the child processes, asynchronously, before it signals them. An immediate
   exit can therefore stop the SIGTERM from reaching the tree at all
   (plausible, not yet reproduced).
4. **Shutdown has no overall time limit.** Each `WorkflowInstance.shutdown()`
   has a 1.5 s settle window (`SHUTDOWN_SETTLE_TIMEOUT_MS`), but
   `gracefulShutdownAllAiCliSessions()` and `flushDurableState()` have no
   bound at this level. If one hangs, the server hangs with no message until
   a second Ctrl+C force-exits it.
5. **Other termination signals are not handled.** `SIGHUP` (terminal or
   console window closed; on Windows Node gets roughly 10 s before the OS
   kills it) and `SIGBREAK` (Ctrl+Break on Windows) skip the graceful path.
   `ServerSignalSource` only allows `"SIGINT" | "SIGTERM"`.

(Windows note, plausible and not verified: Ctrl+C in a console sends
`CTRL_C_EVENT` to every process attached to it. Non-PTY harness children
spawned by `CliProcessManager` without `detached` may receive Ctrl+C directly
and die before ctrlyoke records the stop. Check this while fixing; it may be
harmless because `recoverInterruptedRun` repairs state on the next start.)

## Suggested Fix

Keep Ctrl+C as the stop key. Trapping `SIGINT` for a graceful stop is the
standard behaviour developers expect from long-running dev servers (Flask,
`http-server`, `docker compose up`, Vite, Next.js). Do not invent another
shortcut. Combine the `docker compose` two-stage pattern ("graceful, press
again to force") with Claude Code's confirm-while-busy gate. Stopping a running
workflow throws away the in-flight AI turn, which costs time and money, so a
stray Ctrl+C should not do it without warning:

1. **Banner:** add a final line to `formatServerBanner`, e.g.
   `Press Ctrl+C to stop the server.` It should be the last thing printed
   after the QR code, so it is visible without scrolling.
2. **Ctrl+C with no workflow running → graceful shutdown at once.** No
   confirmation; go straight to step 4.
3. **Ctrl+C with workflows running → warn, stop nothing.** Count only runs
   this server process is executing (instances in `RUNNING` or `PAUSING`).
   Paused runs survive shutdown (`WorkflowInstance.shutdown` leaves them
   alone), and external CLI runs the dashboard merely watches are not
   stopped, so neither should be counted. Print e.g.
   `2 workflows are still running. Press Ctrl+C again within 3s to stop them and shut down the server.`
   - **Make the confirmation expire** (about 3 s, like Claude Code). A second
     Ctrl+C much later must warn again, not stop work.
   - **Count again on the second press.** If the workflows finished during the
     window, just shut down.
   - **Only for an interactive Ctrl+C.** Apply the gate only to `SIGINT` when
     stdin/stdout is a TTY. `SIGTERM`, `SIGHUP`, `SIGBREAK`, and `SIGINT` when
     no TTY is attached (CI, `docker stop`, a service manager, a closed
     terminal) all shut down gracefully at once: there is nobody to answer a
     prompt, and on Windows a closed console allows only about 10 s.
4. **Graceful shutdown, with feedback:** print
   `Stopping N workflow(s) and shutting down… (press Ctrl+C again to force quit)`
   to stderr, then run `runtime.dispose()`. A confirmed second press means
   *stop gracefully* (workflows record a clean stop and the run can be
   continued later), not *force*. Calling it "force stop" would wrongly
   suggest state is lost.
5. **Ctrl+C during shutdown → force:** print `Force quitting.` and exit with a
   non-zero code (130 for SIGINT, the 128+signal convention), so scripts can
   tell a forced exit from a clean one. Keep exit 0 for a graceful shutdown
   that completes.
4. **Bound the graceful phase:** race `dispose()` against an overall deadline
   longer than `KILL_ESCALATION_DELAY_MS` plus the instance settle window
   (around 5 s). On timeout, log what was still pending and exit non-zero.
5. **Let process cleanup finish before exit:** do not call `process.exit`
   while kills are still running. Either have `CliProcessManager.dispose()`
   (or a new `disposeAsync()`) return a promise that resolves on child `close`,
   with SIGKILL escalation, and await it from `dispose()`, or close every
   handle and let the event loop drain instead of calling `process.exit(0)`.
   Either way, the SIGTERM → SIGKILL escalation must complete for children
   that are still running.
6. **More signals:** extend `ServerSignalSource` and `installServerShutdown`
   to handle `SIGHUP` and, on Windows, `SIGBREAK` through the same graceful
   path. Use `once` for the first signal so handlers are not left stacked.
7. **Reuse it:** `src/cli.ts` ~1287-1305 has its own Ctrl+C handler for
   `run`/`continue` with a different message and exit code (5). Move the
   two-stage signal handling (message, force-on-second, deadline, signal set)
   into one shared helper in `src/cli/` that both commands use, each passing
   its own dispose callback and exit codes.

`installServerShutdown` needs two more injected dependencies for the gate: a
`countRunningWorkflows()` query (backed by a new `WorkflowOrchestrator`
method) and an `isInteractive` flag. Inject the timer too, so the expiry can
be tested without real waiting.

Tests in `src/test/unit/ServerCommand.test.ts`: the banner ends with the stop
hint; with no running workflows, one Ctrl+C disposes at once; with running
workflows, one Ctrl+C only warns, a second within the window disposes once,
and a second after the window warns again; a second press after the workflows
finish just shuts down; `SIGTERM`/`SIGHUP`/`SIGBREAK`, and `SIGINT` with no
TTY, skip the gate; a Ctrl+C during dispose force-exits with 130; and the
deadline exits non-zero when dispose never resolves. `installServerShutdown`
already accepts injected `signals`/`exit`, so none of these need a real
process.

## Resolution note

Shutdown now uses one injected two-stage signal helper for the server and
`run`/`continue`, with an expiring interactive confirmation when server-owned
workflows are running, graceful-shutdown feedback, force-exit handling, and an
overall deadline. Hosted server disposal waits for CLI children to close after
SIGTERM and any SIGKILL escalation.

The Windows console note is verified as a possibility: [Microsoft documents
that Ctrl+C is delivered by default to console-attached
processes](https://learn.microsoft.com/en-us/windows/console/ctrl-c-and-ctrl-break-signals),
and these CLI children are not detached. A child harness may therefore receive
Ctrl+C directly. The implementation does not attempt to isolate children from
that console event; interrupted run state is recovered on the next start.
