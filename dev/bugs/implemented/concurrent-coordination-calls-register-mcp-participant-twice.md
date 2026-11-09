# Concurrent coordination calls register the MCP server as two participants

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced against `out/mcp-server.js`)
- **Area:** `src/mcp-server.ts` (`getCoordinationState`, coordination tool dispatch)
- **Resolution:** fixed in this commit

## Symptom

When a harness issues two coordination tool calls in parallel at the start of a step (for
example `claim_paths` and `read_notes`), one MCP server process registers itself twice. The
two responses report different `scope.you` participant IDs. A claim granted under the first
identity can then never be released: a later `release_paths` on the same server returns
`released: []`, `notHeld: [...]`, while the claim summary still shows the path held by the
orphaned identity. Siblings stay denied that path until the step settles (attested) or the
process exits (external session), and the board shows a ghost participant that never reads
notes addressed to it.

## Steps to Reproduce

1. Create one `CtrlYokeMCPServer` with `CTRLYOKE_EXECUTION_ROOT` set to a temp directory.
2. Call `claim_paths {paths: ["src/a.ts"]}` and `read_notes {}` concurrently
   (`Promise.all`).
3. The two responses carry different `scope.you` values.
4. Call `release_paths {paths: ["src/a.ts"]}`: it reports the path as not held, and the
   claim remains on the board.
5. A second session's `read_notes` lists three participants (both identities of the first
   server, plus itself).

## Root Cause

- `getCoordinationState` (`src/mcp-server.ts` ~912-960) checks the cached
  `this.coordinationState`, then awaits `registry.fold()`, `resolveExecutionRoot()`, the
  registration and `resolveCoordinationBoardScope` before assigning the cache. Nothing
  records a registration already in flight, so two concurrent callers both register.
- `read_notes` is dispatched directly (`src/mcp-server.ts` ~698-699) while `post_note`,
  `claim_paths` and `release_paths` go through `queueOperation`, so `read_notes` can run
  alongside any of them.
- `ExecutionRootCoordination.register()` (`src/core/orchestration/ExecutionRootCoordination.ts`
  ~807-855) mints a fresh owner token for every `via: mcp` registration; only CLI callers are
  de-duplicated, so the second registration is a second live participant.

The same race recurs after the orchestrator closes the cached lease (the
`this.coordinationState = undefined` path) if two calls then arrive together.

## Suggested Fix

Memoize the in-flight registration: keep a `coordinationStatePromise` that concurrent
callers await, cleared when registration fails or when the cached lease is found no longer
live (re-registration must also be single-flight). Optionally also route `read_notes`
through `queueOperation`, but the promise cache is the robust fix because it covers any
future unqueued coordination tool. Add a `McpServer.test.ts` case that issues `claim_paths`
and `read_notes` together, asserts both report the same `you`, that only one participant is
registered, and that `release_paths` then releases the claim.
