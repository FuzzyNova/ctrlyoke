# Script verdicts still tell CLI users "no `returns` set", and dashboard find searches text that isn't shown

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/cli/CliTerminalFormatter.ts`, `src/ui/webview-react/utils/outputFind.ts`, `src/ui/webview-react/components/output/ScriptVerdict.tsx`
- **Severity:** low

## Symptom

`returns` was removed from the workflow schema and renamed to `expected`. The schema now rejects
it (`"returns": { "not": {} }`, "Removed — renamed to `expected`"). Still:

- Every CLI script verdict without an `expected` value prints
  `Expected: exit code 0 (no \`returns\` set)`, pointing users at a field the validator rejects.
- The dashboard renders `exit code 0 (no \`expected\` set)` (`ScriptVerdict.tsx`, line 33), but
  output find (`outputFind.ts`, line 181) indexes its own copy of the text, which says
  `returns`. Searching the output for `returns` highlights a match in a verdict that doesn't
  contain the word, and searching for `no \`expected\` set` finds nothing.

## Steps to Reproduce

1. Create a workflow with a single step `{type: script, script: "node -e \"console.log(1)\""}`.
2. `node out/cli.js run wf.ctrlyoke.yaml --headless`
3. The verdict block prints `Expected: exit code 0 (no \`returns\` set)`.

## Root Cause

The fallback text is hard-coded three times. The rename updated `ScriptVerdict.tsx` but missed
`CliTerminalFormatter.ts` (line 725) and `outputFind.ts` (line 181).

## Suggested Fix

Single-source the fallback text in a shared constant or helper (for example next to the verdict
types in `src/types/`) that names `expected`, and use it from all three sites so the CLI, the
rendered dashboard verdict and output find cannot drift again. Update any tests that pin the old
string, and add a find test asserting the searchable text matches what `ScriptVerdict` renders.
