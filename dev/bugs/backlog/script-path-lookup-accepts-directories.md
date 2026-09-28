# An inline script whose first word matches a workspace directory is treated as a script file

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/EndConditionEvaluator.ts`
- **Severity:** high

## Symptom

If a workspace contains a directory whose name matches the first word of an inline script
command, ctrlyoke treats the command as a script-file path. The condition or step then errors
with `Unsupported script type:` instead of running the command. This affects pre-conditions,
end-conditions and script steps. Realistic triggers:

- `docker compose up` with a `docker/` folder
- `terraform plan` with `terraform/`
- `test -d src` with `test/`

## Steps to Reproduce

1. In a temp workspace, `mkdir test src`.
2. Create a workflow with `preCondition: {shell: bash, script: "test -d src"}` and one script step.
3. `node out/cli.js run wf.ctrlyoke.yaml --headless`
4. The pre-condition errors with `Unsupported script type:` and the workflow stops. After removing
   the `test/` directory, it passes.

## Root Cause

`resolveScriptPath` (around lines 363-505) tries each candidate location (absolute, relative to
the workflow, workspace, `.ctrlyoke/`, home) with `fs.promises.access(...)` only. `access`
succeeds for directories, so a directory is accepted as the script file.

## Suggested Fix

After a successful `access`, `stat` the candidate and accept it only if `isFile()`. Otherwise
keep searching and fall through to the inline-command path. Add unit tests for a candidate that
is a directory at each lookup location.
