# `run --json` reports the default harness and model, not `--harness`/`--model`, when the run errors early

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced with the compiled `out/cli.js`)
- **Area:** `src/cli.ts` (`getCliReportingWorkflow`, the `runCommand` catch block)
- **Severity:** low

## Symptom

When `ctrlyoke run <file> --harness claude-cli --model sonnet --json` fails before the workflow
loads (for example an invalid workflow file), the JSON result names the settings default
(`"harness":"antigravity-cli","model":"gemini-3.8-flash-medium"` on the reproducing machine)
instead of the harness and model the user passed. Scripts that read `harness`/`model` from the
`--json` result to label or route failures get the wrong value.

## Steps to Reproduce

1. Create an invalid `w.ctrlyoke.yaml`.
2. `node out/cli.js run w.ctrlyoke.yaml --harness claude-cli --model sonnet --headless --json 2>/dev/null`
3. The JSON shows the detected default harness/model, `"status":"error"`, exit 2.

## Root Cause

The catch block reports
`resolveCliRunHarnessAndModel(getCliReportingWorkflow(instance.promptQueue.getWorkflowFile(), operation, options), harness)`.
For `CLI_RUN_OPERATION_KINDS.RUN`, `getCliReportingWorkflow` returns the workflow unchanged, or
`undefined` when loading failed, and the fallback `harness` is
`ConfigurationUtils.getIntegrationMode()`, which ignores `options.harness`. The `--harness` and
`--model` flags only reach the workflow through `applyCliPropertyOverrides`, which runs after a
successful load.

## Suggested Fix

Make `getCliReportingWorkflow` apply `options.harness`/`options.model` for `RUN` as it does for
`RERUN`, including when no workflow loaded (so the explicit flag wins, matching the precedence
`resolveCliRunHarnessAndModel` documents). Keep `append`'s harness flag step-scoped as today.
Cover it with a test of the early-failure JSON result.
