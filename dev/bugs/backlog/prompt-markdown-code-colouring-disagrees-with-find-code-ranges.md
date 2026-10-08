# Prompt editor colours text as code that `findCodeRanges` treats as live

- **Found:** 2026-10-08 by Claude (claude-cli), Wave 3 review of M2 (`a1e420025`)
- **Area:** `src/ui/webview-react/utils/codemirrorLanguage.ts` (`createPromptMarkdownLanguage`), `src/utils/FileReferenceParser.ts` (`findCodeRanges`)
- **Severity:** medium

## Symptom

Since M2 the prompt editor colours code with Lezer's markdown parser, while ctrlyoke decides
what is literal with `findCodeRanges`. Where the two disagree, text looks like code (nested
language colours, or the inline-code colour) but its references stay live and expand at
runtime. That is the "looks like code but expands" mismatch plan M says must never happen
silently.

| Case                                   | Lezer                         | `findCodeRanges` |
| -------------------------------------- | ----------------------------- | ---------------- |
| Unclosed fence (` ```ts ` then text)   | code to the end of the prompt | none             |
| Fence indented 4 spaces in a list item | `FencedCode`                  | none             |
| `~~~` fence                            | `FencedCode`                  | none             |
| Closer with an info string (` ```js `) | the fence continues           | the fence ends   |
| Inline code spanning a line break      | `InlineCode`                  | none             |
| Fence inside a `>` blockquote          | `FencedCode`                  | none             |

Live references inside these regions still render as links and chips, which limits the harm.
The unclosed fence also shows up transiently whenever the user types ` ``` ` above existing
text.

## Steps to Reproduce

1. Run `CodeMirrorEditorMarkdown.test.tsx`. The parity corpus pins each case above as
   `agree: false`.
2. In the prompt editor, type `~~~` on one line, `@src/app.ts` on the next and `~~~` after
   it. The middle line is coloured as code, while the reference is still a live link and
   expands when the workflow runs.

## Root Cause

`findCodeRanges` implements a narrower subset of CommonMark: backtick fences only, at most
three spaces of indent, no container blocks, a closer must be bare, and an inline span ends
at a line break. Lezer implements the full spec.

## Suggested Fix

Pick one authority per case:

- **Align `findCodeRanges` with CommonMark** where the runtime should treat the text as
  literal (`~~~` fences, fences in list items and blockquotes, multi-line inline spans).
  This changes runtime expansion, so the CLI, VS Code and the dashboard all change at once.
  Pin it with `findCodeRanges` tests.
- **Mute Lezer's code colouring** for regions `findCodeRanges` does not mask (the unclosed
  fence above all, since it is transient while typing). That keeps the runtime unchanged
  and makes colour honest.

Then flip each corpus entry to `agree: true`, or to a documented intentional gap.
