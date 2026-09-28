# Concurrent trust-decision writes share one `.tmp` path, losing a decision and corrupting the file

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/config/TrustDecisionFile.ts`
- **Severity:** medium

## Symptom

Two overlapping `setDecisions` calls on the same trust store lose one decision, and can leave
invalid JSON behind:

- `Promise.allSettled([store.setDecisions("ws", ["C:/r1"], "allow"), store.setDecisions("wf", ["C:/r2"], "deny")])`
  gives `['fulfilled', 'rejected ENOENT']`.
- The file ends up as `{"decisions":{"wf␟c:\\r2":"deny"},"schemaVersion":1}}`, with an extra
  trailing `}`.

The corrupt file then triggers `trust-decision-file-unparseable-overwritten.md` on the next write.

These writes are reachable at the same time: per-workflow `ExternalFileTrustPrompt` flows, the
settings drawer (`WebviewSettingsSync`), and the CLI `trust-*` commands running while the
extension is also writing.

## Steps to Reproduce

Run the `Promise.allSettled` call above against a store pointing at a temp file, then read the
file.

## Root Cause

`saveTrustDecisionFile` (around lines 52-70) always writes to the fixed path `${storePath}.tmp`
and renames it. Nothing serializes the load-modify-save sequence in `setDecisions`, so two writers
interleave on the same tmp file, and one rename finds it already moved.

## Suggested Fix

Use a unique tmp name (pid plus random suffix). Serialize `setDecisions` through a per-store
in-process write queue that re-loads inside the queued step, as `FileConfigBackend.writeQueue`
does. Share that queue helper instead of copying it. Add a concurrency test asserting both
decisions survive and the file parses.
