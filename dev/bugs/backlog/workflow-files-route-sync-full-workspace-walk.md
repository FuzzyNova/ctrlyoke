# Workflow file discovery walks the whole workspace synchronously on the extension host, including ignored trees

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/utils/WorkflowFileDiscovery.ts`
- **Severity:** medium

## Symptom

Opening the hosted workflow file picker (`GET /api/workflow-files`) freezes the extension
host for as long as it takes to walk the entire workspace. The VS Code workflow quick
picks use the same function and freeze it the same way. While the walk runs, every
dashboard client and route is blocked, and `[EventLoopStall]` appears in the session log.
The walk also descends into untracked and ignored trees and returns workflow files found
deep inside them, which the picker then has to show.

Measured on this repo: `findWorkflowFilesInWorkspace(cwd)` took 1,155 ms of synchronous
work and returned 3,729 entries. 3,585 of them came from `.vscode-test/`, and only 16
from `src/`. The time grows with every untracked or ignored tree that is not on the
small skip list (`.vscode-test`, `.venv`, `target/`, `build/`, caches, and so on).

## Steps to Reproduce

1. Open a workspace that contains a large ignored tree not named `node_modules`, `out`,
   `dist` or `coverage`. Examples are `.vscode-test/`, `.venv/` or `target/`.
2. Open the workflow file picker in the hosted dashboard, or run a VS Code command that
   lists workflow files.
3. The extension host blocks for the full walk, and the list includes workflow-like
   files from inside the ignored tree.

## Root Cause

- `src/utils/WorkflowFileDiscovery.ts:25-66`: a recursive `fs.readdirSync` walk with no
  yielding, no cap and no `.gitignore` awareness. Only the names in
  `IGNORED_WORKFLOW_SCAN_DIRS` (`.git`, `node_modules`, `out`, `dist`, `coverage`; lines
  13-19) are pruned.
- `src/server/CtrlYokeHostedServer.ts:1469-1484`: the route calls it inline inside an
  `async` handler, so the whole walk runs synchronously on the event loop. Other callers
  are at `src/extension.ts` (around line 1191) and
  `src/ui/VsCodeDashboardHostActions.ts` (around line 67).

## Suggested Fix

- Use Git as the source of candidates: filter `getGitTrackedFiles` output (tracked plus
  non-ignored untracked) by `getCtrlYokeFileKind`, and walk the filesystem only when the
  folder is not a Git checkout. `WorkspaceFileIndex` already keeps this listing for
  `@` completions, so the picker could query that index instead of walking again.
- Where a walk is still needed, make it asynchronous (`fs.promises.readdir`) and yield
  between directories, the way `iterateSearchFiles` does, so it never blocks the routing
  queue.
- If ignored workflow files should still be offered, list them on demand. The picker
  already has a "hide git-ignored" toggle. A paged or lazy second listing, like the
  ignored-files phase in `src/server/WorkspaceSearchSession.ts`, would cover this
  without blocking the first response.
