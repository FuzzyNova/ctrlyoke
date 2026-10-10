# Docs: session log described as always written, user-scope settings list incomplete, Command Palette command missing

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (each claim checked against the code)
- **Area:** `docs/troubleshooting/`, `docs/reference/_partials/settings/intro.md`, `docs/reference/commands.md`
- **Resolution:** fixed in this commit

## Symptom

1. **Session log.** `docs/troubleshooting/index.md` (~line 25) lists
   `ctrlyoke-<timestamp>.log` as "Start here" with no condition, and
   `docs/troubleshooting/common-errors.md` (~23-24) assumes it exists. In a
   release build, `Log.initialize` (`src/utils/Log.ts` ~94-103) opens that file
   only when `diagnostics.verboseLogging` is on, and that setting defaults to
   `false`. The neighbouring rows already say "written only when
   `diagnostics.verboseLogging` is on". A user following the guide finds no
   file. (`dev/bugs/implemented/docs-hook-debug-logs-require-verbose-logging.md`
   fixed only the hook, notify and plugin rows.)
2. **User-scope-only settings.** `docs/reference/_partials/settings/intro.md`
   (~14-16, the source for the generated `docs/reference/settings.md`) lists
   only `worktrees`, `storage`, `statusLine` and `usageTracking.enabled`.
   `WORKSPACE_FORBIDDEN_SETTING_ROOTS` in `src/config/CtrlYokeConfigService.ts`
   (~57-65) also includes `languageServers.idleShutdownMinutes`,
   `languageServers.maxRunning` and `languageServers.startOnLaunch`, which
   ctrlyoke ignores in a workspace file.
3. **Commands reference.** `docs/reference/commands.md` doesn't list
   `ctrlyoke.reviewWorkspaceSettingsTrust` ("Review Workspace Settings That Run
   Programs"). That command is visible in `package.json`
   `contributes.commands`, and the settings intro tells users to run it from
   the Command Palette.

## Suggested Fix

1. Add the "written only when `diagnostics.verboseLogging` is on (always in
   dev builds)" qualifier to the session-log row, and adjust
   `common-errors.md` to tell users to enable it first.
2. Add the three `languageServers.*` keys to the partial, then run
   `npm run schema:update` to regenerate `settings.md`. Never hand-edit the
   generated file. Consider generating this list from
   `WORKSPACE_FORBIDDEN_SETTING_ROOTS` so it can't drift.
3. Add a row for the command in `docs/reference/commands.md`, matching the
   title in `package.json`.

`npm run check:docs` must pass.
