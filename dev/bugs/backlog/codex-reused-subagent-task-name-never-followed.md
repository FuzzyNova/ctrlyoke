# Codex subagent output is lost when a later session reuses a task name

- **Found:** 2026-11-01 by Claude Code (bug-hunt final step, reviewing `82beddf02`)
- **Area:** `src/core/harness/codex/CodexLogParser.ts` (`registerCodexSubagent`)
- **Severity:** medium

## Symptom

A Codex step spawns a subagent with `task_name: "worker"`, and ctrlyoke follows that child
rollout: the child's output appears under the spawn card, its usage is counted, and the card
is marked Completed. Any **later** Codex session in the same extension host (a later step,
another workflow, a resumed turn) that spawns a subagent with the same task name gets none of
that: no child rows, no child usage, and a spawn card that never completes. Models reuse
names such as `worker` and `explorer` all the time, so after the first run most Codex
subagent output goes missing until VS Code is reloaded.

`82beddf02` made the headless live tail register spawns while streaming, which sends more
runs through this path.

## Steps to Reproduce

1. `npm run compile:extension`.
2. In a scratch script, point `CODEX_HOME` at a temp directory and create two parent sessions
   (`session-A`, `session-B`). Give each one a child rollout whose `session_meta` has
   `parent_thread_id: <parent>` and `agent_path: "/root/worker"`, plus one assistant
   `output_text` row.
3. Using **one** `CodexLogParser` instance from `out/core/harness/codex/CodexLogParser.js`,
   run `extractResponse()` on each parent's events (a `session_meta` followed by a
   `spawn_agent` call with `task_name: "worker"`) and then `drainToEof(500)`.
4. Observed:
   ```
   session-A child events: 1 [ '{"text":"child work session-A"}' ]
   session-B child events: 0 []
   ```

## Root Cause

`registeredSubagentTasks` (#selection:src/core/harness/codex/CodexLogParser.ts:182-184) is a
`Set` keyed on the bare task name and is never cleared. `registerCodexSubagent` returns early
when the name is already present (#selection:src/core/harness/codex/CodexLogParser.ts:1430-1437)
and adds the name at line 1607. The follower's own source key does include the thread
(`codex:${parentThreadId}:${taskName}`) and is reset after each headless drain, but this set
still blocks the name. One `CodexLogParser` lives as long as the orchestrator
(`IntegrationFactory.createCodexCli()` creates one `CodexCliProvider` and parser). For the
same reason, `subagentPathByTask` and `pendingSubagentSpawns` grow without bound.

## Suggested Fix

Key the guard by parent thread and task name (`${parentThreadId}:${taskName}`), the same
identity the follower uses. Clear `registeredSubagentTasks`, `subagentPathByTask` and
`pendingSubagentSpawns` when a new parent `session_meta` is recorded, or when the follower
resets after a drain, whichever matches the parser's lifecycle. Add a regression case next to
the "follows linked child rollouts" test in `src/test/suite/harness/LogParsers.test.ts`: a
second session on the same parser instance that reuses the task name.
