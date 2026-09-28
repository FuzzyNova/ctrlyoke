# `~` git-change references match the start of longer words and numbers

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/FileReferenceParser.ts`, `src/completions/PromptLinkProvider.ts`, `src/ui/webview-react/utils/atomicReferences.ts`, `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`
- **Severity:** medium

## Symptom

`parseGitChangeReferences("these behave ~differently, about ~1500000 rows, ~staged_files")`
returns three references:

- `~diff` from `~differently`
- a commit `~1500000` from the approximate number
- `~staged` from `~staged_files`

At run time, `ContextExpander.expandGitChanges` then silently attaches the entire working-tree
diff or staged diff to the prompt, or runs `git show 1500000`. If no such commit exists and
`referenceResolution` is `fail`, the step fails on an "unresolved reference" the author never
wrote.

## Steps to Reproduce

`npx tsx -e "import('./src/utils/FileReferenceParser.ts').then(m => console.log(m.parseGitChangeReferences('about ~1500000 rows, ~differently')))"`

## Root Cause

The regex (around line 537) is `NOT_AFTER_BOUNDARY~(diff|staged|stash:(\d+)|([0-9a-f]{7,40}))`.
It guards the start of the token but not the end. The sibling parsers already guard both ends:
`$previously` does not match `$previous`, and `SecretReferenceParser` uses
`NOT_BEFORE_BOUNDARY`, which `ReferenceBoundary.ts` exports for this purpose. The editor
highlighting and link-provider patterns (`PromptLinkProvider.ts` around line 584,
`atomicReferences.ts` around line 815, `CodeMirrorEditor.tsx` around line 2375) have the same gap,
so the UI highlights `~diff` inside `~differently`.

## Suggested Fix

Append `NOT_BEFORE_BOUNDARY` to the runtime regex and to every highlighting and link pattern.
Ideally, build all of them from one shared pattern source so they can't drift. Add parser tests
for `~differently`, `~1500000x`, `~staged_files` and `~stash:1a`, plus positive cases followed
by punctuation (`~diff.`, `(~staged)`).
