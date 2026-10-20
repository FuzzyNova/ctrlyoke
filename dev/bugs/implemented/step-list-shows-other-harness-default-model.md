# Step list shows another harness's default model for a step with its own harness

- **Found:** 2026-10-19 by Claude Code while exploring demo-app workflows in the media capture host
- **Area:** step list rows (`src/ui/webview-react/components/prompts/`), inherited model resolution
- **Resolution:** fixed in this commit

## Symptom

With no workflow-level `harness`/`model` and Antigravity CLI as the detected default, demo-app's
`bug-sweep.ctrlyoke.yaml` lists its `harness: claude-cli` step as
"Hunt API bugs · Claude Code · gemini-3.8-flash-medium (default)", and the `codex-cli` and
`copilot-cli` steps the same way. A Gemini model is not a Claude Code model. The Workflow
Properties panel showed "9 compatibility warnings across 2 harnesses" for the same file.

## Steps to Reproduce

1. `npm run media -- host`, open the dashboard (Antigravity CLI on `PATH`, no user default harness).
2. Load `.ctrlyoke/workflows/bug-sweep.ctrlyoke.yaml` at the pinned demo-app ref.
3. Read the model line under each hunt step in the step list.

## Root Cause

A display bug only. `WorkflowStepsPanel` resolved a pending step's model as
`step.model ?? workflowProperties.model ?? globalSettings.model`. The final step did the same.
`globalSettings.model` is the default model of the _default_ harness (Antigravity's, when it is
the detected one), and the chain never checked which harness the step runs on.

Execution was already right. `resolveExecutionProperties` (`src/types/ExecutionPropertyResolver.ts`)
inherits the workflow model only when the step's harness equals the workflow's
(`inheritsWorkflowHarnessScopedValues`). Otherwise it uses `defaults.modelsByHarness[stepHarness]`.
`PropertyResolver.test.ts` covers this ("workflow model and args apply only to steps on the
workflow's harness"). A `claude-cli` step never receives `gemini-3.8-flash-medium`.

The "9 compatibility warnings" in the same report are unrelated. That summary counts permission
diagnostics only and does not look at models.

## Fix

Steps and the final step now share one pending-row resolver in `WorkflowStepsPanel`. It reads
the model from `settingsStore.getEffectiveModel(step.harness)`, which applies the same
harness-scoped rule as execution. A step on another harness shows that harness's default
model, still marked "(default)".
