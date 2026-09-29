# YAML workflow completions break inside multi-line `prompt:` blocks

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/completions/PromptCompletionProvider.ts` (`isInsideYamlPromptValue`, around lines 295-360), `src/completions/PromptPropertyCompletionProvider.ts` (around lines 292-298 and 360-376)
- **Severity:** medium

## Symptom

Three related defects in YAML `.ctrlyoke.yaml` editing:

1. **Reference completions vanish after any `Word:` prose line.** In a `prompt: |` block, a line
   like `Task: review` or `Note: …` at the content indent makes `isInsideYamlPromptValue` return
   `false` for every later line. `@ # ~ $ !` completions then stop working for the rest of the
   prompt. Repro: `steps:\n  - prompt: |\n      Task: review\n      @` with the cursor after `@`
   gives `false`. Without the `Task:` line it gives `true`.
2. **No reference completions in `|-`, `>-`, `|+` or `|2` block scalars.** Only an exact `|` or `>`
   counts as a block scalar, so `prompt: |-` falls into the "inline text" branch, which only
   accepts the key's own line. Repro: `steps:\n  - prompt: |-\n      Review this\n      @` gives
   `false`.
3. **Step property keys are offered inside prompt text.** In
   `steps:\n  - prompt: |\n      Summarize the diff and\n      mo`, the property completion provider
   offers `model`. Accepting it inserts `model: ` into the prompt body. The key-position check never
   asks whether the cursor is inside a block scalar.

All three were reproduced by an agent against the real providers with a stub `vscode` module.

## Root Cause

- (1) The backward scan stops at any line matching `^\s*-?\s*\w+:` whose indent is at most the
  **cursor's** indent. Block-scalar content lines sit at exactly that indent.
- (2) `afterColon === "|" || afterColon === ">"` misses YAML's chomping and indentation indicators.
- (3) `PromptPropertyCompletionProvider` treats any `^\s*\w*$` line as a key position once it finds
  the enclosing step item.

## Suggested Fix

Single-source one "is this position inside a block-scalar value of key K" helper and use it in both
providers:

- Recognize block-scalar headers with `/^[|>][+-]?\d*[+-]?\s*(#.*)?$/`.
- A line belongs to the block if it's blank or indented deeper than the owning key. Only a
  non-blank line at or above the key's own indent ends the block. Prose lines containing `:` must
  not end it.
- The property provider must return no key completions inside a block scalar.

Add unit tests for the three repros above, plus the existing positive and negative cases.
