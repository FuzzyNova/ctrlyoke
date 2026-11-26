# Edit diffs built from old/new snippets show the unchanged last line as removed and re-added

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/DiffLines.ts`, `src/ui/webview-react/utils/rdvAdapter.ts`
- **Resolution:** fixed in this commit

## Symptom

When a `FILE_EDIT` event has `oldContent`/`newContent` but no `structuredPatch`,
the CLI terminal, the dashboard's `TextDiffView` and Markdown export diff the two
strings directly. Those fields are usually tool snippets (`old_str`/`new_str`,
`oldString`/`newString`, `TargetContent`) that do not end in `\n`. jsdiff treats
`"foo"` (last line without a newline) and `"foo\n"` as different lines, so the
common "repeat the anchor line, then add lines" edit renders the unchanged
anchor as a deletion plus an identical addition:

```
- foo
+ foo
+ bar
```

instead of ` foo` / `+ bar`. The +/- counts are each off by one, and the
dashboard additionally shows two `\ No newline at end of file` markers for a
snippet that has no end-of-file semantics. Edits that change a line in the
middle of the snippet render correctly.

This path is taken whenever `structuredPatch` is missing: in-progress or failed
edits on every harness, Claude MultiEdit fan-out (`ClaudeToolBuilder.ts:99`),
Copilot edits without `detailedContent` (`CopilotToolBuilder.ts:423-432`), and
Antigravity/OpenCode results with no parseable diff.

## Steps to Reproduce

1. `node -e 'console.log(require("./out/utils/DiffLines.js").generateDiffLines("foo", "foo\nbar"))'`
2. Observed: `removed 1 "foo"`, `added 1 "foo"`, `added 2 "bar"`.
3. Expected: `context "foo"`, `added "bar"`.

The dashboard side does the same: `DiffLib.createPatch("file", "foo", "foo\nbar")`
yields `-foo`, `\ No newline at end of file`, `+foo`, `+bar`.

## Root Cause

- `src/utils/DiffLines.ts:129-138` (`generateDiffLines`) passes the strings to
  `Diff.diffLines` after only CRLF normalization. Used by
  `src/cli/CliTerminalFormatter.ts:263` and
  `src/ui/webview-react/utils/markdownExport.ts:156`.
- `src/ui/webview-react/utils/rdvAdapter.ts:394-411` (`toRdvFromContent`) does
  the same before `DiffLib.createPatch`. Used by `TextDiffView.tsx:357`,
  `outputRenderUtils.ts:324` and `heightEstimators.ts:412` (which must keep
  matching `TextDiffView`'s rendered height).

## Suggested Fix

Add one shared helper in `src/utils/DiffLines.ts` (the webview already imports
from it via `@root/utils/DiffLines`), e.g. `normalizeDiffInputs(old, next)`, that
normalizes CRLF and appends `"\n"` to each non-empty side that does not already
end with one. Call it from both `generateDiffLines` and `toRdvFromContent`, so
the CLI, Markdown export, `TextDiffView` and the height estimator stay in step.
(This intentionally stops showing a lone trailing-newline change as a diff;
snippets carry no end-of-file meaning, and whole-file diffs normally arrive as a
`structuredPatch`.)

Tests: `generateDiffLines("foo", "foo\nbar")` gives context + added in
`src/test/unit/` (find the existing DiffLines test), and `toRdvFromContent("foo",
"foo\nbar")` yields one insert change and no "No newline" marker in
`src/ui/webview-react/test/`.
