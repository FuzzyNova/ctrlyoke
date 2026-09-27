# Stale join entries from unleft participants permanently wedge coordination board capacity

- **Found:** 2026-09-27 by step 1 (antigravity) of the coordination test workflow
- **Area:** `src/core/orchestration/ExecutionRootCoordinationStore.ts`
- **Resolution:** fixed in this commit

## Symptom

When participants terminate without explicitly appending a `leave` entry (e.g. external agent sessions like Claude Code or Codex that exit, killed processes, crashed workflow runs, or expired skill/CLI leases), their `join` lifecycle entries accumulate indefinitely on `board.jsonl`.

Once accumulated `join` entries reach the configured `coordination.maxEntries` ceiling (default 1,000), any subsequent write to the coordination board (joining, refreshing, posting notes, claiming, or releasing paths) throws:

```
Error: Coordination board capacity exceeded: cannot append without dropping an unresolved claim
```

The error message misattributes the failure to an "unresolved claim", and because `trimNotesToCaps` only considers `note` entries as removable, no entry can be evicted. The coordination board becomes permanently wedged for the execution root until someone manually deletes `board.jsonl`.

## Steps to Reproduce

1. Initialize a coordination store with a small `maxEntries` limit (e.g. 5) to observe the boundary:
   ```javascript
   const store = new ExecutionRootCoordinationStore(tmpDir, {
     retention: { maxEntries: 5 }
   });
   ```
2. Append 5 `join` entries from distinct external or unclosed participants:
   ```javascript
   for (let i = 0; i < 5; i++) {
     await store.append({
       kind: "join",
       from: { participantId: `ext-${i}`, label: `ext-${i}`, kind: "external", attested: false },
       via: "mcp"
     });
   }
   ```
3. Attempt to append any new note or join:
   ```javascript
   await store.append({
     kind: "note",
     from: { participantId: "ext-new", label: "ext-new", kind: "external", attested: false },
     via: "mcp",
     text: "hello"
   });
   ```
4. **Outcome:** Throws `Coordination board capacity exceeded: cannot append without dropping an unresolved claim`, even though 0 claims were ever made.

## Root Cause

In `ExecutionRootCoordinationStore.ts`:

1. `compactDepartedParticipants()` (lines 289–316) only marks `join` sequence numbers as settled when it encounters a corresponding `leave` entry for that `participantId`:
   ```typescript
   } else if (entry.kind === COORDINATION_ENTRY_KINDS.LEAVE) {
     for (const joinSequence of openJoins.get(participantId) ?? []) {
       settled.add(joinSequence);
     }
     openJoins.delete(participantId);
     settled.add(entry.seq);
   }
   ```
   External participants never emit `leave` entries when disconnected/exited; crashed processes never emit `leave`; and expired CLI participants never emit `leave`.

2. `removeOldNotes()` (lines 339–350) only filters out entries where `entry.kind === COORDINATION_ENTRY_KINDS.NOTE`. Lifecycle entries (`join`) are ignored regardless of age.

3. `trimNotesToCaps()` (lines 356–404) only evicts entries matching `entry.kind === COORDINATION_ENTRY_KINDS.NOTE`. When total entries exceed `settings.maxEntries` but all candidates are `join` entries, `candidates.length === 0` triggers the capacity error at line 376.

Although `EXECUTION_ROOT_COORDINATION_PLAN.md` (lines 704–716) documented that `join` entries must be compacted so that lifecycle entries do not grow without bound, the implementation assumes all departed participants have explicit `leave` entries.

## Suggested Fix

1. In `ExecutionRootCoordinationStore.ts`, provide `compactDepartedParticipants` with information about live participants or liveness evaluation (similar to `resolveClaims`), or have `ExecutionRootCoordinationStore` receive a resolver for dead participants:
   - When folding or compacting, query `foldCoordinationEntries()`: any participant determined to be dead (non-alive PID or expired CLI lease) with no active unresolved claims should have all their `join` entries settled and pruned during compaction.
2. In `removeOldNotes` (or a generalized `pruneExpiredEntries`):
   - Evict `join` entries that exceed `maxEntryAgeDays` if the participant has no active unresolved claims.
3. Update the error message in `trimNotesToCaps` to accurately differentiate between boards full of unresolved claims versus non-evictable entries.

## Planning Notes (orchestrator review, 2026-09-27)

- Sequenced **after** `coordination-live-join-refreshes-exhaust-board-capacity`.
  That fix makes the fold lifecycle-based (liveness from the latest join since
  the last `leave`) and compacts each open lifecycle down to its first and last
  join. Build on that; don't re-derive it.
- The store has no liveness knowledge. `CoordinationParticipantRegistry` (the
  only production constructor of `ExecutionRootCoordinationStore`) already
  injects an `unresolvedClaims` resolver backed by the fold. It should inject
  liveness the same way, e.g. a resolver returning the live participant IDs from
  `foldCoordinationEntries(...).participants`. Compaction then settles every
  lifecycle whose participant is not live and holds no unresolved claim, exactly
  as a `leave` would.
- Bare-store fallback (`appendCoordinationEntry()` and tests, with no resolver):
  age out a lifecycle's joins once its **latest** join is older than
  `maxEntryAgeDays` and the participant holds no unresolved claim. Never prune
  based on an earlier join's age.
- Error message: `trimNotesToCaps` should tell apart "unresolved claims fill the
  board" from "only non-evictable lifecycle entries remain".
