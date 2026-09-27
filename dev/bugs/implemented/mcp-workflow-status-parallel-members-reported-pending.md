# MCP `workflow_status` reports running parallel-group members as pending

- **Found:** 2026-09-27 by step 0 (claude-cli) of the coordination test workflow
- **Area:** `src/mcp-server.ts` (`CtrlYokeMCPServer.getStepStatus`)
- **Resolution:** fixed in this commit

## Symptom

While a three-member parallel group (steps 0–2) was executing, `workflow_status`
called from step 0 returned:

```
index 0 → "running"
index 1 → "pending"   (antigravity-cli, actively running — posting to the board)
index 2 → "pending"   (codex-cli, actively running — posting to the board)
```

The run file showed all three with `_runtime.startedAt` set and no `completedAt`.
An agent using `workflow_status` to decide what siblings are doing — which the
tool description invites ("which is running now") — is told its siblings have
not started. Once step 0 finishes (`completedAt` set, `currentIndex` still pinned
at the group's start until the join), the tool reports step 0 `completed` and the
still-running members `pending`, i.e. nothing is shown as running at all.

It also reports a step that failed and stopped the workflow as `"completed"`,
because of the positional `index < currentIndex` fallback.

## Steps to Reproduce

1. Run a workflow whose first entry is a `parallel:` group of ≥2 members with the
   ctrlyoke MCP server attached.
2. From any member, call `workflow_status`.
3. Every member other than the group's `startIndex` reports `"pending"` while it
   is executing.

## Root Cause

`getStepStatus()` (`src/mcp-server.ts:2015`) derives status positionally:
`completedAt` → completed, `index === currentIndex` → running,
`index < currentIndex` → completed, else pending. During a parallel group
`currentIndex` stays pinned at the group's `startIndex` until the join, so every
later member falls through to pending.

This exact bug was already fixed for the dashboard:
`deriveStepStatusesFromRuntime` in `src/utils/StepStatusDerivation.ts:106`
documents both failure modes (the parallel-group pinning and the
terminal-failure-labelled-completed case) and uses `startedAt` plus
`terminalStatus` instead. The MCP server kept its own duplicate of the old
positional logic, and returns bare string literals (`"running"`, `"completed"`,
`"pending"`) rather than `STEP_STATUS` constants.

## Suggested Fix

Delete `getStepStatus` and have `workflow_status` call
`deriveStepStatusesFromRuntime(steps, runtime.currentIndex, runtime.executionState)`
once per response, so the MCP surface and the dashboard single-source their step
status. Add a `McpServer.test.ts` case with a group run file where members 1..n
have `startedAt` and no `completedAt`, asserting they report `running`, plus a
case asserting a `terminalStatus` failure is not reported as `completed`.
