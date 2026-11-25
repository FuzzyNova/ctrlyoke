# MCP `append_step`/`edit_step` accept any harness id when `.ctrlyoke/capabilities.json` is absent

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced with a temporary test in `src/test/unit/McpServer.test.ts`)
- **Area:** `src/mcp-server.ts` (`validateStepHarnessAndModelCapabilities` ~1938-1977; callers ~1516 append, ~1751 edit), `src/utils/McpToolDefinitions.ts` (~281-285, ~364), `src/core/IntegrationFactory.ts` (~83, ~232)
- **Resolution:** fixed in this commit

## Symptom

In a workspace without `.ctrlyoke/capabilities.json`, an agent can append or edit a step
with `harness: "bogus-harness"`. The call reports success, `workflow_status` shows the
step with that harness and no schema warning, and the run only fails when the step is
dispatched (`IntegrationFactory` throws `Unknown harness: bogus-harness`).

Only the VS Code dashboard writes `capabilities.json` (`src/ui/DashboardSettingsSync.ts`
~410, ~837), so CLI-only and CI workspaces, or a workspace where detection never ran, have
no file. Those are exactly the headless runs nobody is watching.

## Steps to Reproduce

1. A RUNNING run in a workspace with no `.ctrlyoke/capabilities.json`.
2. Call `append_step` with
   `{"steps":[{"prompt":"x","harness":"bogus-harness","model":"nope"}],"position":"end"}`.
3. Observed: `success: true`. `workflow_status` lists the step with
   `"harness":"bogus-harness"`. Expected: rejected as an unknown harness id.

## Root Cause

`validateStepHarnessAndModelCapabilities` bundles the shape check (is this one of the six
`HARNESS_IDS`) with the environment check (is it installed, is the model valid), and returns
early on `if (!capabilities) return;` before either. The MCP input schema types `harness`
as a plain string, and `RunContinuationService.appendStepsToRun`/`editStepAtRun` do not
validate it either.

`docs/reference/mcp-tools.md` (~58) says harness and model are checked "when that
information is available". That covers skipping the installed/model checks, but not the
basic known-id check. The CLI had the same bug, fixed the same way
(`dev/bugs/implemented/cli-run-accepts-unknown-harness-and-runs-copilot.md`).

## Suggested Fix

In `validateStepHarnessAndModelCapabilities`, compute each prompt step's effective harness
(`SettingsPropertyResolver.resolveHarnessValue`) and reject a defined value that fails
`isHarnessId` (`src/types/DashboardConstants.ts` ~1831) _before_ the capabilities early
return. Use an error message that lists the valid ids. Keep the installed-harness and model
checks conditional on the file. Make sure an undefined effective harness (falling back to
the default) is still accepted. Tests: append and edit with no `capabilities.json` and
`harness: "bogus-harness"` are rejected and nothing is written. A valid id with no file is
still accepted.
