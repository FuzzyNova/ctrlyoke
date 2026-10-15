# strip-dev-commands backup is overwritten on a re-run after a failed package, so the dev commands are lost from package.json

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `scripts/strip-dev-commands.mjs`
- **Resolution:** fixed in this commit

## Symptom

If `npm run package` fails after the strip step and is then run again, package.json ends up without its "ctrlyoke Test" dev commands (`ctrlyoke.devMenu`, `ctrlyoke.listAllCommands`, `ctrlyoke.showLanguageId`, `ctrlyoke.dumpCssVars`) and their menu entries. The removal shows up as a working-tree diff that is easy to commit by accident. Running `npm run build:prod` or `vscode:prepublish` directly also strips package.json, and neither restores it.

## Steps to Reproduce

1. Add a type error to a webview file so that `build:webview` fails.
2. Run `npm run package`. vsce runs `vscode:prepublish` → `build:prod` → `build:extension`, which strips package.json and writes `package.json.backup`. `build:webview` then fails, so the `&& node scripts/strip-dev-commands.mjs --restore` step is skipped and package.json stays stripped.
3. Fix the type error and run `npm run package` again. `stripDevCommands()` overwrites `package.json.backup` with the already-stripped package.json. The build succeeds, and `--restore` copies the stripped backup over package.json and deletes the backup.
4. `git diff package.json` shows the "ctrlyoke Test" commands and their menu entries removed, with no backup left to recover them from.

## Root Cause

`stripDevCommands()` in `scripts/strip-dev-commands.mjs:39-40` always writes `package.json.backup` from whatever package.json currently holds. It never checks for an existing backup and never detects that package.json is already stripped.

In `package.json:716`, `build:extension` strips package.json before several more steps that can fail: `esbuild.js --production`, `assert-no-copilot-runtime.mjs`, and then `build:webview` via `build:prod` (`package.json:715`). The only restore is in `package` (`package.json:718`), chained with `&&` after `vsce package`, so any failure skips it. Nothing restores package.json after a direct `npm run build:prod` or `vscode:prepublish` (`package.json:714`).

## Suggested Fix

- Minimal: in `stripDevCommands()`, if `package.json.backup` already exists, refuse to strip and exit with a message telling the user to run `npm run restore-package` (or restore from the backup first, then strip again). Never overwrite an existing backup.
- Better: stop leaving the working-tree package.json mutated. Either wrap `vsce package` in a script that always restores in a `finally` block, even on failure, or strip a copy inside a staging directory that vsce packages from. Either way, a failed or direct `build:prod` run can no longer leave package.json stripped.
