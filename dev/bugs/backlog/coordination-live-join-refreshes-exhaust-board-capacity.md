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

## Planning Notes (orchestrator review, 2026-09-27)

Naively keeping only the newest `join` per live participant is **unsafe** with
the current fold, and code reading suggests a related latent bug:

- `foldCoordinationEntries()` (`ExecutionRootCoordination.ts:341`) evaluates
  liveness separately at **every** `join` against the current `now`, and processes
  a `claim` only if the participant's record is live *at that point in the
  sequence*. `claimPaths()` always refreshes (appends a `join`) right before its
  `claim`, so each claim is governed by the join just before it.
- **Latent bug (to be verified with a failing test first):** for a CLI-delivered
  participant (lease-based liveness), once the lease on the join before a claim
  expires, the fold marks the record non-live there and skips the claim, even
  though a later `join` renewed the lease. Example: join1 (t=20, expires 50),
  claim (t=20), join2 (t=45, expires 75). Folding at t=55 drops the claim.
- If compaction dropped every join except the newest, a claim that came before
  that newest join would have no record when the fold reached it, and would be
  silently dropped. The retention invariant check would then throw.

Recommended design:

1. Make the fold decide liveness per **lifecycle** (the joins since the
   participant's last `leave`) from that lifecycle's **latest** join. Earlier
   joins in the lifecycle only mark where it starts. Claims and releases between
   them are evaluated against the lifecycle's liveness, not the join just before
   them.
2. Compaction keeps only the **first** join (lifecycle start marker, before any
   of the participant's claims) and the **last** join (current lease) of each
   open lifecycle, and drops the joins in between. That bounds a live
   participant to two joins, however often it refreshes.
