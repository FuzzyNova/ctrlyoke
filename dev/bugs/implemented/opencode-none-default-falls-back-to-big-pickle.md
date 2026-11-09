# OpenCode passes `-m opencode/big-pickle` when the default model is None

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, failing Mocha repro)
- **Area:** `src/core/harness/opencode/OpenCodeCliProvider.ts` (`getModel`)
- **Resolution:** fixed in this commit

## Symptom

With `defaults.models["opencode-cli"]` set to `none` (offered by the model picker,
`src/utils/HarnessModelOptions.ts`), an `opencode-cli` step whose model is not in provider/model
form (e.g. `model: claude-sonnet-4-6`), or whose model arrives empty, runs
`opencode run --format json -m opencode/big-pickle`. The log says "Using configured default"
although the configured default is None. Expected: no `-m`, so OpenCode uses its own configured
model, as `model: none` on the step already does.

## Steps to Reproduce

Set the OpenCode default model to `none`, then `planCliArgs` for a step with
`model: claude-sonnet-4-6` (or `getModel(undefined)` / `getModel("")`): the args contain
`-m opencode/big-pickle`.

## Root Cause

2acda6b13 (`fix(harness): never pass --model none when the default model is None`, see
`dev/bugs/implemented/unrecognized-model-falls-back-to-literal-none.md`) fixed Claude, Copilot and
Codex only. `OpenCodeCliProvider.getModel` (~1031-1055) uses the configured default only when it
contains `/`; `none` does not, so it falls through to `DEFAULT_MODELS["opencode-cli"]`.

## Suggested Fix

In the fallback, return `undefined` when the configured default is `MODEL_NONE`, and fall back to
`DEFAULT_MODELS` only for a configured default that is set but not in provider/model form. Make
the warning text match what happens. Update the OpenCode harness doc's "A value without a `/` is
replaced by your default" line to cover None, as the Claude/Codex/Copilot docs were. Tests:
`src/test/unit/OpenCodeCliProvider.test.ts`.
