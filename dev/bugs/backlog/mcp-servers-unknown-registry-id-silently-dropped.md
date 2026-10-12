# An unknown registry ID in `mcpServers` is dropped without a step warning

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/mcp-servers.md`
- **Area:** `src/utils/McpServerNormalizer.ts`
- **Severity:** low

## Symptom

If a step's or workflow's `mcpServers` list names a registry ID that isn't in ctrlyoke's MCP
registry (a typo, or a server defined only on another machine), the step runs without that
server. The only trace is a `Log.warn` line in the session log. An unknown inline `/mcp:<id>`
reference in the prompt, by contrast, produces a `prompt.mcp.unknown` warning on the step. It
also stops the step when `execution.contextResolutionFailure` is `"fail"`. The two ways of
naming the same server fail differently, and the declarative form fails silently.

## Steps to Reproduce

1. Add `mcpServers: [githbu]` (misspelled) to a step and run it.
2. The step runs with no warning in the dashboard, and the harness has no GitHub tools.
3. Change the step to put `/mcp:githbu` in the prompt instead. The step shows an "MCP server
   "githbu" referenced by /mcp:githbu was not found" warning.

## Root Cause

`McpServerNormalizer` adds unresolved list entries to `unknownIds`
(`src/utils/McpServerNormalizer.ts:117-122`) and only logs them (`:142-146`). Unresolved
`/mcp:` tokens, by contrast, push `createUnknownReferenceDiagnostic` into `diagnostics`
(`:131-136`, `:179-195`), and `WorkflowExecutor.assertContextResolutionDiagnosticsAllowed` acts
on those diagnostics. The test `"drops unknown IDs without throwing"`
(`src/test/unit/McpServerNormalizer.test.ts:204`) checks for no throw. It doesn't check
whether the user is told.

## Suggested Fix

Emit a diagnostic for each unknown list ID as well, reusing `createUnknownReferenceDiagnostic`
with a message that names the `mcpServers` entry instead of `/mcp:`. Use the same
`UNKNOWN_MCP_REFERENCE` code, so `contextResolutionFailure` governs both cases the same way. Keep
dropping the ID in warn mode. Extend the normalizer test to assert the diagnostic.
