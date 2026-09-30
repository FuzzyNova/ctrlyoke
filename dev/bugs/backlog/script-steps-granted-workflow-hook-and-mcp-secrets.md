# Script steps are granted workflow-level hook and MCP secrets even with `secrets: []`/`null`

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code, reproduced with the compiled `SecretResolver`
- **Area:** `src/utils/SecretResolver.ts` (`getProcessMaps` ~302-313, `getDeclaredSecretGrants`), `src/core/WorkflowExecutor.ts` (~2600, `buildSecretProcessEnvironment`)
- **Severity:** low (confidence: medium; may be intended; needs a design decision)

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

## Suggested Fix

For script steps, collect only the step's own `env` (and its pre/end-condition env).
Confirm first that no documented behavior relies on scripts receiving these; the secrets
plan does not mention it either way.
