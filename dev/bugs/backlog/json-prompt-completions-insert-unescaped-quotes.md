# Reference completions inside a JSON `"prompt"` string insert unescaped `"` and corrupt the file

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/completions/PromptCompletionProvider.ts`, `src/completions/CompletionHelpers.ts` (`toVSCodeCompletionItem`)
- **Severity:** medium

## Symptom

In a `.ctrlyoke.json` workflow, completing `@` inside `"prompt": "review @|"`
and choosing `my dir/a.ts` produces `"prompt": "review @"my dir/a.ts""`,
which is invalid JSON. The same happens for `#selection:"docs/my notes.md":1-20`
and for `#sym` on Markdown headings, which usually contain spaces.

## Steps to Reproduce

1. Open a `.ctrlyoke.json` workflow.
2. Inside a `"prompt"` string, type `@` and pick a path containing a space.
3. The file no longer parses.

## Root Cause

`shouldProvideCompletions` enables `@`/`#`/`~` completions inside JSON prompt
strings (`isInsidePromptString`, ~lines 146-152), but the insert text comes
straight from `quoteReferencePath` / `quoteReferenceField`, which wrap spaced
or colon-containing names in raw `"` with no JSON escaping.

## Suggested Fix

When the document is JSON (the same condition that routes to
`isInsidePromptString`), JSON-escape the insert text (`"` → `\"`, `\` → `\\`)
in one shared place before building the completion item, rather than per
trigger handler. `@\"my dir/a.ts\"` parses back to the intended reference.
Add tests for `@`, `#selection` and `#sym` in a JSON document.
