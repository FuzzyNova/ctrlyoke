# Coordination tools called from the final step in skill mode always fail with "does not resolve to a live step"

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reproduced against compiled `out/mcp-server.js`
- **Area:** `src/mcp-server.ts` (`resolveCallingContext`, CLI-mode live-step check)
- **Resolution:** fixed in this commit

## Symptom

With `execution.ctrlyokeMcpMode: "skill"`, a workflow's `finalStep` that attaches the ctrlyoke
server gets the `ctrlyoke-coordination-tools` skill
(`src/types/ExecutionPropertyResolver.ts`, around lines 456–474). Every documented coordination
command it runs (`post_note`, `read_notes`, `claim_paths`, `release_paths`) exits 1 with:

```
CLI coordination address does not resolve to a live step: <run file>
```

The workflow tools (`workflow_status`, `append_step`, …) still work from the final step, because
only coordination tools go through this check. The error gives the agent nothing to act on, and
the skill tells it to keep the generated arguments exactly as given.

## Steps to Reproduce

1. Create a live run whose runner lock is held, with `_runtime.executionState` active,
   `_runtime.currentIndex === steps.length` and `_runtime.finalStep.phase === "finalStep"`.
   That is the state the executor leaves while the final step runs: `PromptQueue` has advanced
   past every queue step. The existing `McpServer.test.ts` fixture "global_status reports the
   running final-step pass…" (around line 2000) uses exactly this shape.
2. Run `mcp-server.js --tool post_note --args '{"text":"hi"}' --workspace … --working-file <run file> --execution-root …`
   with `CTRLYOKE_MCP_CLI_MODE=true`, the way the coordination skill's generated command does.
3. It fails with the error above. The same call with `currentIndex: 1` (a queue step running)
   succeeds. A final step that runs first on an empty queue (`currentIndex 0`, zero steps) fails
   the same way.

## Root Cause

In CLI mode, `resolveCallingContext` in `src/mcp-server.ts` (around lines 814–827) refuses the
call unless `0 <= runtime.currentIndex < steps.length`. It never consults
`runtime.finalStep?.phase`, so a running final step can never pass. The skill command generated
for a final step (`src/utils/McpToolSkillGenerator.ts`, around lines 127–131) correctly carries
no `--step-index` or `--parallel-group-id`, so this check is the only thing that blocks it.

## Suggested Fix

In the CLI-mode check, also accept an active run whose
`runtime.finalStep?.phase === FINAL_STEP_PHASES.FINAL_STEP`, with no step index and no group
attribution. Keep refusing everything else. Make sure the later step-index and group logic
doesn't attribute the call to a queue step: with `currentIndex === steps.length` there is no
current group, and no `--step-index` is accepted. Add `src/test/unit/McpServer.test.ts` cases
with `CTRLYOKE_MCP_CLI_MODE=true`:

- a running final step (`currentIndex === steps.length`, `finalStep.phase: finalStep`) can
  `post_note` and `claim_paths`;
- a run with the same `currentIndex` but no final-step phase (queue drained, settling) is still
  refused.
