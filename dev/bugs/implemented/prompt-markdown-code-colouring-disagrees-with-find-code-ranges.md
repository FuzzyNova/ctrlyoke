# Prompt editor colours text as code that `findCodeRanges` treats as live

- **Found:** 2026-10-08 by Claude (claude-cli), Wave 3 review of M2 (`a1e420025`)
- **Area:** `src/ui/webview-react/utils/codemirrorLanguage.ts` (`createPromptMarkdownLanguage`), `src/utils/FileReferenceParser.ts` (`findCodeRanges`)
- **Resolution:** fixed in this commit

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
   `agree: true` after the fix.
2. In the prompt editor, type `~~~` on one line, `@src/app.ts` on the next and `~~~` after
   it. The middle line is coloured as code, while the reference is still a live link and
   expands when the workflow runs.

## Root Cause

`findCodeRanges` implemented a narrower subset of CommonMark: backtick fences only, no
container blocks, and inline spans ended at a line break. Lezer used CommonMark semantics.

## Suggested Fix

Pick one authority per case:

- **Align `findCodeRanges` with CommonMark** where the runtime should treat the text as
  literal (`~~~` fences, fences in list items and blockquotes, multi-line inline spans).
  This changes runtime expansion, so the CLI, VS Code and the dashboard all change at once.
  Pin it with `findCodeRanges` tests.
- **Mute Lezer's code colouring** for regions `findCodeRanges` does not mask (the unclosed
  fence above all, since it is transient while typing). That keeps the runtime unchanged
  and makes colour honest.

The fix below records the chosen behavior for every case.

## Resolution

- **Tilde fences, list-item fences, blockquote fences, fences with an info string on a
  would-be closer, and inline spans across one line break:** `findCodeRanges` now follows
  CommonMark for these cases. Runtime expansion is suppressed inside them across the CLI,
  VS Code, and dashboard consumers.
- **Unclosed fence:** runtime behavior stays live so a transient opener cannot swallow the
  rest of a prompt. The prompt editor suppresses Lezer's nested code colours until a closing
  `CodeMark` appears.
- `src/test/unit/FileReferenceParser.test.ts` pins each runtime decision, including that an
  unclosed fence leaves references live. All parity corpus cases now agree with the editor's
  visible code ranges.
