# Script command completion erases `npm run ` when picking a script right after the space

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/completions/ScriptCommandCompletionHelpers.ts` (`parseScriptCompletionContext`, around lines 443-480)
- **Severity:** medium

## Symptom

In the script-step command editor, type `npm run ` (with the trailing space) and pick a
package.json script such as `build` from the completion list. The field becomes `build` instead
of `npm run build`. Typing one character first (`npm run b`) works.

## Steps to Reproduce

Verified by an agent: `parseScriptCompletionContext("npm run ", 8)` returns `replacementStart: 0`,
while `"npm run b"` returns `replacementStart: 8`. The script-name item's `insertText` is just the
script name, so `ScriptCommandEditor.tsx` replaces from offset 0.

## Root Cause

`beforeCursor` has trailing whitespace stripped before
`runPrefix = /^(?:npm|pnpm|yarn)\s+run\s+/i` is tested. That regex needs whitespace after `run`,
so it fails on `npm run` and `replacementStart` falls back to `commandStart`. Meanwhile
`getScriptCommandCompletions` accepts `run\s*` and still offers script names.

## Suggested Fix

Test `runPrefix` against the unstripped text before the cursor (only leading whitespace removed),
or make both checks use one shared regex. Add tests for `npm run `, `pnpm run `, `yarn run ` with
a trailing space, and for `npm run b`.
