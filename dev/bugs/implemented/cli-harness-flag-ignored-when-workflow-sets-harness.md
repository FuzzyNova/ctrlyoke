# `ctrlyoke run --harness` is ignored when the workflow sets `harness`, but dry-run and the run header say otherwise

- **Found:** 2026-10-04 by Claude (claude-cli), while auditing CLI flag scopes with the user
- **Area:** `src/cli.ts`, `src/utils/PropertyResolver.ts`, `src/types/ExecutionPropertyResolver.ts`
**Resolution:** fixed in this commit

## Symptom

With a workflow that sets `harness: claude-cli`, running
`ctrlyoke run wf.yaml --harness copilot-cli` runs Claude anyway:

```text
Harness: copilot-cli (opus)          ← run header
│ Step 1/1 — inherits
│ Harness: claude-cli                ← what actually ran
│ $ C:\Users\…\claude.exe "reply with just: ok" -p …
```

`ctrlyoke run wf.yaml --harness copilot-cli --dry-run` reports `Harness: copilot-cli` for the
same step. The run header and the dry-run preview both promise a harness the run does not use.
The flag works only when the workflow leaves `harness` unset, in which case it acts as the
settings default.

## Steps to Reproduce

1. Create a workflow with `harness: claude-cli` and one step without its own `harness`.
2. `ctrlyoke run wf.yaml --harness copilot-cli --dry-run` → step shows `Harness: copilot-cli`.
3. `ctrlyoke run wf.yaml --harness copilot-cli --headless` → header says `copilot-cli`, the
   step header says `claude-cli`, and the command line launches `claude.exe`.

## Root Cause

The three paths resolve the harness differently:

- **Real run.** `cli.ts` applies `--harness` in two places. It writes
  `overlay.defaults.harness`, which is the settings tier, and it passes `explicitHarness` to
  `instance.executeLoadedPromptFile(explicitHarness)`. That override only picks the startup
  and preflight integration: `ensureHarnessReadiness`, `createIntegrationForMode`, and the
  usage warning. The harness for each step is resolved by `resolveExecutionProperties`
  (`src/types/ExecutionPropertyResolver.ts`, around line 333) as
  `select(prompt.harness, workflow.harness, defaults.harness)`. The workflow's own value sits
  above the settings tier, so it wins.
- **Dry-run** (`cli.ts` around line 1650) sets `previewWorkflow.harness` from the flag. That
  is the workflow level, so the preview disagrees with the real run.
- **Run header** (`resolveCliRunHarnessAndModel`, around line 577) computes
  `explicitHarness ?? workflow?.harness ?? default`, a third rule.

`--model` does not have this problem. `cli.ts` writes it with
`promptQueue.updateWorkflowProperty("model", …)`, which is the workflow level.

## Suggested Fix

Apply `--harness` at the workflow level, the same way `--model` is applied, through one
shared function that the real run, dry-run and the run header all use. Then stop writing
`overlay.defaults.harness` from the flag. This is phase 1 of
[`CLI_FLAG_OVERRIDE_SCOPE_PLAN.md`](../../backlog/CLI_FLAG_OVERRIDE_SCOPE_PLAN.md), which
generalizes the fix to every property flag.

Add an integration test that runs a fake harness, not a dry-run, and asserts which harness
was spawned. The existing CLI tests only check how Commander parses the flag, so this bug
had no coverage.
