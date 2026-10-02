# Copying and pasting a step drops `description` from its inline MCP servers

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli subagent), reproduced with `parseClipboardWorkflowStep(serializeWorkflowStepForClipboard(...))`
- **Area:** `src/core/WorkflowStepSanitizer.ts` (`cloneMcpServerConfig`, ~181-210)
- **Severity:** low

## Symptom

Copy a step whose `mcpServers` contains an inline server with a `description`,
then paste it. The pasted step's server has no `description`. Every other
`McpServerConfig` field (`command`, `args`, `env`, `autoApprove`, `url`,
`transport`, `headers`, `deniedTools`) round-trips.

## Steps to Reproduce

`parseClipboardWorkflowStep(serializeWorkflowStepForClipboard({ prompt: "x", mcpServers: [{ id: "gh", description: "GitHub issues", command: "npx", args: ["-y","gh-mcp"] }] }))`
returns `mcpServers: [{ id: "gh", command: "npx", args: [...] }]`.

## Root Cause

`cloneMcpServerConfig` copies an explicit field list that leaves out
`description`. That field is defined by `schemas/workflow-schema.json`
(`mcpServerConfig.description`) and the `McpServerConfig` type.

## Suggested Fix

Add `...(typeof value.description === "string" && { description: value.description })`
and extend the clipboard round-trip test.
