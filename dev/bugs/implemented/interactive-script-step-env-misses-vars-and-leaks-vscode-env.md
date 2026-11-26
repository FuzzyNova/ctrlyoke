# Interactive script steps miss `CTRLYOKE_VAR_<NAME>` and inherit the extension host's VS Code variables

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli, via subagent)
- **Area:** `src/core/WorkflowExecutor.ts` (interactive script-step branch), `src/core/WorkflowInstance.ts` (`spawnScriptPty`), `src/core/orchestration/ScriptProcessRunner.ts`
- **Resolution:** fixed in this commit

## Symptom

`docs/workflows/variables.md:176-179` says every script ctrlyoke runs, script
steps included, gets each workflow variable as `CTRLYOKE_VAR_<NAME>`. The guide
recommends reading the variable over `{{name}}` whenever a value may contain
shell metacharacters. In the VS Code extension, a script step in **interactive**
execution mode (run in a PTY) gets no `CTRLYOKE_VAR_*` variables at all, so a
script that follows that advice reads an empty value with no error.

The same PTY environment also inherits the extension host's
`ELECTRON_RUN_AS_NODE`, `VSCODE_PID`, `VSCODE_NLS_CONFIG`, `VSCODE_INJECTION`
and `VSCODE_HANDLES_UNCAUGHT_ERRORS`, which the headless runner deliberately
removes. With `ELECTRON_RUN_AS_NODE=1`, launching `code` or any other Electron
app from the script starts it as plain Node.

Headless script steps, CLI runs (which always take the headless path,
`WorkflowInstance.ts:2300`) and condition scripts are not affected.

## Steps to Reproduce

1. A workflow with `vars: { module: src/parser }` and an interactive script step
   `script: echo "mod=$CTRLYOKE_VAR_MODULE electron=$ELECTRON_RUN_AS_NODE"`.
2. Run it from the VS Code dashboard in interactive mode: it prints
   `mod= electron=1`.
3. Run the same step headless (or with `ctrlyoke run`): it prints
   `mod=src/parser electron=`.

## Root Cause

- `WorkflowExecutor.ts:3229-3233`: the PTY branch passes
  `env: await this.resolveScriptEnvironment(effectiveStep.env, secretNames, context)`.
  `resolveScriptEnvironment` (`:4070-4092`) adds only secrets and
  `CTRLYOKE_WORKING_FILE`. `scriptVars` (`:3054`) is never given to it.
- `WorkflowInstance.ts:4134` builds the PTY env as
  `{ ...process.env, ...(options.env ?? {}) }` without the VS Code variable
  stripping.
- The only code that exports `CTRLYOKE_VAR_*` and strips the VS Code variables
  is `ScriptProcessRunner.run` (`ScriptProcessRunner.ts:102-125`), which only the
  headless path uses.

## Suggested Fix

Move that logic into one exported helper next to `ScriptProcessRunner`, for
example `buildScriptProcessEnv(baseEnv, vars, env)`, that removes the VS Code
variables, adds `CTRLYOKE_VAR_<NAME>` and then applies the step's env. Use it in
both `ScriptProcessRunner.run` and `spawnScriptPty`, passing `scriptVars` through
the `spawnScriptPty` options from the interactive branch. Add a unit test for
the helper, and an executor-level test asserting that the interactive
`spawnScriptPty` call receives `CTRLYOKE_VAR_*` (see the existing interactive
script-step tests under `src/test/`).
