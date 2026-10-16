# MCP step harness/model check accepts uninstalled harnesses and skips model-only steps

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; code reading)
- **Area:** `src/mcp-server.ts` (`validateStepHarnessAndModelCapabilities`)
- **Severity:** medium

## Symptom

`append_step`/`edit_step` validate a step's harness and model against `capabilities.json`, but:

- `{"harness":"codex-cli"}` is accepted when Codex isn't installed, even though the error text
  and `list_harnesses` offer only installed harnesses;
- `{"prompt":"x","model":"gpt-9"}` on a `claude-cli` workflow is accepted, because a step that
  sets only `model` (the common "use the workflow's harness" case) skips validation entirely.

In both cases the step fails later, when it is dispatched, instead of at the tool call.

## Steps to Reproduce

1. On a workflow whose harness is `claude-cli`, call `append_step` with
   `{"steps":[{"prompt":"x","model":"not-a-model"}],"position":"end"}`. It succeeds.
2. On a machine without Codex, call `append_step` with a step whose `harness` is `codex-cli`. It
   succeeds.

## Root Cause

`mcp-server.ts:1572-1597`:

- `if (isScriptStep(step) || !step.harness) continue;` skips any step without its own `harness`.
- `writeCapabilities` lists all six `HARNESS_IDS`, marking uninstalled ones `available: false`.
  `capabilities.harnesses.find((h) => h.id === step.harness)` therefore always finds an entry and
  never checks `available`.

## Suggested Fix

Resolve the step's effective harness (the step's `harness`, else the run's workflow `harness`, else
the global default, as dispatch resolves it) and validate the model against that harness. Reject
an entry whose `available` is `false`, with the same "Available harnesses: …" message. Add tests
for the model-only case and the unavailable-harness case.
