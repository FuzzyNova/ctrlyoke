# Script steps are granted workflow-level hook and MCP secrets even with `secrets: []`/`null`

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code, reproduced with the compiled `SecretResolver`
- **Area:** `src/utils/SecretResolver.ts` (`getProcessMaps` ~302-313, `getDeclaredSecretGrants`), `src/core/WorkflowExecutor.ts` (~2600, `buildSecretProcessEnvironment`)
- **Resolution:** fixed in this commit

## Symptom

A workflow with an MCP server header `${secret:GITHUB_TOKEN}` and a workflow hook env
`${secret:SLACK_WEBHOOK}`, plus a script step with `secrets: null`: the script step is
still granted both names, and `buildSecretProcessEnvironment` injects `GITHUB_TOKEN` and
`SLACK_WEBHOOK` into the script's environment.

## Steps to Reproduce

1. Workflow-level `mcpServers` with a `${secret:GITHUB_TOKEN}` header and a hook with
   `env: { W: "${secret:SLACK_WEBHOOK}" }`.
2. A `type: script` step with `secrets: null` that prints its environment.
3. Both secret values are present.

## Root Cause

`getProcessMaps` collects secret names from inherited hooks and MCP servers for every
step kind, but script steps never run hooks or MCP servers.

## Fix

For script steps, `getProcessMaps` now collects only the step's own `env`. This
also keeps workflow-level hook/MCP references out of their grants and preflight
checks. Script steps do not evaluate pre/end conditions. Prompt steps retain
their existing hook/MCP and condition environment maps, so those secret names
are still validated and granted where they are consumed.

## Decision (orchestrator, 2026-10-01)

Fix it. Workflow `hooks` and `mcpServers` are harness configuration — they are
installed into a CLI harness's hook/MCP config and never run for a `type: script`
step, so their `${secret:...}` names are not that step's inputs. In `getProcessMaps`
a script step contributes only `step.env` (script steps do not evaluate pre/end
conditions; `conditionMaps` is already empty for them). The explicit
`isScriptStep(step) ? workflow.mcpServers/hooks` branches are the bug, not an
intentional inheritance. Prompt steps keep their current behavior unchanged.
