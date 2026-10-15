# Coordination board is rewritten in place non-atomically; a torn write makes the board permanently unreadable

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/ExecutionRootCoordinationStore.ts`
- **Resolution:** fixed in this commit

## Decision

A malformed final JSONL record is treated as an interrupted append and skipped. A malformed record before the tail makes sequence continuity untrustworthy, so the whole board is moved aside and rebuilt from fresh writes.

## Symptom

If a board rewrite is interrupted, the coordination board for that execution root ends up in one of two states:

- **Empty.** Every claim and participant entry is gone, with no error.
- **Partial or NUL-padded last line.** Every later coordination operation fails with a JSON `SyntaxError` (`Unexpected end of JSON input`). This covers register, heartbeat, claim, release, posting and reading notes, and the dashboard coordination snapshot (`readCoordinationScopeSnapshot`).

The board stays broken until someone deletes `board.jsonl` by hand from the coordination storage root (`.git/ctrlyoke/coordination/<hash>/`).

## Steps to Reproduce

1. Have two or more participants coordinate on one execution root so that `board.jsonl` holds claims and notes.
2. Interrupt a process during a coordination append that rewrites the board (claim, release, note, or heartbeat refresh). Kill it after `fs.writeFile` truncates the file and before the write lands. To simulate this, write a partial last JSON line to `board.jsonl`.
3. Call any coordination operation (register, claim, read notes) or open the dashboard coordination view.
4. Observe one of two outcomes:
   - **Partial line:** `readEntries` throws `SyntaxError` on every call.
   - **Empty file:** all earlier claims are gone, so other agents can take paths that are still in use.

## Root Cause

Every `transaction.append` call rewrites the whole board: join/refresh, claim, release and note. At `src/core/orchestration/ExecutionRootCoordinationStore.ts:600-605` it does this in place with `fs.writeFile(scope.boardPath, ...)`. That call truncates the file before it writes, so for a short window the file is empty or only partly written. A process that dies in that window leaves the torn file behind. The process could be an MCP server killed when its agent session ends, or an extension host that crashes or runs out of memory.

The sibling persisted records do not have this problem, because they use `writeFileAtomic` (`src/utils/AtomicFileUtils.ts:160`):

- the scope record, at `ExecutionRootScope.ts:160`
- the lease, at `ExecutionRootLeaseManager.ts:284`

`readEntries` (`ExecutionRootCoordinationStore.ts:113-129`) calls `JSON.parse` on every non-blank line with no error handling (line 126). Both `transaction()` (line 517) and `read()` (line 630) depend on it. As a result, one corrupt line blocks every later operation on that board.

## Suggested Fix

- **Make the write atomic.** At `ExecutionRootCoordinationStore.ts:600`, replace `fs.writeFile` with `writeFileAtomic`. It writes to a temp file and then renames it, so readers see either the old board or the new one, never a partial one.
- **Defense in depth.** Have `readEntries` skip a single unparseable trailing line and log a warning through `Log`. As an alternative, move a corrupt board aside to `board.jsonl.corrupt-<ts>` and start fresh, instead of throwing on every call.
- **Test.** Add a test that seeds a board with a truncated final line and asserts that `read()` and `append()` both recover.
