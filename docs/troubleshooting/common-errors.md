# Common errors

## The workflow file validates in my head, but ctrlyoke refuses to run it

Run `ctrlyoke validate <file>` to see every schema and semantic error at once. Check the schema
shape first: multi-step workflows use `steps`, not `prompts`.

## "… unavailable. Install via: …"

The harness CLI could not be found. The message names the harness and its install command, for
example `Install via: npm install -g @anthropic-ai/claude-code`. Install it, make sure it is on
the `PATH` that VS Code (or your terminal) sees, and sign in with the harness CLI once before
running a workflow. After changing `PATH`, restart VS Code so the extension host picks it up. The
standalone CLI exits with code `3` in this case.

## A step never completes

ctrlyoke detects that a harness finished a turn through that harness's hook or notification
integration. Check `.ctrlyoke/logs/ctrlyoke-<harness>-hook-debug.log` (Codex CLI:
`ctrlyoke-codex-notify-debug.log`; OpenCode: `ctrlyoke-opencode-plugin-debug.log`). No entries at
all means the hook never ran; entries with a different session ID than the one in the session log
mean the completion was attributed elsewhere. Also check whether the step runs in interactive or
headless mode: in interactive mode you end the session.

## "Another run in this workflow lineage is executing"

Only one run per workflow lineage executes at a time, enforced by `runner.json` in the lineage's
run storage (see [Troubleshooting](/troubleshooting/#run-storage)). A lock is treated as stale, and
reclaimed automatically, when its owner process has exited or it has missed its heartbeat for 30
seconds. If the message persists while no ctrlyoke process is running — for example, a lock written
by another machine that syncs the same history — delete that lineage's `runner.json`.

## "This workspace requests external file roots that have not been approved yet"

The workspace's `.ctrlyoke/settings.json` lists `permissions.trustedExternalRoots` that nobody
has reviewed on this machine. Approve them when VS Code prompts you, or run
`ctrlyoke trust-external-roots`. The related message "This workflow requests external file roots
that have not been approved yet" refers to a workflow's `trustedExternalRoots`; run
`ctrlyoke trust-workflow-external-roots <file>`. Both block the run until approved.

## "This workflow requests secret grants that have not been approved yet"

Approve the workflow's secret grants from the ctrlyoke panel in VS Code or with
`ctrlyoke trust-secret-grants <file>`.

## `Secret "NAME" is missing for scope …`

A secret the workflow declares is neither stored as a managed secret nor set in the environment.
Store it (`ctrlyoke secret set NAME`, or the Secrets tab in the dashboard's settings) or export
`NAME` in the environment that launches ctrlyoke. `ctrlyoke secret check <file>` checks every
declared secret without starting a harness. By default a missing secret is a warning when a run
starts; set `execution.contextResolutionFailure` to `fail` to make it an error.

"No encrypted OS credential store is available" means the host has no usable credential-store
backend (common on headless Linux). Use environment variables instead of managed secrets there.

## A later step did not continue the conversation I expected

Check:

- whether the step set `resumeSession: true` or `sessionId`
- whether the earlier step actually captured a runtime session ID
- whether you changed harnesses between steps

## My validation script failed and the workflow stopped

There are two different cases.

**The condition failed.** The script ran, but its result did not match `expected`. An end
condition's `onFail` defaults to `stopWorkflow`, so the run stops. Set `onFail: retry` (with
`maxRetries`, which defaults to `1`) to send the step back to the harness instead. Check:

- whether `compareSource`, `operator`, and `expected` describe the check you meant — a numeric
  operator (`gte`/`gt`/`lte`/`lt`) fails outright when either side is not a number, and `matches` is
  an unanchored regex unless you add `^` and `$`
- the script's actual stdout, stderr, and exit code in the dashboard output or with
  `ctrlyoke history show`

**The script could not run.** A command that cannot be started (for example, an interpreter that is
not installed) or a timeout is an error, not a failed condition, and it is handled by
`errorBehavior` (`onError: stopWorkflow`, `retry`, or `continue`). Check the script path or command and the
timeout (`timeoutSec` on the condition, or the `execution.scriptTimeoutSec` setting). A script file that
is missing usually makes its interpreter exit non-zero, which counts as a failed condition instead.

## Dynamic queue did nothing

Confirm that the step includes:

```yaml
mcpServers:
  - ctrlyoke
```

Without the built-in server, the harness cannot call the queue tools. The built-in server is
allowed on parallel-group members. If the harness tried to append and was refused with "Queue
size limit exceeded", raise the `queue.maxSize` setting.

## The CLI finished, but I wanted an interactive session

Use `--interactive` on `ctrlyoke run`, or make sure stdin and stdout are attached to a TTY so the
CLI does not auto-select headless mode.

## "--prompt cannot be used together with a file argument"

`ctrlyoke run` takes either a workflow file or `--prompt <text>`, not both. To change one step of a
workflow, edit the file or use `--var` for values the workflow references.
