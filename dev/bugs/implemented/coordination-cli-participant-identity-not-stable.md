# Skill/CLI coordination calls mint a new participant on every invocation

- **Found:** 2026-09-26 by step 0 (claude-cli) of the coordination test workflow, reproduced live
- **Area:** `src/mcp-server.ts` (`getCoordinationState`), `src/core/orchestration/ExecutionRootCoordination.ts`
- **Resolution:** fixed in this commit

## Symptom

With `mcpAvailability: "disabled"`, every coordination tool call made through the
`ctrlyoke-coordination-tools` skill (`node mcp-server.js --tool <name> … --execution-root … --step-index … --parallel-group-id …`)
registers a **new** participant with a fresh `participantId`. As a result:

1. **`release_paths` never releases your own claims.** A claim made in one call belongs to
   that call's participant. The next call is a different participant, so
   `release_paths { paths: [...] }` returns `released: []` and `notHeld: [...]` for a path the
   same step claimed seconds earlier. Omitting `paths` ("release all mine") releases nothing.
2. **Claims stay held for the full CLI TTL.** A skill-mode claim can only disappear through
   `coordination.cliParticipantTtlMinutes` (30 min by default). Decision 4's documented step
   boundary default (`release_paths` with no args) does nothing in skill mode.
3. **The scope snapshot lists one participant per call.** In the live test, three parallel
   steps showed up as 10+ participants within two minutes, several with the same label
   (`<workflowKey>:1` five times). Agents can't tell who is really present.
4. **A step can be denied its own path.** Re-claiming a path your step already claimed is
   denied with your own label as the owner. The plan's "re-claiming a path it already owns
   succeeds (idempotent)" edge case holds only for MCP-delivered participants.
5. The board grows by a `join` entry for every call, and none of these joins is ever
   matched by a `leave`. That wears down the Decision 10 caps faster than necessary.

## Repro

In any execution root, with a live run and a parallel group:

```sh
node out/mcp-server.js --tool claim_paths   --args '{"paths":["a.md"]}' --workspace <ws> --working-file <wf> --execution-root <root> --step-index 0 --parallel-group-id <gid>
node out/mcp-server.js --tool release_paths --args '{"paths":["a.md"]}' --workspace <ws> --working-file <wf> --execution-root <root> --step-index 0 --parallel-group-id <gid>
# → {"released":[],"notHeld":["a.md"], ...}; the claim is still listed in scope.claimSummary
```

## Root cause

`CtrlYokeMCPServer.getCoordinationState()` (`src/mcp-server.ts:673-721`) caches the
registered lease in `this.coordinationState`, which lives for as long as the process does.
That is correct for the stdio MCP server. In CLI mode each tool call is a fresh `node`
process, so the cache is always empty and `registry.registerParticipant()` always runs.
`CoordinationParticipantRegistry.register()` (`ExecutionRootCoordination.ts:534-570`)
unconditionally calls `generateOwnerToken()` for a new `participantId`.

The unit tests miss it because `McpServer.test.ts` drives several `invokeTool` calls against
**one** server instance, so the in-memory cache hides the per-process behaviour.

## Suggested fix

For `via: "cli"` registrations with an address, **find before registering**. Inside the
board transaction, fold the live participants and reuse (refresh) the one whose
`via === cli`, `kind === ctrlyoke-step`, and whose `address.workflowKey`, `runRef`,
`stepIndex` and `parallelGroupId` all match. Register a new participant only when none is
live. The address is already validated against the live run
(`resolveCoordinationContext`), so this adds no new trust. Do the lookup and the append in
one `store.transaction` so that two concurrent CLI calls from the same step can't both
register.

Tests: a regression test that builds a **new `CtrlYokeMCPServer` per call** in CLI mode.
It should cover claim → release (released, not `notHeld`), re-claim idempotence, and
participant count staying at 1.

External CLI callers with no run address have no stable key. They can keep one-per-call
until an explicit participant token exists, but say so in the skill prose.
