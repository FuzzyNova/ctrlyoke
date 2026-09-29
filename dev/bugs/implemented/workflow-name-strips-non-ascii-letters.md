# Workflow names derived from a prompt drop or mangle non-ASCII letters

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/workflowNaming.ts`
- **Resolution:** fixed in this commit

## Symptom

A dashboard prompt run without an explicit name is named after its first five words. Each word is
trimmed of leading and trailing characters outside `[a-zA-Z0-9]`, so accented or non-Latin letters
at the start or end of a word are removed:

| Prompt                | Derived name         |
| --------------------- | -------------------- |
| `Écrire un résumé`    | `crire un résum`     |
| `Überprüfe die Tests` | `berprüfe die Tests` |
| `naïve café test`     | `naïve caf test`     |
| `修复登录错误`        | `Ephemeral Prompt`   |

The backend uses this name for the workflow (`WorkflowInstance.ts` around line 3452), and the
webview uses it for the "Run in New Workflow" toast (`PromptEditor.tsx` around line 1134).

## Steps to Reproduce

Call `generateWorkflowNameFromPrompt` with the prompts above (verified with a tsx script).

## Root Cause

`workflowNaming.ts` line 39: `word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")`.

## Suggested Fix

Use a Unicode-aware class: `/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu`. The module is shared with the
webview, which targets modern browsers, so `\p{}` with the `u` flag is fine. Also check that
anything deriving a file or directory slug from this name still produces a valid path. Add unit
tests for the table above and keep the existing ASCII punctuation-trimming tests passing.
