# Home directory as workspace: file search walks the whole home directory and exposes private files

- **Found:** 2026-11-23 by claude-cli, reviewing ctrlyoke run from the home directory
- **Area:** `src/utils/WorkspaceSearchFileWalker.ts`, `src/completions/WorkspaceFileIndex.ts`
- **Severity:** medium

## Symptom

With the home directory open as the workspace, the non-Git file walk behind `@` completion and
hosted search covers everything under the home directory:

- It walks `AppData`, OneDrive, Dropbox, caches and package stores until it hits `maxFiles` or the
  time budget. The index is then cut short, so files the user cares about may be missing. On a
  cloud-synced folder, opening files can also trigger downloads.
- It offers private files such as `~/.ssh/*`, `~/.aws/credentials`, `~/.npmrc` and harness
  credential files as ordinary `@` references.

## Steps to Reproduce

1. Open the home directory (not a Git work tree) as the ctrlyoke workspace.
2. Type `@.ss` in a prompt.
3. `~/.ssh` files are offered. Indexing on a large profile reports a truncated result.

## Root Cause

`DEFAULT_SKIP_DIRECTORIES` (`src/utils/WorkspaceSearchFileWalker.ts:5-12`) covers only project
build output (`node_modules`, `dist`, `out` and similar). Nothing treats the home directory
differently, because the walker assumes the workspace is a project.

## Suggested Fix

When `isUserHomeWorkspace(root)` is true (`src/utils/ProjectStatePaths.ts`), add a home-specific
skip set to the walker and its watcher. Use one list for both (`isSearchPathIgnored`):

- OS profile folders: `AppData`, `Library`, `.cache`, `.local/share`
- Credential folders: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`
- Package stores: `.npm`, `.nuget`, `.cargo`, `.rustup`, `go/pkg`
- Harness state folders

Optionally show a one-time notice suggesting a project folder for large homes.
