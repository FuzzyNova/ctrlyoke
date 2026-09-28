# The workflow schema rejects `mcpServers: [{ id: ctrlyoke, deniedTools: [...] }]`, the documented way to deny queue tools

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `schemas/workflow-schema.json` (`mcpServerEntry`, `mcpServerConfig`), `docs/workflows/dynamic-queue.md`, `docs/reference/mcp-tools.md`, `src/ui/webview-react/components/shared/McpServersEditor.tsx`
- **Resolution:** fixed in this commit

## Symptom

The documented recipe for giving members read-only queue access fails validation:

```yaml
mcpServers:
  - id: ctrlyoke
    deniedTools: [append_step, edit_step, remove_step, reorder_steps]
```

Putting that in a minimal workflow, at workflow level or step level, and running
`node out/cli.js validate <file>` exits 2 with
`/mcpServers/0: must have required property 'command' … 'url' … must match exactly one schema in oneOf`.

The runtime expects this shape: `resolveCtrlYokeDenials` (`src/types/ExecutionPropertyResolver.ts:~102-114`)
matches `server.id === "ctrlyoke"` and reads `deniedTools`, and several unit tests use it. The
dashboard's MCP editor (`McpServersEditor.tsx:~188`, `buildArray`) writes exactly this object when a
user unchecks a ctrlyoke tool. That dashboard effect was inferred from the code, not reproduced in
the UI.

## Steps to Reproduce

1. Create a workflow with the snippet above and one step.
2. Run `ctrlyoke validate <file>`. It exits 2 with the oneOf error.

## Root Cause

`mcpServerEntry` is `oneOf [string, mcpServerConfig]`, and `mcpServerConfig` requires exactly one
of `command`/`url`. The built-in ctrlyoke server has neither. The constraint arrived in `ff510898`
("tighten release readiness constraints") without an exemption for the built-in ID.

## Suggested Fix

Add a third `mcpServerEntry` branch for the built-in server, e.g.
`{ type: object, properties: { id: { const: "ctrlyoke" }, deniedTools: { type: array, items: string } }, required: [id], additionalProperties: false }`,
and make sure `mcpServerConfig` can't also match it (so the oneOf stays unambiguous). Put the
behaviour in the schema `description`, then run `npm run generate-schema-docs` and
`npm run generate-schema`. Add a parser test that the documented snippet validates at workflow and
step level, and a round-trip test for the dashboard editor's output.
