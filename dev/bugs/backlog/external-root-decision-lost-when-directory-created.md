# An external-root allow/deny decision is lost once the directory is created

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/config/ExternalRootsTrustStore.ts` (`canonicalizeRoot`)
- **Severity:** medium

## Symptom

A decision recorded for an external root that doesn't exist yet stops matching once the
directory is created. The root goes back to "pending": the VS Code prompt reappears, and
the CLI `run` gate blocks on it again. This fails closed, so it is not a bypass. The
same drift also turns a "deny" back into undecided.

Reproduced with the real store under `npx tsx`:

```ts
const store = new ExternalRootsTrustStore("C:/tmp/cyk-cfg/trust.json");
const root = "c:/tmp/cyk-cfg/later-logs";          // does not exist yet
await store.setDecisions("ws", [root], "allow");
store.getApprovedRoots("ws", [root]);               // [ 'c:/tmp/cyk-cfg/later-logs' ]
fs.mkdirSync("C:/tmp/cyk-cfg/later-logs");
store.getApprovedRoots("ws", [root]);               // []
store.getPendingRoots("ws", [root]);                // [ 'c:/tmp/cyk-cfg/later-logs' ]
// stored key: "ws␟c:\\tmp\\cyk-cfg\\later-logs"
```

## Steps to Reproduce

1. Configure an external root whose directory doesn't exist yet (the code comment's own
   example is "a log dir created on first harness run"), using a lowercase drive letter
   as VS Code-sourced paths do.
2. Approve it.
3. Create the directory, e.g. by running a harness. The root is pending again.

## Root Cause

`canonicalizeRoot` (`ExternalRootsTrustStore.ts:~49-56`) returns
`fs.realpathSync.native(resolved)` when the directory exists and `path.resolve(root)`
otherwise. `realpath` returns the on-disk casing (uppercase drive letter, real
component case), while `path.resolve` keeps whatever casing was passed in. The key is
then used for a case-sensitive object lookup, so the same root gets two different keys
before and after it exists. The docstring says canonicalization exists so "case
differences collapse to one identity", and the not-yet-existing case is explicitly
supported.

## Suggested Fix

Make the key stable across existence. On win32, fold the canonical form with the
existing case-folding helper (`foldPathForCompare` in `src/utils/PathCasing.ts`, or
whatever the path-comparison single source is) before building the key. Alternatively,
realpath the nearest existing ancestor and append the remaining segments, then fold.
Apply the same canonicalization on both write and lookup. Add tests: a decision stored
before `mkdir` is still approved after `mkdir`; a differently-cased spelling of the same
root on win32 matches; behaviour on case-sensitive platforms is unchanged.
