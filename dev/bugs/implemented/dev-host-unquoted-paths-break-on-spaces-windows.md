# Unquoted path arguments passed through shell:true on Windows break dev-host launch and package:install when the repo path contains spaces

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `scripts/dev-host.mjs`
- **Resolution:** fixed in this commit

## Symptom

On Windows, when the repo path contains a space, `npm run dev:host:start` (in any mode) starts VS Code with its arguments split apart. VS Code gets the wrong `--user-data-dir`, the wrong `--extensionDevelopmentPath` and some stray positional paths. The isolated profile is not used, the dev extension does not load, and the script times out waiting for `server-url.txt`.

`npm run package:install` builds the VSIX, but `code --install-extension` receives only the part of the VSIX path before the space, so the install fails.

## Steps to Reproduce

1. On Windows, clone or copy the repo to a path that contains a space, e.g. `C:\Users\Jane Doe\ctrlyoke`, and run `npm install`.
2. Run `npm run dev:host:start`. cmd.exe receives `code.cmd --user-data-dir=C:\Users\Jane Doe\ctrlyoke\.vscode-dev-userdata --extensionDevelopmentPath=C:\Users\Jane Doe\ctrlyoke ...` without quotes. VS Code sees `--user-data-dir=C:\Users\Jane`, `Doe\ctrlyoke\.vscode-dev-userdata` and so on as separate arguments. The script then reports a timeout waiting for the server URL file.
3. Run `npm run package:install`. `npm run package` succeeds, but `code --install-extension C:\Users\Jane Doe\ctrlyoke\ctrlyoke-x.y.z.vsix --force` is split, and `code` reports that it cannot find the extension `C:\Users\Jane`.

## Root Cause

- `scripts/dev-host.mjs:275-287` builds the argument array from absolute paths derived from `REPO_ROOT`: `--user-data-dir=${mode.userDataDir}`, `--extensionDevelopmentPath=${REPO_ROOT}` and `mode.workspace`.
- `scripts/dev-host.mjs:289-295` spawns `CODE_BIN` (`code.cmd` on Windows, line 92) with `shell: IS_WINDOWS`.
- `scripts/package-install.mjs:16-22` runs every command with `shell: process.platform === "win32"`. Line 39 passes `vsixPath`, an unquoted absolute path built at line 36.

With `shell: true`, Node on Windows joins the command and its arguments with spaces into a single cmd.exe command line. It does not quote or escape them, so a space or a cmd metacharacter (`&`, `^`, `|`, and so on) in the path breaks the argument boundaries. The shell is only there so that `.cmd` shims such as `code.cmd` can run, but it also removes per-argument quoting.

`compile()` at `scripts/dev-host.mjs:212-218` uses the same pattern. Its arguments contain no paths, so it is not affected.

## Suggested Fix

Add one shared helper under `scripts/` that runs a `.cmd` shim on Windows without letting cmd.exe re-split its arguments, and use it in both scripts (and in `compile()` for consistency). There are two options:

- Call `spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", quotedCommandLine], { windowsVerbatimArguments: true, ... })`. Wrap every argument in double quotes, escape embedded quotes and caret-escape cmd metacharacters, the same way the `cross-spawn` package does.
- Resolve the real executable behind the shim (`<VS Code install>\Code.exe` with `resources/app/out/cli.js` and `ELECTRON_RUN_AS_NODE=1`, or `node <npm-cli.js>`) and spawn it with `shell: false`.

Keep `shell: false` on other platforms. Either option also removes the DEP0190 deprecation warning that newer Node versions print when `shell: true` is used with an arguments array.
