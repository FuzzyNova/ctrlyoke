# Execution lease file written non-atomically; a torn/empty lease JSON wedges all acquisitions for the execution root

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/ExecutionRootLeaseManager.ts`
- **Resolution:** fixed in this commit

## Decision

Atomic replacement is safe because lease acquisition holds the per-execution-root arbitration lock, and each lease uses a generated owner token for its filename. This retains serialized conflict checks without exposing a partially written file.

## Symptom

Suppose ctrlyoke (CLI or extension host) is killed while it is creating an execution lease, or it hits a disk-full or I/O error at that point. After that, every workflow start against that execution root fails with a JSON `SyntaxError` (for example `Unexpected end of JSON input`) thrown from `readLiveLeases`. Stale-lease reaping never runs for the bad file, so the failure lasts until someone deletes the empty or torn `<token>.json` under `execution-leases/leases/` by hand. This is the "wedged lease" failure the module is meant to prevent.

## Steps to Reproduce

1. Resolve the lease scope with `ExecutionRootLeaseManager.getScopeInfo(root)`. Run one acquire/release so the scope record and the leases directory exist.
2. Simulate a crash between open and write: create `<scope.leasesRoot>/deadbeef.json` as an empty file, or with truncated JSON such as `{"ownerToken":`.
3. Call `ExecutionRootLeaseManager.acquireLease({ mode: "shared-native", executionRoot: root, ... })`, or start any workflow on that root, which goes through `src/core/WorkflowInstance.ts:2090`.
4. The call rejects with a `SyntaxError` from `JSON.parse` in `readJson` (line 118), reached through `readLiveLeases` (line 160). The file is not reaped, and every later attempt fails the same way.
5. For comparison, `ExecutionRootLeaseManager.inspectLeases(root)` silently skips the same file.

## Root Cause

- `acquireLease` creates the lease file in place (`ExecutionRootLeaseManager.ts:264-266`): `fs.open(leasePath, "wx")` followed by `handle.writeFile(...)`. Readers can see the file before its content is complete. A crash, kill, or failed write in that window leaves an empty or partial file.
- `readJson` (lines 116-123) treats only `ENOENT` as "absent" and rethrows parse errors.
- `readLiveLeases` (lines 154-171) calls `readJson` at line 160 without a try/catch. A malformed lease therefore aborts the whole acquisition at line 247, inside the arbitration lock, before the `isOwnerStale` reaping at line 162 can delete the file.
- `inspectLeases` (lines 326-333) already catches this case ("A malformed or disappearing lease cannot prove a live owner"), but the acquire path does not. The two readers are inconsistent.

## Suggested Fix

1. **Write the lease atomically.** Write the JSON to a temp file in the same directory and rename it into place, or reuse `writeFileAtomic` as `updateHeartbeat` already does (line 284). Exclusivity is already guaranteed by the arbitration lock and the random owner token, so `"wx"` is not needed.
2. **Make `readLiveLeases` tolerate unreadable or malformed lease files**, the same way `inspectLeases` does. Catch the parse error and unlink the file, since a lease that cannot be parsed cannot prove a live owner. Optionally, delete such a file only once its mtime is older than the heartbeat staleness window. Better still, share one tolerant lease reader between `readLiveLeases` and `inspectLeases`.
3. Add a unit test in `src/test/unit/ExecutionRootLeaseManager.test.ts`. It should place an empty `<token>.json` in `leasesRoot`, then check that `acquireLease` succeeds and the file is removed.
