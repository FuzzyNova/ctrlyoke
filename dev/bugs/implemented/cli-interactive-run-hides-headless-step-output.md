# CLI interactive runs print nothing for headless steps, statuses, or script output

- **Found:** 2026-10-04 by Claude (claude-cli), while auditing CLI output parity with the user
- **Area:** `src/cli.ts`
- **Resolution:** fixed in this commit

## Symptom

When the CLI's run-level mode is interactive (`--interactive`, or the default when both stdin
and stdout are TTYs), only interactive steps produce terminal output, through the harness
TUI. Everything else is silent for the whole run:

- steps that set `executionMode: headless`, whether sequential or a parallel group's headless
  members alongside its one interactive member;
- the step headers, prompt previews, and command lines for those steps;
- workflow status messages, including retry, continue, and stop notices and condition
  results;
- pre-condition, end-condition, script-step, and worktree-setup output and verdicts;
- per-attempt stats, parallel-group progress, and retry aggregates.

A user watching an interactive run sees one TUI session close and the next one open (or the
closing `✓ Workflow completed successfully` line), with no sign that headless work happened in
between. A headless step that runs for minutes looks like a hang. Only errors and warnings
routed through `ConsoleUserFeedbackSink` reach stderr.

## Steps to Reproduce

1. Write a workflow with three steps: step 1 interactive, step 2 `executionMode: headless`
   with an end-condition script, and step 3 interactive.
2. Run it with `ctrlyoke run <file>` in a TTY, which resolves to interactive.
3. After step 1's TUI closes, nothing prints while step 2 runs, and nothing reports its
   verdict, until step 3's TUI starts.
4. Run with `--headless`: every step streams with headers, output, and verdicts.

## Root Cause

`cli.ts` (around line 1020) installs every live-output subscription inside a single gate on
the run-level mode:

```ts
if (
  executionMode === EXECUTION_MODES.HEADLESS &&
  !options.quiet &&
  !options.json
) {
  // onPromptStart, onTargetScriptOutput, onTargetStreamingEvents,
  // onTargetStreamingChunk, onWorkflowStatusMessage, onPromptComplete …
}
```

`executionMode` comes from `resolveCliExecutionMode` and describes the process, not each
step. In an interactive run, steps resolve their own `executionMode` (step > workflow >
settings, with the CLI overlay only setting the default), so headless steps are expected and
supported. The parallel preflight even relies on them: only one interactive member is allowed
per group. But no subscription exists to render them. The gate assumes "interactive run" means
"every step is interactive", and that has not been true since per-step `executionMode` was
introduced.

## Suggested Fix

Install the subscriptions whenever `!options.quiet && !options.json`, and decide per attempt
whether to render:

1. Record each attempt's resolved execution mode as it starts. `PromptStartData` does not
   carry it today; add `executionMode` from the resolved properties.
2. Skip structured-event and chunk rendering only for attempts that are interactive, since
   the TUI owns the terminal for those. Keep rendering every headless attempt, script output,
   status message, and stats line.
3. Do not write to stdout while an interactive TUI owns the terminal. This happens when a
   headless parallel member streams alongside the group's interactive member. Buffer that
   output per target and flush it, prefixed, when the interactive member's process exits,
   with a one-line notice that the buffered output follows. Unbuffered writes would corrupt
   the TUI's screen.
4. Tests: an interactive-mode CLI run (fake harness, forced TTY) with a headless sequential
   step prints that step's header, output and verdict. A parallel group with one interactive
   member prints the headless members' output only after the interactive member exits.

This fix and `CliEventStream` in
[`CLI_EVENT_RENDERING_PARITY_PLAN.md`](../../implemented/CLI_EVENT_RENDERING_PARITY_PLAN.md)
both change the same subscriptions in `cli.ts`. Fix this first, so the plan builds on
per-attempt gating instead of the run-level gate.
