# Step-key completions are offered inside nested mappings, lists, and non-`prompt` block scalars

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); reproduced by running the provider against a stub `vscode`
- **Area:** `src/completions/PromptPropertyCompletionProvider.ts` (block-scalar guard ~289-312 only checks `prompt`; `findPromptStepBlock` ~361-458 matches the nearest `- ` line at any depth and ignores indentation)
- **Severity:** low

## Symptom

With the cursor at the end of each document:

- `steps:\n  - prompt: hi\n    skills:\n      - ` offers all prompt-step keys. The same
  happens in `mcpServers:` and `toolPermissions.allowedTools:` lists.
- `steps:\n  - prompt: hi\n    endCondition:\n      script: npm test\n      re` offers
  `resumeSession` inside the `endCondition` mapping.
- `steps:\n  - type: script\n    script: |\n      echo hi\n      ti` offers `timeoutSec`
  inside the script body. Typing `mo` inside an `endCondition.script: |` block
  offers `model`.

## Root Cause

The step detector treats any `- ` list item as a step, whatever its depth or
parent key. The block-scalar guard only recognizes `prompt: |`.

## Suggested Fix

Only offer step keys when the cursor's indent equals the step item's body indent
and the matched `- ` item sits directly under `steps:` (or a `parallel:` group).
Apply the block-scalar guard to any key whose value is a block scalar (`|` or `>`,
including chomping and indentation indicators). Add provider tests for each case
above, plus the existing positive cases.
