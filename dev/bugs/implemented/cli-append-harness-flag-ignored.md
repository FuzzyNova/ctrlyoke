# `ctrlyoke append --harness` is ignored but reported as applied

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/cli.ts` (append branch / `parseAppendTail`, `resolveCliRunHarnessAndModel`)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke append tail.ctrlyoke.yaml --workflow <key> --run 1 --harness codex-cli --headless --json` runs the appended steps with the run's original harness (log: `Step 2/2 started (…, harness=claude-cli)`), yet the JSON result reports `"harness":"codex-cli"`. The flag is documented as "Override harness for appended steps" (`src/cli/CliRunCommandDefinitions.ts`).

## Steps to Reproduce

1. Run a `harness: claude-cli` workflow with one script step to completion.
2. Append a one-prompt-step file with `--harness codex-cli` (a preCondition `stopWorkflow` avoids launching a real harness).
3. Log shows claude-cli; JSON says codex-cli.

## Root Cause

`options.harness` only reaches the settings overlay (`defaults.harness`). `executeContinuationAtRun` runs the run's working file, whose resolved workflow-level `harness` beats settings defaults, and `parseAppendTail` does not stamp the override onto the appended steps. `resolveCliRunHarnessAndModel` puts `explicitHarness` first, so the header/JSON misreport what ran.

## Suggested Fix

In `parseAppendTail`, set `harness` (and `model` if an append `--model` flag exists) on each appended prompt step that doesn't specify its own. Make the reported harness reflect what the appended steps actually use. Add a CLI test.
