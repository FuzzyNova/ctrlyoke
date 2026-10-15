# Script completion replaces 'npm run' with a bare script name when there is no trailing space

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/completions/ScriptCommandCompletionHelpers.ts`
- **Severity:** medium

## Symptom

Type `npm run`, `pnpm run`, or `yarn run` with no trailing space into a script-step command field. This happens in the dashboard `ScriptCommandEditor` and in a script range in the workflow file editor. Then accept a suggestion such as `npm run build`. The whole command is replaced with just `build`, so the step would run a `build` command that does not exist.

## Steps to Reproduce

1. Open a workspace whose `package.json` has a `build` script.
2. In the dashboard, add or edit a script step and focus its command field.
3. Type `npm run` with no trailing space. The completion list opens with entries labelled `npm run build`, `npm run test`, and so on.
4. Accept `npm run build`.
5. The field now reads `build`, not `npm run build`.

## Root Cause

Two regexes that should agree do not:

- `parseScriptCompletionContext` (`src/completions/ScriptCommandCompletionHelpers.ts:479`) computes `replacementStart` with `/^(?:npm|pnpm|yarn)\s+run\s+/i`. That pattern needs whitespace after `run`, so for `npm run` the replacement start stays at `commandStart`.
- `getScriptCommandCompletions` (line 613) chooses script-name mode with `/^(npm|pnpm|yarn)\s+run\s*(.*)$/i`. That pattern also matches `npm run` with nothing after it. Lines 615-624 then return only `SCRIPT_NAME` candidates. Each of those is labelled with the full `<manager> run <name>`, but its `insertText` is the bare script name (lines 558-568).

`PromptEditorSupportService` (`src/ui/PromptEditorSupportService.ts:365-368`) sends `parseScriptCompletionContext(...).replacementStart` as `from`. `ScriptCommandEditor.tsx:20-29` and `utils/workflowFileSupport/hostedRangeCompletions.ts:70-77` build a CodeMirror result with `filter: false` and `apply: item.insertText`. Accepting a suggestion replaces `[from, cursor]` (all of `npm run`) with the script name.

## Suggested Fix

Detect the run prefix in one place. Export one regex or helper from `ScriptCommandCompletionHelpers` and have both functions use it. The preferred approach is for `parseScriptCompletionContext` to return the run-match result (manager and script prefix) so that `getScriptCommandCompletions` uses it and does not parse `beforeCursor` a second time. A smaller fix is to require `\s+` after `run` in `getScriptCommandCompletions`. Then `npm run` falls through to FULL mode, where `insertText` `npm run build` correctly replaces from `commandStart`. Either way, match on a word boundary (`run\b`) so that `npm runx` is not treated as `run`.

Add test cases for `npm run`, `pnpm run`, and `yarn run` with no trailing space. Each should check that `text.slice(0, from) + insertText` produces a valid full command.
