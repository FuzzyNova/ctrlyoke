# Live participant refreshes exhaust coordination board capacity

- **Found:** 2026-09-27 by step 2 (Codex) of the coordination test workflow
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts`, `src/core/orchestration/ExecutionRootCoordinationStore.ts`
- **Severity:** high

## Symptom

Each coordination call by a live participant appends another `join` entry to refresh its lease. These entries remain on the board until that participant explicitly leaves. A long-running session can therefore fill `coordination.maxEntries` (default 1,000) by itself. Further calls fail with `Coordination board capacity exceeded: cannot append without dropping an unresolved claim`, even when the board has no claims. Removing notes cannot restore capacity when the board consists of joins.

This is distinct from dead participants whose final join is never followed by a leave: the participant in this case is still live and actively using the tools.

## Steps to Reproduce

1. Create an `ExecutionRootCoordinationStore` for a temporary execution root with `retention: { maxEntries: 3 }`.
2. Append the same live participant's `join` entry three times, as `CoordinationParticipantRegistry.refresh()` does on repeated tool calls. Give the participant a future `leaseExpiresAt` and make no claims.
3. Append the same `join` entry a fourth time.
4. The fourth append throws the capacity error. The board contains three `join` entries from the same participant and zero claims. This was reproduced against `out/core/orchestration/ExecutionRootCoordinationStore.js` on 2026-09-27.

## Root Cause

`CoordinationParticipantRegistry.refresh()` appends a full `join` entry on every call (`ExecutionRootCoordination.ts`, around line 778). `compactDepartedParticipants()` in `ExecutionRootCoordinationStore.ts` only removes a participant's accumulated joins after a `leave`; it retains every join for a live participant. `trimNotesToCaps()` can evict only notes, so repeated refreshes eventually make a live participant's board unwritable.

## Suggested Fix

During compaction, retain only the newest `join` entry for each currently live participant, provided that this preserves claim ownership and lease state. The earlier joins are superseded by that newest entry; existing notes and claims already carry their own author metadata. Add a small-cap regression test that repeatedly refreshes one live participant without leaving and confirms that later coordination calls still succeed.
