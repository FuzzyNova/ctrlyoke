# CLI interrupted at the run header sometimes stays alive after printing "stopped"

- **Found:** 2026-11-09 by bug-hunt final step (pass 26), claude-cli
- **Area:** `src/cli.ts` (run interrupt/shutdown), `src/test/integration/cli-interrupt.integration.test.ts`
- **Resolution:** fixed in this commit — the test helper attached its `close` listener after a header-interrupted CLI could already have exited; it now observes exit/close from spawn time. The CLI was not hanging.

## Symptom

The integration test `CLI interrupted run > interrupting at the run header
prevents the first step from starting` fails intermittently with:

```
Error: CLI did not exit after SIGINT: ctrlyoke CLI v0.5.2
Running: workflow.ctrlyoke.yaml
...
Interrupted. Stopping workflow...
✗ Workflow ended: stopped
Run ID: run-...
```

So the CLI handled the interrupt and printed its final result, but the child's
`close` event didn't fire within 30 s. Either the process didn't exit, or
something it spawned kept its stdout/stderr pipes open. The test's script step
is `node -e "...; setTimeout(() => {}, 20000)"`. A grandchild that inherited
the pipes would hold `close` for about 20 s plus startup, which under load can
exceed the 30 s budget.

Seen on macOS on 2026-11-09: once in a full `npm test` run, and once in three
isolated runs of
`npm run test:extension -- src/test/integration/cli-interrupt.integration.test.ts`.
A standalone harness that sends SIGINT 0–400 ms after `Running:` didn't hang in
34 runs, so it seems to need suite-level load.

The test came with ~5a6642d ("Fix early CLI interrupt"), so the flake may sit
in the early-interrupt path that commit added.

## Steps to Reproduce

1. `npm run test:extension -- src/test/integration/cli-interrupt.integration.test.ts`,
   repeated, ideally with the machine under load (for example, run alongside
   `npm run test:ui`).
2. Sometimes the header-interrupt test fails with the timeout above.

## Root Cause

A race in the test helper, not in the CLI. `interruptRun` sent SIGINT from the
stdout `data` handler while its poll loop was asleep in a 25 ms
`setTimeout`. Only after that loop ended did it attach
`child.once("close", ...)`. A header interrupt never dispatches a step, so the
CLI stops, prints the summary and calls `process.exit` within that one sleep.
When it did, `close` had already fired before anyone listened, and the helper
waited out its 30 s timer. Load makes this more likely, because the
test-side timer fires late while the CLI keeps running. The two
script-running tests attach the listener in the same tick as the kill, so
they were never affected.

Confirmed by lengthening the header case's poll sleep to 1500 ms: the old
helper then failed every time, with exactly the output above.

Ruled out: the CLI always reaches `process.exit` after the summary, and no
child it spawns inherits its stdout/stderr. `CliProcessManager.spawn` and the
other spawns use `pipe`, so a surviving script grandchild could not hold the
test's pipes open.

## Fix

`interruptRun` now attaches its `exit`/`close` listeners right after it spawns
the CLI and waits on the resulting promise. On timeout it reports whether
`exit` was seen, `child.exitCode`/`signalCode`, and whether the
`step-started` marker exists, so any future hang points at the CLI or at a
descendant holding the pipes. The header case waits 1 s before it starts
watching for the exit, which reproduces the old race every time, so it guards
against the regression.
