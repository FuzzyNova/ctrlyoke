# Turning off "Respect .gitignore for completions" no longer shows ignored files (regression)

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/completions/CompletionHelpers.ts`, `src/platform/NodeHostServices.ts`
- **Resolution:** fixed in this commit

## Symptom

The `ui.respectGitignoreForCompletions` setting does nothing. You can switch it with the editor toggle (`EditorSection.tsx`, the repo icon in the editor header) or on the Settings page, and the setting itself changes correctly. But in a git workspace, `@` file completions always come from `git ls-files --cached --others --exclude-standard`. With the toggle off, gitignored files such as `dist/`, `out/`, `node_modules/` and `.env` should appear in the completion list, but they don't.

This used to work. It regressed in `77d71066e refactor: remove duplicate completion helpers` (2026-10-06). Before that commit, the VS Code `getCompletionFiles` read `ConfigurationUtils.shouldRespectGitignoreForCompletions()`. When the setting was on it used the git-aware file list. When it was off it used `vscode.workspace.findFiles("**/*", "**/.git/**")`, which listed every file except `.git/`. The refactor replaced that code with the host-neutral `CompletionCore` path, which never reads the setting. The refactor also deleted the tests that stubbed the setting, so nothing caught the regression.

## Steps to Reproduce

1. Open a git workspace that has gitignored files, for example `dist/` or a `.env`.
2. Turn off the "Respect .gitignore for completions" toggle in the editor header. The icon changes to `repo`, and `ui.respectGitignoreForCompletions` becomes `false` in settings.
3. Wait at least 5 s for the completion file cache to expire, then type `@dist/` or `@.env` in the prompt editor.
4. No gitignored file is offered. The same happens in the standalone/hosted dashboard, which uses `NodeHostServices`.

## Root Cause

- `getCompletionFiles()` in `src/completions/CompletionHelpers.ts:37-62` always calls `getGitTrackedFiles()`. It uses `walkSearchFiles()` only in the `catch` branch, when git fails. It never reads the setting.
- `getCompletionFiles` in `src/platform/NodeHostServices.ts:137-146` does the same, so the CLI, MCP and hosted path ignore the setting too.
- `ConfigurationUtils.shouldRespectGitignoreForCompletions()` (`src/utils/ConfigurationUtils.ts:543`) now has one caller, `src/ui/WebviewSettingsSync.ts:831`. That caller only sends the value back to the UI.
- Even the git-failure fallback wouldn't give the old "off" behavior. `walkSearchFiles` skips `DEFAULT_SKIP_DIRECTORIES` (`.git`, `node_modules`, `dist`, `build`, `out`, `coverage`; see `src/utils/WorkspaceSearchFileWalker.ts:5-12`), so it would still hide the build output people usually want to reference.
- The `PromptCompletionProvider.test.ts` stubs (`:61-67`, `:181`, `:271`) still set the getter, but none of the code under test reads it.

## Suggested Fix

Make the setting work again on every host, with one shared implementation:

1. **Add one shared file-discovery helper**, for example `listCompletionFiles(rootPath, { respectGitignore })` in `src/utils/` next to `WorkspaceSearchFileWalker.ts`:
   - When `respectGitignore` is `true`, use `getGitTrackedFiles()`. If git fails, fall back to `walkSearchFiles()` with the default skip set, as today.
   - When it is `false`, use `walkSearchFiles()` with a skip set of only `.git`, which matches the pre-regression `findFiles("**/*", "**/.git/**")`. Keep the existing 100k-file and 10 s bounds so a huge `node_modules` truncates instead of hanging. Log at debug level when the result is truncated.
2. **Use the helper in both callers.** In `CompletionHelpers.getCompletionFiles` and `NodeHostServices.getCompletionFiles`, read the setting through `ConfigurationUtils.shouldRespectGitignoreForCompletions()` or `configService`, whichever is correct for that host, and pass it in. The existing `configService` subscription in `CompletionHelpers.ts` already clears the cache when settings change. Confirm it fires for this key, and add the same invalidation to the Node host if it lacks one.
3. **Tests.** Cover both modes of the helper against a temp git repo with an ignored file and an ignored directory. Add a `CompletionHelpers`/`CompletionCore` test that flips the setting and asserts that an ignored file appears or disappears, so this can't silently regress again.
4. **Docs.** Fix `.github/instructions/completions.instructions.md:86`, which names the wrong key (`ctrlyoke.respectGitignoreForCompletions` instead of `ui.respectGitignoreForCompletions`). Check that the settings reference description still matches the behavior.

Keep the toggle and the setting. Removing them is not the fix.
