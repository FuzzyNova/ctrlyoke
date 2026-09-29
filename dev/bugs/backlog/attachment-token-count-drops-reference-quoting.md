# The editor's attachment token counter drops quotes, so quoted references count 0 or the wrong file

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude, helper agent)
- **Area:** `src/ui/webview-react/hooks/useAttachmentTokenCount.ts` (`extractRawReferences` ~L85-105)
- **Severity:** low

## Symptom

The prompt editor's attachment token estimate is wrong for quoted references (paths with
spaces):

- `@"docs/my notes.md"` is counted as `docs/my`, which is the wrong file or nothing.
- `#selection:"src/my file.ts":1-5` and `#sym.class:"src/a b.ts":Foo:3-9` are counted as 0 tokens.

## Steps to Reproduce

Verified with tsx probes: `extractRawReferences` rebuilds `@${ref.path}`,
`#selection:${ref.path}:…` and `#sym:${ref.path}:…` without quotes. When the extension-host
counter (`PromptEditorSupportService` → `ContextExpander.estimateFileReferenceTokens`) re-parses
those strings with the same parsers, `@docs/my notes.md` parses as `docs/my`, and the
selection/symbol forms don't parse at all.

## Root Cause

The rebuilt reference strings lose the quoting the parsers need for paths with whitespace. The
`#sym` rebuild also drops any `.kind` qualifier.

## Suggested Fix

Send the original token text (`promptText.slice(ref.startOffset, ref.endOffset)`, or the
parser's `raw` field if there is one), or rebuild with `quoteReferenceField` as
`ContextExpander.ts` does. Add a hook test for quoted `@`, `#selection` and `#sym` references.
