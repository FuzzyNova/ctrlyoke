# `ctrlyoke run --model` is ignored when the workflow sets `model:`, and `--json` reports the flag anyway

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/cli.ts`
- **Resolution:** fixed in this commit

## Symptom

If a workflow file sets a workflow-level `model:`, `ctrlyoke run <file> --harness <h> --model <m>`
still runs the workflow's model. The run header and the `--json` result, however, report the
`--model` value. Two things break:

- The documented override does nothing. `docs/cli/ctrlyoke.md` describes `--model` as the model
  for the harness selected by `--harness` and says to "pass both when you override a model".
- The JSON result misreports what the run used. `docs/cli/ci.md` says `harness`/`model` are "what
  the run used".

`--harness` does override the workflow's `harness:`, so the two flags behave inconsistently.

## Steps to Reproduce

1. Create a workflow with `harness: claude-cli`, `model: sonnet` and one prompt step.
2. Run `ctrlyoke run wf.ctrlyoke.yaml --dry-run --harness claude-cli --model opus`.
3. The dry run shows `Model: sonnet` and `--model sonnet` in the command.
4. Without `--dry-run`, and with `--json`, the result reports `"model": "opus"`.

## Root Cause

- `src/cli.ts` (around lines 685-689) only puts `--model` into the settings overlay as
  `defaults.models[harness]`.
- `ExecutionPropertyResolver` resolves `step.model ?? workflow.model ?? defaults`, so the
  workflow's own `model:` wins.
- `resolveCliRunHarnessAndModel` (`src/cli.ts`, around line 452) states in its JSDoc that
  execution applies "an explicit `--harness`/`--model` flag, then the workflow's own
  `harness`/`model`". It reports `explicitModel` first, which does not match execution.

## Suggested Fix

Make `--model` a real workflow-level override, matching how `--harness` is applied through
`executeLoadedPromptFile(explicitHarness)`. Apply it at workflow level, so steps that name their
own `model` still win, as the resolver's JSDoc already says. The header and JSON then stay correct
by construction. Add a CLI test (a dry run is enough) proving that `--model` overrides a
workflow-level `model:`.
