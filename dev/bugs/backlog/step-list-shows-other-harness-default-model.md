# Step list shows another harness's default model for a step with its own harness

- **Found:** 2026-10-19 by Claude Code while exploring demo-app workflows in the media capture host
- **Area:** step list rows (`src/ui/webview-react/components/prompts/`), inherited model resolution
- **Severity:** medium

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

Not yet investigated. The row seems to inherit the workflow's effective default model without
checking that it belongs to the step's harness. Whether the run would also pass
`gemini-3.8-flash-medium` to `claude` is not confirmed; if it would, this is a run failure, not
only a display issue.

## Suggested Fix

When a step overrides `harness` but not `model`, resolve the inherited model per harness: the
workflow model only if the step's harness accepts it, else that harness's default. Show that
in the row, and check that execution resolves the model the same way.
