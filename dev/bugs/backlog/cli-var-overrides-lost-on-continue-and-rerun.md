# `--var` overrides are not saved to the run, so `continue` and `rerun` fall back to the file's defaults

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/cli.ts` (`mergeCliVarsIntoWorkflow` call in the run path, ~1196-1201)
- **Severity:** medium

## Symptom

`b.ctrlyoke.yaml`:

```yaml
vars:
  who: default
steps:
  - type: script
    script: echo "one {{who}}"
  - type: script
    script: node -e "process.exit(require('fs').existsSync('ok.flag') ? 0 : 1)"
    onFail: stopWorkflow
  - type: script
    script: echo "three {{who}}"
```

```
ctrlyoke run b.ctrlyoke.yaml --headless --var who=cli      # prints "one cli", exits 1 at step 2
touch ok.flag
ctrlyoke continue --workflow <key> --run 1 --headless     # prints "three default"
```

The run's `workflow.ctrlyoke.json` still has the file's own `vars`, never the CLI values. `rerun`
has the same problem, and since `rerun` doesn't accept `--var`, the user can't put them back.

Expected: the docs say CLI values override the workflow's own `vars`; a continued or rerun copy
of that run should keep using the values the run was started with.

## Steps to Reproduce

As above (script steps only, no harness needed).

## Root Cause

`instance.loadPromptFile()` persists the run's working copy before `mergeCliVarsIntoWorkflow`
runs, and the merge only mutates the in-memory `promptQueue.getWorkflowFile()` object. Nothing
writes the merged `vars` back to the run file, which is what `continue`/`rerun` load.

## Suggested Fix

Apply the CLI vars before the working copy is first written, or persist the merged `vars` into the
run's working copy immediately after merging (through the existing working-file save path, not an
ad-hoc write). Tests: after `run --var who=cli`, the run's `workflow.ctrlyoke.json` has
`vars.who === "cli"`, and a continued run substitutes `cli`.
