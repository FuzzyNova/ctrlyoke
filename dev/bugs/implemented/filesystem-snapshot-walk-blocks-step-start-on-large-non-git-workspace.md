# Filesystem snapshot walk blocks step start on a large non-git workspace

- **Found:** 2026-11-05 by user (claude-cli run in a `G:\My Drive` workspace), diagnosed by Claude
- **Area:** `src/utils/WorkspaceSnapshotService.ts`, `src/core/WorkflowExecutor.ts`
- **Resolution:** fixed in this commit

## Symptom

The first prompt sent in a new workspace opened at the Google Drive root
(`G:\My Drive`, Google Drive for Desktop) never launched the harness terminal.
The run sat in `running` with no output until the user pressed Stop about a
minute later.

Session log (`ctrlyoke-1793894085979.log`):

- `WARN: [WorkspaceFileIndex] root is not a Git repository for g:\My Drive; using degraded filesystem walk.`
- `INFO: [inst:3c42d025] Workflow started - workflow.ctrlyoke.json, 1 step(s), next harness: claude-cli`
- No `Step 1/1 started`, no `[WorkflowExecutor] Executing prompt`, no skill expansion, and no
  `ai-cli` PTY spawn followed. In a normal run these follow within about 300 ms. The only PTY
  spawned was a plain `pwsh.exe` shell session.
- On Stop: `[CliIntegration] Cancel called` and then `No active process/execution`. The harness
  had never been started.
- Extension-host heap grew by about 56 MB during the wait, and an `[EventLoopStall]` of about
  645 ms appeared after the stop, which suggests the walk kept running.

## Steps to Reproduce

1. Open a large folder that is not a git repository as the VS Code workspace. A cloud-synced
   root such as `G:\My Drive` with photos, music and archives makes it most visible.
2. Run any prompt with a CLI harness.
3. The step never starts. The harness terminal does not appear until the whole tree has been
   read, which can take minutes or longer.

## Root Cause

Before a step's attempt begins, `WorkflowExecutor.execute()` calls `selectSnapshotStrategy()`.
Then `executeWithSnapshot()` awaits `snapshotService.captureWorkspaceState()` for the
before-state (`src/core/WorkflowExecutor.ts`, `executeWithSnapshot`). For a folder outside a git
repo, `WorkspaceSnapshotService.selectStrategy()` returns `FILESYSTEM`. `captureSegment()` then
calls `walkDirectory()` over the entire execution root.

`walkDirectory()` / `readFileForSnapshot()` have no limits:

- There is no cap on file count, total bytes or elapsed time.
- Every file is read in full with `fs.promises.readFile`. Files larger than `MAX_CONTENT_SIZE`
  are still read completely, just to be hashed. Binary files (photos, audio, zips) are read in
  full and only then discarded by `isBinary()`.
- Only the developer folders in `EXCLUDED_DIRS` (`node_modules`, `.git`, `dist`, …) are skipped.
  A personal or document folder has none of them.
- On Google Drive for Desktop, OneDrive Files On-Demand and similar sync clients, reading an
  online-only placeholder downloads it. The walk therefore downloads the whole drive.
- The capture does not watch for Stop. Stopping the run does not abort the walk.

The snapshot is a nice-to-have (the diff/undo view), but it blocks the step's critical path, so a
slow walk looks like a harness that never launched.

## Suggested Fix

1. **Budget the filesystem walk.** Add a file-count limit, a total-bytes-read limit and a
   wall-clock deadline to `walkDirectory()`. When any limit is hit, stop and return an
   "unavailable / incomplete" result. `executeWithSnapshot()` then skips the before-state and the
   diff for that step, the same way it does when capture throws. Log one `WARN` that names the
   limit that was hit, and optionally show a one-time dashboard notice suggesting `git init` or a
   narrower workspace folder.
2. **Decide from `stat` before reading.** Skip files larger than a limit without opening them,
   rather than reading them just to hash them. Skip known binary extensions (images, audio,
   video, archives, office and PDF documents) by name, so they are never read. Use `size` +
   `mtimeMs` as a cheap fingerprint for files over the content limit instead of a full-content
   hash.
3. **Never hydrate cloud placeholders.** On Windows, skip files whose attributes include
   `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` / `FILE_ATTRIBUTE_RECALL_ON_OPEN` /
   `FILE_ATTRIBUTE_OFFLINE`, so the walk never triggers a download. Skip `.gdoc`/`.gsheet`/`.lnk`
   style stubs and `desktop.ini`.
4. **Make capture cancellable.** Thread an `AbortSignal` from the run's stop path into
   `captureWorkspaceState()`/`walkDirectory()` so that Stop ends the walk at once instead of
   leaving it running in the extension host.
5. **Consider taking it off the critical path.** Either start the harness while the before-state
   capture runs concurrently, or cap the time the step will wait for it. The terminal should never
   wait on a best-effort snapshot.

Add tests in `src/test/unit/WorkspaceSnapshotService.test.ts` for budget exhaustion (capture
returns incomplete, step still runs), large-file/binary skipping without content reads, and abort
on stop.

## Fix

- `walkDirectory()` runs under a `FilesystemWalkBudget` (20,000 files, 64 MB read, 5 s).
  Exceeding any limit throws `SnapshotUnavailableError` rather than returning a partial
  state, because a missing before-state file would read as created by the step and its
  undo would delete it. `executeWithSnapshot()` already skipped the snapshot on a throw.
  The service remembers an over-budget root for the rest of the run, so later steps fail
  at once, and logs one `WARN` naming the limit. No dashboard notice was added.
- `readFileForSnapshot()` decides from the name and `stat` first. Known binary and
  cloud-stub extensions and `desktop.ini` are never opened. Files over `MAX_CONTENT_SIZE`
  get a `stat:<size>:<mtimeMs>` fingerprint without being read.
- `WorkflowExecutor.captureWorkspaceStateUntilStopped()` aborts a capture when the run
  starts cancelling during it. The abort also cancels an in-flight `readFile` and
  `git status`.
- Not done: Windows file-attribute checks (`RECALL_ON_DATA_ACCESS` and the others). Node's
  `fs.Stats` does not expose attributes without a native addon. The extension skip list
  and the bytes budget bound how much a sync client can be asked to download.
- Not done: starting the harness while the before-state is captured. The before-state has
  to be complete before the harness starts editing, so the wait is capped by the deadline
  instead.
