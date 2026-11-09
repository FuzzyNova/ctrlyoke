# Ctrl+C before the first step dispatches is ignored: the step runs, then the CLI times out and orphans it

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro while reviewing 913b874e6)
- **Area:** `src/cli.ts` (`runCommand` signal handling, around lines 1407–1446), `src/core/WorkflowInstance.ts` (`shutdown`, around line 1331)
- **Resolution:** fixed in this commit

## Symptom

Press Ctrl+C (or send `SIGTERM`) to `ctrlyoke run` after the run header prints
but before the first step has been dispatched. The CLI prints
`Interrupted. Stopping workflow...`, but the workflow keeps starting and the
first step runs anyway. Five seconds later the CLI prints
`Workflow shutdown timed out.` and exits 5 with the step still running:

- the step's child process is orphaned and keeps running after the CLI exits;
- the run file is left with `executionState: "running"`;
- no `✗ Workflow ended: stopped` summary or `--json` result line is printed.

This is a regression from 913b874e6 ("print CLI results before exiting
interrupted runs"). Before it, the signal path exited 5 as soon as
`instance.shutdown()` returned, so a Ctrl+C in this window still ended the
process before the step started.

## Steps to Reproduce

A script that SIGINTs the CLI as soon as `Running:` appears on stdout
(about 370 ms after spawn, before the step starts):

```js
// node early-sigint.js <repo>/out/cli.js
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cy-early-"));
const marker = path.join(root, "started");
const wf = path.join(root, "w.ctrlyoke.yaml");
const script = `node -e "require('fs').writeFileSync('${marker}','x'); setTimeout(()=>{},20000)"`;
fs.writeFileSync(wf, `name: w\nsteps:\n  - type: script\n    script: ${JSON.stringify(script)}\n`);
const child = spawn("node", [process.argv[2], "run", wf, "--headless", "--cwd", root], {
  cwd: root, env: { ...process.env, CTRLYOKE_HOME: path.join(root, "state") },
  stdio: ["ignore", "pipe", "pipe"] });
let out = "", sent = false;
child.stdout.on("data", (c) => { out += c;
  if (!sent && out.includes("Running:")) { sent = true; child.kill("SIGINT"); } });
child.on("close", (code) => console.log(code, fs.existsSync(marker), out));
```

Observed: `SIGINT sent at 371ms; marker exists: false`, then
`exit 5 after 5390ms; step started: true`, with output ending in
`Interrupted. Stopping workflow...`, the script step's header, and
`Workflow shutdown timed out.`. `ps` still shows the
`setTimeout(()=>{},20000)` child afterwards, and the run's
`workflow.ctrlyoke.json` says `"executionState": "running"`.

## Root Cause

`WorkflowInstance.shutdown()` only calls `stop()` when
`workflowRuntime.status` is `RUNNING` or `PAUSING`. While a start is still in
its pre-dispatch phase (`preDispatchStartup` is set: preflight, lock,
worktree setup) or has not been called yet (the CLI is still loading the file
or asking for trust), the status is not yet `RUNNING`, so `shutdown()` is a
no-op and resolves immediately. `stop()` already handles the pre-dispatch
phase correctly (it requests a stop that the startup honors via
`isStopRequestedDuringStartup`); `shutdown()` just never calls it there.

913b874e6 then set `exitOnSuccess: false` on the CLI's
`installTwoStageShutdown`, so nothing exits after that no-op dispose. The main
run path carries on into `executeLoadedPromptFile()`, which dispatches the
step. Only the 5 s `deadlineMs` timer finally calls `process.exit(5)` with
the step mid-flight, which skips the instance's own cleanup.

The VS Code host's deactivation calls `instance.shutdown()` too, so a reload
during a start's setup has the same gap (without the CLI timeout).

## Suggested Fix

1. In `WorkflowInstance.shutdown()`, also request `stop()` when a
   pre-dispatch startup is in flight (`this.preDispatchStartup !== undefined`),
   and wait for that startup's `settled` promise as well as
   `executionSettledPromise`, so a stop during setup settles before shutdown
   resolves.
2. In `runCommand` (`src/cli.ts`), check the `interrupted` flag before calling
   `instance.executeLoadedPromptFile()` / `executeAddressedCliOperation(...)`
   (and after each awaited trust prompt), and when it is set, skip execution
   and go straight to the stopped summary / JSON result with exit code 5.
   A run that has not been created yet has no `workflowKey`/`runRef`; make the
   JSON result say so rather than crashing.
3. Keep the 5 s deadline and the second Ctrl+C force-quit as the fallback.

Tests: a unit test for `shutdown()` during a pre-dispatch startup (it must
stop the startup and no step may be dispatched), and a case in
`src/test/integration/cli-interrupt.integration.test.ts` that sends SIGINT as
soon as `Running:` is printed and asserts exit 5 within the deadline, that the
script's start marker was never written, and that no `executionState:
"running"` run file is left behind.
