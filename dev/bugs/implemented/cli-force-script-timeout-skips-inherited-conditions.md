# `--force script-timeout` skips workflow-level pre/end conditions

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/cli/CliPropertyOverrides.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke run --script-timeout 5 --force script-timeout` is documented to
"override step and condition `timeoutSec` values" (`docs/cli/ctrlyoke.md`,
`--script-timeout` row). It overrides only conditions written on the step
itself. A workflow-level `endCondition` or `preCondition` that steps inherit
keeps its own `timeoutSec`, so a CI job that forces a short script timeout can
still block for the full authored timeout on every step.

## Steps to Reproduce

```yaml
harness: opencode-cli
endCondition: { script: "true", timeoutSec: 600 }
preCondition: { script: "true", timeoutSec: 500 }
steps:
  - prompt: a
  - prompt: b
    endCondition: { script: "true", timeoutSec: 700 }
```

Pass that workflow through `buildCliPropertyOverrides({ scriptTimeout: 5,
force: ["script-timeout"] })` and then `applyCliPropertyOverrides`. Only step b's
own `endCondition.timeoutSec` becomes 5. The workflow-level `endCondition` (600)
and `preCondition` (500) are left alone. Step a inherits both, and step b
inherits the preCondition, through `resolveExecutionProperties` (see the
comment at `src/core/WorkflowExecutor.ts` around line 2709), so their scripts
still run with the 600 s and 500 s timeouts.

## Root Cause

`applyForcedFlagToStep`, `case ForceableFlag.SCRIPT_TIMEOUT`
(`src/cli/CliPropertyOverrides.ts`, around line 252), runs only over
`getWorkflowSteps(workflow)` and only rewrites `step.preCondition` and
`step.endCondition`. It never touches `workflow.preCondition` or
`workflow.endCondition`, which are what a step without its own condition
inherits.

## Suggested Fix

When `SCRIPT_TIMEOUT` is forced, also set `timeoutSec` on
`workflow.preCondition` and `workflow.endCondition` when they are objects (not
`null`). Do it once in `applyCliPropertyOverrides`, outside the per-step loop.
Leave `workflow.conditions` presets alone: they are author-owned MCP presets
whose execution settings the preset owns. Extend the existing forced-flags test
in `src/test/unit/CliPropertyOverrides.test.ts` with workflow-level conditions.
