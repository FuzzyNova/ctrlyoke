# POSIX absolute file paths in CLI command text are resolved as relative, so the links open nonexistent files

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/utils/cliCommandFileLinks.ts`
- **Severity:** low

## Symptom

On macOS and Linux, when a CLI command row contains an absolute POSIX file reference, the rendered link starts one character after the leading `/`. Clicking it opens `<cwd>/<abs path without leading slash>`, for example `/Users/me/repo/Users/me/repo/src/foo.ts`, which does not exist. The link never opens the file it points at.

## Steps to Reproduce

1. On macOS or Linux, open a multi-root VS Code workspace, or set `ui.useAbsolutePathReferences` in `.ctrlyoke/settings.json`.
2. Run a workflow prompt step on a CLI harness (for example `claude-cli`) that references a file or uses a temp prompt/excerpts file. The command then contains something like `@/Users/me/repo/src/foo.ts` or `/Users/me/repo/.ctrlyoke/temp/123-prompt.md`.
3. In the dashboard output, look at the CLI command row. The underlined link covers `Users/me/repo/...` and leaves out the leading `/`.
4. Click the link. `openFile` receives `/Users/me/repo/Users/me/repo/...`, and the editor reports that the file is missing (the hosted workspace viewer shows nothing).

## Root Cause

- `src/ui/webview-react/utils/cliCommandFileLinks.ts:37-61`: `CLI_FILE_PATH_SOURCE` has alternatives for Windows absolute paths, Codex `/abs/path/c:/` paths, `/c:/` paths, `./` and `../` paths, and bare-relative paths. It has none for POSIX absolute paths. Alternative 3 (line 46-47) needs a drive letter after the slash, so the global regex skips the `/` and matches the rest as a bare-relative path through alternative 5 (line 52-53).
- `cliCommandFileLinks.ts:63`: `ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/` only recognizes drive-letter paths. `resolveOpenPath` (lines 99-110) then joins the working directory onto the truncated path.
- That working directory comes from `row.workingDirectory`, passed in at `src/ui/webview-react/components/output/OutputRow.tsx:1884`.
- `CliIntegration.formatDirectFileRef` and `formatTempFileRef` (`src/core/harness/CliIntegration.ts:476-501`) emit absolute POSIX paths whenever `getEffectiveAbsolute()` (`CliIntegration.ts:403-408`) is true, meaning a multi-root workspace or `ui.useAbsolutePathReferences`. On macOS and Linux this happens in normal use.

## Suggested Fix

- Add a POSIX-absolute alternative to `CLI_FILE_PATH_SOURCE`, such as `"/(?=[\\w.\\-])"` (a single leading slash followed by a path segment). Put it after the `/abs/path/` and `/X:/` alternatives so those still win.
- Widen `ABSOLUTE_PATH_PATTERN` to `/^(?:[A-Za-z]:[\\/]|\/)/` so `resolveOpenPath` returns these paths unchanged.
- Consider requiring the start of the string or a non-path character before the slash, so URL fragments such as `https://x/y.md` are not linked.
- Add vitest cases to `src/ui/webview-react/test/utils/cliCommandFileLinks.test.tsx` for `@/Users/me/repo/src/foo.ts` and `/home/u/repo/.ctrlyoke/temp/x.md`, using a POSIX working directory.
