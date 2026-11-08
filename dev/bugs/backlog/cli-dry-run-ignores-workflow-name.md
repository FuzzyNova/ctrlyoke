# CLI dry run always reports "Unnamed workflow"

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/core/ExecutionPreviewService.ts`, `src/cli.ts`
- **Severity:** low

## Symptom

`ctrlyoke run <file> --dry-run` prints `Dry run: Unnamed workflow` for every
workflow file, even one with a root `name:`. The `--json` envelope carries the
same wrong value in `preview.workflow.name`, which scripts can read. The schema
says the fallback for a missing `name` is the file name without its extension,
so an unnamed file should not say "Unnamed workflow" either.

## Steps to Reproduce

1. Write `t.ctrlyoke.yaml`:

   ```yaml
   name: t
   harness: opencode-cli
   steps:
     - prompt: hello
   ```

2. Run `ctrlyoke run t.ctrlyoke.yaml --dry-run` (or add `--json`).
3. The heading reads `Dry run: Unnamed workflow`, and the JSON reports
   `"name":"Unnamed workflow"`. Expected: `t`.

## Root Cause

`ExecutionPreviewService.build` names the workflow
`request.workflowName ?? this.getWorkflowName(workflow) ?? "Unnamed workflow"`.

- The CLI dry-run path (`runDryRun` in `src/cli.ts`, the `service.build({...})`
  call around line 1935) never passes `workflowName`.
- `getWorkflowName` (`src/core/ExecutionPreviewService.ts`, around line 1462)
  reads a `workflowName` field that `PromptFile` does not have. The authored
  name is parsed into `PromptFile.name` (`PromptFileParser`, around line 1165),
  so this fallback can never match. It is dead code.

The dashboard is not affected because `WorkflowOrchestrator` passes
`state.workflowName`.

## Suggested Fix

- Make `getWorkflowName` read `workflow.name`, trimmed, ignoring an empty value.
  Consider falling back to the file name without its extension from
  `request.sourcePath`, as the schema documents. Single-source that basename
  logic with any existing helper rather than adding a new one.
- Also treat an empty `request.workflowName` as missing (`||` rather than `??`)
  so a blank dashboard name falls through.
- Add an `ExecutionPreviewService` unit test for a named and an unnamed file,
  and assert the name in a CLI dry-run test
  (`src/test/integration/cli-run-commands.integration.test.ts`).
