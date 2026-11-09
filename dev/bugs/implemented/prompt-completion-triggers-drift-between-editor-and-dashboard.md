# Prompt completion opens in the wrong places, differently in VS Code and the dashboard

- **Found:** 2026-11-09 by deferred code-smell review, claude-cli
- **Area:** `src/completions/PromptCompletionProvider.ts`, `src/ui/webview-react/utils/promptCompletion/promptCompletionResult.ts`
- **Resolution:** fixed in this commit

## Symptom

The two prompt editors decide differently when a completion trigger is active,
and each is wrong somewhere:

- **Dashboard, `/`:** typing `./x` or a URL such as `https://host` opens
  slash-token completion. The runtime parser never resolves a token in those
  positions.
- **VS Code, `~`:** typing `~/Documents` opens git-change completion, although
  `~` references are only `diff`, `staged`, `stash:N` or a commit hash
  (`FileReferenceParser.ts:1160`, `docs/guide/concepts.md:118`).
- **Dashboard, `@\"`:** in a JSON workflow, typing `@\"my dir/` gives no
  completions, although the dashboard passes a JSON escape for workflow files.
- **Dashboard, `#`:** the `[A-Za-z0-9_/:.-]*` query pattern rejects non-ASCII
  symbol names.

## Steps to Reproduce

1. In the dashboard prompt editor, type `see ./` and observe slash-token
   suggestions.
2. In a VS Code `.prompt.md` file, type `~/` and observe git-change
   suggestions.

## Root Cause

The trigger detection is written twice. The VS Code side uses
`findPartialSlashTokenStart` (`src/utils/CtrlYokeSlashTokens.ts`), which
rejects `/` after `/`, `.` or `:`, the same rule as the runtime token pattern.
The dashboard uses plain `findWordStartTriggerIndex` (`:360`). The query
validation for `#` and `~` and the handling of escaped `@` quotes also differ
between the two sides (`PromptCompletionProvider.ts:66-133` and
`promptCompletionResult.ts:357-378`).

## Suggested Fix

Add a pure `findPromptTriggerContext(textBefore, escape?)` in
`src/completions/PromptTriggerContext.ts`. The dashboard already imports pure
`@root/completions/*` and `@root/utils/*` modules, so both bundles can use it.
Take the stricter, runtime-matching rule from each side: the slash-token
boundary, the `~` git-reference shape, and escaped `@` quotes. Loosen `#` to
"no whitespace or quote". Cover both callers with tests.
