# A step on another harness inherits a model seeded for the workflow's harness

- **Found:** 2026-10-14 by Claude Code (documenting property inheritance for `docs/workflows/yaml-format.md`)
- **Area:** `src/core/orchestration/PromptFileLoader.ts`, `src/types/ExecutionPropertyResolver.ts`
- **Resolution:** fixed in this commit. The workflow-level `model` and
  `additionalArgs` are still seeded from settings but now apply only to steps
  on the workflow's harness (`inheritsWorkflowHarnessScopedValues` in
  `ExecutionPropertyResolver.ts`); other steps fall through to their own
  harness's settings default. The step drawer and footer label that fallback
  **Default (…)** instead of **Inherit (…)**, picking a step harness now clears
  the step's model and args, and the `model` schema description no longer
  promises a fallback on every harness.

## Symptom

A hand-written workflow that never mentions `model` or `additionalArgs` at the root, but switches
one step to another harness, runs that step with the _workflow harness's_ default model and
default additional arguments:

```yaml
harness: claude-cli
steps:
  - prompt: Plan the change.
  - harness: antigravity-cli
    prompt: Implement the plan.
```

The second step is launched as `agy --model sonnet …`. agy rejects unknown models with exit 1, so
the step fails. Qwen Code behaves the same way (any string is passed through). Copilot, Codex and
OpenCode silently replace the foreign model with their own default and log a warning, which hides
the problem; Claude maps Copilot-style IDs by family. `additionalArgs` has the same shape: the
workflow's `defaults.additionalArgs["claude-cli"]` value is handed to the other harness, which may
reject flags it doesn't know.

This also contradicts the `model` schema description ("unsupported models fall back to the
harness default with a warning"), which is untrue for `qwen-cli` and `antigravity-cli`.

Confirmed 2026-10-14 with Dry Run in the demo project (`docs-mixed` workflow, user
`defaults.models["claude-cli"]` = `opus`): step 2's Command tab shows
`agy.exe --prompt-interactive … --model opus --add-dir … --dangerously-skip-permissions`. Not
run for real.

## Steps to Reproduce

1. Set `defaults.harness` to `claude-cli` (or put `harness: claude-cli` in the file) and leave
   `defaults.models` at its defaults.
2. Open the workflow above in the dashboard and run it (or run it with `ctrlyoke run`).
3. The second step's command line (visible in Dry Run → Command) carries `--model sonnet`; agy
   fails with an unknown-model error.

## Root Cause

`PromptFileLoader.populateSettingsDefaults()` (`PromptFileLoader.ts:548-631`) copies
`ConfigurationUtils.getModelForHarness(effectiveHarness)` and
`getAdditionalArgsForHarness(effectiveHarness)` into the working copy's **root** `model` and
`additionalArgs` whenever the source file omits them. `WorkingFileManager` does the same for
`model` under `ensureHarnessAndModel` (`WorkingFileManager.ts:2656-2669`).

`resolveExecutionProperties()` (`ExecutionPropertyResolver.ts:337-341`, `:271-299`) then resolves
`prompt.model ?? workflow.model ?? defaults.modelsByHarness[stepHarness]`. Because the root value is
always present after seeding, the per-harness default for the step's own harness is never reached.

The dashboard avoids this when a user picks a step harness interactively
(`buildHarnessChangeCascade` in `harnessChangeCascade.ts` writes the new harness's model and
args onto the step), but hand-authored and template/MCP-appended steps get no such cascade.

`QwenCliProvider.validateAndGetModel` and `AntigravityCliProvider.validateAndGetModel` pass any
string through, so they never fall back as the schema promises.

## Suggested Fix

Either:

- Stop seeding root `model`/`additionalArgs` from settings (they are per-harness defaults, and the
  resolver already falls back to `defaults.modelsByHarness[harness]`), or seed them only when no
  step overrides `harness`; or
- In the resolver, ignore an inherited (workflow-level) `model`/`additionalArgs` when the step's
  resolved harness differs from the workflow's harness and the value came from settings seeding,
  falling through to the step harness's own default.

The first is simpler and keeps the resolver pure. Add a resolver test with a mixed-harness
workflow, and either make Qwen/Antigravity fall back for models known to belong to another harness
or reword the `model` schema description so it no longer promises a fallback on every harness
(then run `npm run schema:update`).
