# Docs: `step reorder` says to include the running step; `retryPrompt` alone claimed to enable retries

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `docs/cli/ctrlyoke.md` (`ctrlyoke step reorder`, ~526–533), `docs/workflows/end-conditions.md` (~23–25)
- **Severity:** low

## Symptom

1. `docs/cli/ctrlyoke.md` says for `ctrlyoke step reorder`: "Pass every pending
   step's absolute zero-based index once, in its desired execution order. When a
   step is in flight, include that index first". But
   `RunContinuationService.reorderStepsAtRun` (used by `src/cli/StepCommands.ts`)
   treats running and started steps as fixed, and requires `--order` to be exactly
   the set of not-yet-started indices. Following the doc makes the command fail with
   `Reorder indices must contain exactly N not-yet-started step indices (...)`. The
   same stale sentence was fixed in `docs/reference/mcp-tools.md` by
   `docs-reorder-steps-running-step-instruction-wrong` (implemented), but the CLI
   page was missed.
2. `docs/workflows/end-conditions.md` says "A configured `retryPrompt` (on the step
   or in `defaults.endCondition.retryPrompt`) also enables failure retries with the
   default `onFail: stopWorkflow`." In `PromptQueue.resolveRetrySettings`, a
   `retryPrompt` with no `maxRetries` and no `retry` action takes
   `ConfigurationUtils.getDefaultMaxRetries()`, which is
   `defaults.endCondition?.maxRetries ?? 0`, so it gets zero retries with default
   settings. The schema's `maxRetries` description ("0 means no retries by default")
   and the `maxRetries` row of the same page's table both agree with the code, so
   the page contradicts itself.

## Steps to Reproduce

1. `ctrlyoke step reorder --workflow <w> --run <r> --order <running>,<pending...>`
   on a run with a running step. The command is rejected.
2. A step with `endCondition: { script: "exit 1", retryPrompt: "fix it" }` and
   default settings stops after the first failure, with no retry.

## Root Cause

Stale prose on both pages.

## Suggested Fix

- CLI page: "Pass every not-yet-started step's absolute zero-based index exactly
  once, in the order you want. Never include a running or completed step." Keep the
  wording aligned with `docs/reference/mcp-tools.md`.
- End conditions page: "A `retryPrompt` is only sent when retries are allowed:
  set `maxRetries` above 0 (on the condition or in
  `defaults.endCondition.maxRetries`), or use `onFail: retry`." Keep the rest of the
  paragraph.

Neither page is generated, but run `npm run check:docs` anyway.
