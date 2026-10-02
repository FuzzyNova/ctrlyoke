# `ctrlyoke run --dry-run --harness X` previews the workflow's own harness instead of X

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced with the built CLI (dry-run only)
- **Area:** `src/cli.ts` (`dryRunCommand`, ~1516-1575)
- **Severity:** medium

## Symptom

1. Create a workflow with `harness: claude-cli` and one prompt step.
2. Run `ctrlyoke run wf.ctrlyoke.yaml --dry-run -H codex-cli`.

The preview shows `Harness: claude-cli` and a `claude` command line. Adding
`-m gpt-x` makes it contradict itself: `Model: gpt-x`, but the command line
still passes `--model opus`.

A real run with the same flags uses codex-cli: `executeLoadedPromptFile`
receives `explicitHarness`, and `WorkflowStartupPipeline` resolves
`step.harness ?? modeOverride ?? workflow.harness`, so the flag beats the
workflow's own harness.

## Root Cause

`dryRunCommand` copies `config.model` onto `workflow.model` (~1541), but puts
`--harness` only into `defaults.harness` and `modelsByHarness`. The workflow's
own `harness:` therefore wins in the preview.

## Suggested Fix

Make the dry run resolve the harness the same way a real run does. Prefer
reusing the real run's override application rather than adding another copy.
At minimum, set `workflow.harness` when the `--harness` flag was given
explicitly, not just defaulted. Add a dry-run test with a workflow-level
`harness:` plus `-H`, and with `-m`.
