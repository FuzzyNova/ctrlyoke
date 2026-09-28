# `maxSteps` is not enforced (or even reported) when the authored steps already exceed it

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/core/WorkflowInstance.ts`, `src/core/ExecutionPreviewService.ts`, `src/cli.ts`
- **Severity:** medium

## Symptom

The schema describes `maxSteps` as the "Maximum number of entries in the run's `steps` array,
regardless of who queued them, including parallel members and disabled steps". A workflow whose
authored `steps` already exceed the cap still runs every step and reports success. Nothing warns
about it:

- `ctrlyoke validate` says the file is valid.
- `ctrlyoke run --dry-run` lists all steps with no limit warning.
- `ctrlyoke run --headless` runs all steps and prints "Workflow completed successfully".

The cap is enforced only for steps appended later (MCP `append_step`, CLI `step append`, the
finalStep), so a run can end up above its own cap from the start.

## Steps to Reproduce

1. In a temp git repo, create:

   ```yaml
   maxSteps: 2
   steps:
     - type: script
       script: node -e "console.log('one')"
     - type: script
       script: node -e "console.log('two')"
     - type: script
       script: node -e "console.log('three')"
   ```

2. `node out/cli.js validate wf.ctrlyoke.yaml` exits 0. `node out/cli.js run wf.ctrlyoke.yaml --dry-run`
   shows 3 steps and no violation.
3. `node out/cli.js run wf.ctrlyoke.yaml --headless` runs all three steps and exits 0.

## Root Cause

- `WorkflowExecutor.checkStepLimit` (around line 4822) is only called after the finalStep adds
  steps (around line 743). The `WorkflowInstance` add paths only check new additions.
- `ExecutionPreviewService.buildLimits` (around line 1348) already computes a
  `Step count 3 exceeds limit 2` violation, but nothing reads `ExecutionLimitsPreview.violations`:
  the dry-run formatter, `validate`, and the dashboard preview all ignore it.

## Suggested Fix

Check the effective cap (`resolveEffectiveMaxSteps`) against the authored step count when a run
starts, and fail the run with the same limit message the append paths use, pointing at
`maxSteps`. Surface `ExecutionLimitsPreview.violations` in `--dry-run` output (and its JSON) and
as a `validate` diagnostic when the workflow's own `maxSteps` is below its authored step count.
Add tests for run start, dry run and validate. Update `docs/workflows/dynamic-queue.md` if it
needs to mention that authored steps count against the cap too.
