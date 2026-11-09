# CLI interrupted at the run header sometimes stays alive after printing "stopped"

- **Found:** 2026-11-09 by bug-hunt final step (pass 26), claude-cli
- **Area:** `src/cli.ts` (run interrupt/shutdown), `src/test/integration/cli-interrupt.integration.test.ts`
- **Severity:** medium (low confidence in the cause; the symptom reproduces)

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

Unknown. Candidates to check:

- The script step was dispatched after all (a race between the interrupt flag
  and the dispatch), and stopping the run didn't kill the script's process tree.
  The surviving `node -e` grandchild keeps the inherited pipes open. Check
  whether the `step-started` marker exists when the test fails.
- A handle (timer, watcher, runner-lock heartbeat) that the interrupt path
  doesn't clear, keeping the CLI's event loop alive after the final result.

## Suggested Fix

First make the test record what is alive when it times out: the marker's
existence, and `child.exitCode` (exit) versus `close`. Then fix the real leak
(kill the script's process tree on stop, or clear the leftover handle). Don't
just raise the timeout.
