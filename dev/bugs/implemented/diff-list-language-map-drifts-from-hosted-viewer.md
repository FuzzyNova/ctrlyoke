# Diff list language map drifts from the hosted viewer's

- **Found:** 2026-11-14 by smell-hunt pass (claude-cli)
- **Area:** `src/ui/webview-react/utils/rdvAdapter.ts`, `src/server/HostedWorkspaceViewerService.ts`
- **Resolution:** fixed in this commit

## Symptom

A diff for a `.h`, `.hpp`, `.zsh`, `.env` or `*.dockerfile` file has no language until
the hosted viewer's per-file detail arrives. `DiffFileCard` renders
`resolvedDetail?.language ?? language`, so the same file's language flips from none to
`c`/`cpp`/`shell`/`properties`/`dockerfile` once the detail resolves, and a diff whose
detail is never fetched stays unhighlighted.

## Steps to Reproduce

1. Change a `.h` file and open its diff in the dashboard's diff list.
2. `parseUnifiedDiffToFiles` returns `language: undefined` for it.
3. The hosted viewer's `languageFromPath` for the same path returns `"c"`.

## Root Cause

`languageFromPath` in `rdvAdapter.ts` keeps its own copy of the server's extension →
language map (`LANGUAGE_MAP` in `HostedWorkspaceViewerService.ts`). The copy is
missing `zsh`, `h`, `hpp`, `env` and the `dockerfile` extension key.

## Suggested Fix

Single-source the map and the basename/extension lookup in an import-free module that
both the server and the webview import.
