# apply_patch parser treats `*** Update File:` text inside hunk lines as a new file header

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced by bundling the parser and running it on a sample patch
- **Area:** `src/core/harness/shared/ApplyPatchParser.ts` (`parseFileEdits` ~171, `extractFirstPath` ~253)
- **Resolution:** fixed in this commit

## Symptom

If a patched file's added, removed or context line contains `*** Add|Update|Delete File: <x>`,
the parser cuts the current file off at that line and creates phantom file edits whose
paths are garbage (e.g. `a.ts",`). Codex (`CodexToolBuilder`) and Copilot
(`CopilotToolBuilder`) turn every parsed edit into a dashboard file-edit event, so the
user sees fake file rows and a truncated diff. Tests in this repo, such as
`src/test/suite/harness/LogParsers.test.ts`, contain such lines.

## Steps to Reproduce

```
*** Begin Patch
*** Update File: src/test/foo.test.ts
@@
   const input = [
-    "*** Update File: a.ts",
+    "*** Update File: b.ts",
   ];
*** End Patch
```

`ApplyPatchParser.parseFileEdits` returns 3 edits (`src/test/foo.test.ts` with one line,
`a.ts",`, and `b.ts",`) instead of 1 edit with all four hunk lines.

## Root Cause

The file-header regex `/\*\*\* (?:Add|Update|Delete) File: (.+)/` isn't anchored, and it
is checked before the `+`/`-`/space hunk prefix. `*** Begin Patch`, `*** End Patch`
and `*** Move to:` are already matched with `startsWith`.

## Suggested Fix

Anchor the match to the line start (`/^\*\*\* (Add|Update|Delete) File: (.+)/`) and take
the kind from the capture group. In `extractFirstPath`, use the `m` flag with `^`.
Add a unit test with the patch above.
