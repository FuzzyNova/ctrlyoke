# CLI `validate` miscounts steps and the dry run prints "unlimited seconds"

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/cli.ts` (validate command), `src/cli/CliTerminalFormatter.ts` (`renderExecutionPreview`)
- **Severity:** low

## Symptom

Two related summary lines in the CLI's human-readable output are wrong:

1. `ctrlyoke validate <file>` prints `N prompt(s)`, where N is
   `result.steps.length`. That count includes script steps (which are not
   prompts) and leaves out `finalStep`. For the same file,
   `ctrlyoke run --dry-run` reports a different number of `step(s)`.
2. The `Execution guardrails` block of `ctrlyoke run --dry-run` adds
   ` seconds` to every value, including the placeholders. This produces
   `Workflow duration: unlimited seconds`, `Prompt timeout: unlimited seconds`
   and, when a limit is unknown, `— seconds`.

## Steps to Reproduce

```yaml
# a.ctrlyoke.yaml
name: test
steps:
  - prompt: hi
  - type: script
    script: echo hi
```

```yaml
# b.ctrlyoke.yaml
name: pg
steps:
  - parallel:
      - prompt: a
      - prompt: b
      - prompt: c
finalStep:
  prompt: done
```

1. `ctrlyoke validate a.ctrlyoke.yaml` prints `2 prompt(s)`, but only one step
   is a prompt.
2. `ctrlyoke validate b.ctrlyoke.yaml` prints `3 prompt(s)`, but
   `ctrlyoke run b.ctrlyoke.yaml --dry-run` prints `4 step(s)` because it
   counts the final step.
3. `ctrlyoke run a.ctrlyoke.yaml --dry-run` with default settings prints
   `Workflow duration: unlimited seconds` and
   `Prompt timeout: unlimited seconds`.

## Root Cause

- `src/cli.ts`, validate action (around line 2550):
  ``console.log(chalk.dim(`  ${result.steps?.length ?? 1} prompt(s)`))``
  counts `steps` only and calls them prompts.
- `src/cli/CliTerminalFormatter.ts`, `renderExecutionPreview` (around lines
  662–670): it appends ` seconds` after `formatPreviewLimit(...)`, which
  returns `unlimited` or `—` for non-finite limits, and after
  `limits.scriptTimeoutSeconds ?? "—"`.
  `src/test/unit/CliDryRunOutput.test.ts` (around line 350) currently asserts
  the wrong `Prompt timeout: unlimited seconds` text.

## Suggested Fix

- validate: print the total step count, the same number the dry run's
  `stepCount` reports (`steps` plus `finalStep` when present), as
  `N step(s)`. Reuse an existing helper that counts a parsed workflow's steps
  if there is one.
- dry run: add the unit only to numeric values. Use a small private helper,
  e.g. `formatPreviewSeconds(limit)`, that returns `900 seconds`,
  `unlimited` or `—`, and use it for all three timeout lines.
- Update `CliDryRunOutput.test.ts` and add a validate-output test. These are
  human-readable lines only (the `--json` envelopes are unchanged). Add a
  `CHANGELOG.md` **Fixed** entry under `## [Unreleased]`.
