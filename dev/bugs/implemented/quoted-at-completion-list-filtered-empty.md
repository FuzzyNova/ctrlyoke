# `@"` completions are filtered to an empty list by VS Code

- **Found:** 2026-10-15 by claude-cli bug-hunt final step. Confirmed 2026-10-16 in a live VS Code host by the developer.
- **Area:** `src/completions/PromptCompletionProvider.ts`, `src/completions/CompletionCore.ts`
- **Resolution:** fixed in this commit

## Symptom

Typing `@"manual-test/d` in a `.prompt.md` file shows "No suggestions." Typing
`@manual-test/d` in the same place lists the folder's matching entries. So the
bug affects every prompt file type in VS Code's own editor, not only JSON.

The dashboard's CodeMirror prompt editor
(`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`) is not
affected: typing `@"manual-test/` there lists the folder's entries. It filters
the list itself and doesn't use VS Code's fuzzy matcher.

JSON prompts have a second, separate problem. The typed text is
`@\"manual-test/`, which is not recognised as a quote opener, so the query
reaching `getFileCompletions` still has a leading `\"` and matches nothing.

## Steps to Reproduce

1. Open any `.prompt.md` (or `.ctrlyoke.yaml`) prompt in VS Code's editor.
2. Type `@"manual-test/d`, where `manual-test/` exists.
3. Expected: entries matching `d` inside `manual-test/`. Actual: "No suggestions."
4. Type `@manual-test/d` instead. The list appears.

## Root Cause

The provider is called and returns items. `isInsideQuotedPath`
(`PromptCompletionProvider.ts` around lines 125-131) lets the quoted query
through, and `getFileCompletions` strips the leading `"` before querying
(`CompletionCore.ts` around line 191). VS Code then hides every item:

- `calculateCompletionRange` starts the replace range right after `@`
  (`PromptCompletionProvider.ts` around line 369), so VS Code filters on
  `"manual-test/d`.
- Each item's `filterText` is `${basename} ${relativePath}`
  (`CompletionCore.ts` around line 274). It has no `"`, so VS Code's fuzzy
  matcher drops every item.

`completions.instructions.md` describes the same trap ("VS Code filters a list
on the text from the item's range start to the cursor"), already fixed for
`/skill:` and for JSON key/value items.

For JSON, `afterTrigger` is `\"manual-test/`. It doesn't start with `"`, and
`getFileCompletions` strips only a bare `"`, so the query keeps the `\`.

## Suggested Fix

1. When the query starts with `"`, prefix each item's `filterText` with `"`.
   Do this in the VS Code adapter (`getAtCompletions`/`toVSCodeCompletionItem`)
   so that CodeMirror, which already works, keeps its own filtering.
   Alternatively, start the replace range after the opening quote, but then the
   inserted text must not add a second quote.
2. In a JSON-escaped prompt (`escape` set), treat `\"` after `@` as the quote
   opener. Pass the unescaped query to `getFileCompletions`, and set
   `filterText` to the escaped typed form (`\"…`).
3. Tests: provider tests that check `filterText` starts with the typed prefix
   for `@"dir/` in markdown and `@\"dir/` in JSON. A direct provider call
   returns items even while VS Code hides them, so assert on `filterText`, not
   only on the item count.
