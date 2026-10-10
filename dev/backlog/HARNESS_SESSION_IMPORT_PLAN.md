# Harness Session Import Plan

> **2026-10-10 audit:** Still not implemented — `segmentSessionTurns`,
> `isHumanPromptEvent`, `listNativeSessions`, `HarnessSessionImportService`,
> `RunMaterializer`, and `importedFrom` appear nowhere in `src/` or `schemas/`. Changes
> made: (1) every parser now implements `classifyUserEvent` (`ILogParser.ts:389`,
> `UserEventClassification`), so `isHumanPromptEvent` is redefined as a thin wrapper over
> it rather than a new per-harness method; (2) the "undo must clamp to the open
> workspace" fix **has shipped** (`2204f7a7d` — `UndoRedoCoordinator` resolves the
> execution root extension-side and the undo message no longer carries a
> webview-derived `workspacePath`), so that section is now a verification note, not
> work; (3) `USER_SCOPED_RUN_HISTORY_PLAN.md` and `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`
> moved to `implemented/`; (4) refreshed stale line citations, the
> `WorkflowControls` dropdown description, the message-type location, and the
> nonexistent Copilot `resolveLogPath`; (5) noted that `WorkflowVariantService` already
> materializes a lineage-backed workflow without a workspace file, which step 3 can
> follow.
>
> **Status:** Proposed — not implemented. Grounding re-verified 2026-08-14; the
> citations below match current code. Two earlier assumptions were wrong and have
> been corrected in place: the run-storage path (`.ctrlyoke/.history/…` never
> existed under that name) and the relationship to terminal follow-up tracking,
> which shipped without the shared primitive this plan assumed it would share.

## Overview

Add the ability to **import a native harness session** (a Claude / Copilot / Codex /
OpenCode / Qwen / Antigravity session recorded outside ctrlyoke) into ctrlyoke's history
so it becomes a first-class, searchable, browsable workflow with full undo/redo fidelity.

Concretely: a new **"Import from harness session…"** entry in
`WorkflowControls.tsx` opens a picker listing sessions found in each harness's native
log directory. Selecting one runs its log through the harness `ILogParser`, segments it
into turns, and materializes:

- **one new workflow file** (`<name>.ctrlyoke.json`) whose steps are the user prompts
  from that session, and
- **one new run** in ctrlyoke's run storage (`<runsRoot>/<workflowKey>/run-<timestamp>/`
  with `manifest.json` + `events.jsonl`) whose `cliOutputRecorded` events reproduce the
  session's prompts, responses, tool calls, thinking, and token stats.

Never construct that path by hand: `src/utils/WorkflowPaths.ts` is the only module
allowed to build it, and `../implemented/USER_SCOPED_RUN_HISTORY_PLAN.md` relocated
`runsRoot()` out of the workspace by default (user mode) — code that goes through
`WorkflowPaths` follows both modes for free, code that string-joins `.ctrlyoke` does not.

The result opens in the dashboard exactly like a workflow ctrlyoke ran itself — same
`OutputPane` rendering, same minimap, same undo/redo affordances.

Two sibling plans share this one's machinery:

- `../implemented/TERMINAL_FOLLOWUP_TRACKING_PLAN.md` — the "live capture" half. It has
  **shipped**, and it did _not_ build the turn-segmentation primitive an earlier draft of
  this plan assumed the two would share. See
  [Relationship](#relationship-to-terminal-follow-up-tracking).
- `RUN_EXPORT_PLAN.md` — imports a **ctrlyoke run bundle** rather than a native session
  log, and materializes it through the same final step. That plan proposes factoring the
  materializer out as `RunMaterializer` with two sources; build it once.

---

## What exists today (grounding)

| Capability                                                               | Where                                                                                                                                                                                                                                                              | Status for import                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Per-harness JSONL parsing, incremental read                              | `BaseLogParser.readNewLines` / `readFirstNJsonlEvents`                                                                                                                                                                                                             | ✅ reuse                                                                        |
| `events[] → UniversalCliOutput` (text + toolCalls + thinking + metadata) | `ILogParser.extractResponse`                                                                                                                                                                                                                                       | ✅ reuse, but currently assembles the **whole** log as one response             |
| Structured per-event streaming                                           | `ILogParser.extractStructuredEventsFromEvent`                                                                                                                                                                                                                      | ✅ reuse per-turn                                                               |
| Session-id extraction, completion detection, stats formatting            | `extractSessionId`, `isComplete`, `formatStatistics`                                                                                                                                                                                                               | ✅ reuse                                                                        |
| Session-log discovery by prompt/sessionId                                | `discoverSessionLog`                                                                                                                                                                                                                                               | ➖ related, but keyed off a known prompt — not an enumerator                    |
| Parser instance per harness                                              | `ICliProvider.logParser` (`src/core/harness/shared/interfaces/ICliProvider.ts:146`)                                                                                                                                                                                | ✅ the harness→parser map already exists                                        |
| Native log dir per harness (private)                                     | e.g. `ClaudeLogParser` `~/.claude/projects/<project>/<session>.jsonl` + `sessions-index.json`; Copilot `~/.copilot/session-state/<session>/events.jsonl`; Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (see `dev/research/CLI_LOG_FILES_INVESTIGATION.md`) | ➖ each parser knows its dir internally; there is no public "list sessions" API |
| Run-history storage: `manifest.json` + `events.jsonl`                    | `TimelineRecorder`, `OutputHistoryManager`                                                                                                                                                                                                                         | ✅ reuse — write path is already public                                         |
| History event holding a turn                                             | `TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED` → payload `{ cliOutput: CliOutput }` targeting an `OutputExecutionTarget` (`{ kind: queue, stepIndex }`)                                                                                                                | ✅ this is the import target shape                                              |
| Workflow-create UI messages                                              | `WorkflowControls.tsx` → `NEW_WORKFLOW` / `LOAD_WORKFLOW` / `SELECT_FILE` / `APPEND_FILE`; standalone `WorkflowFilePickerModal`                                                                                                                                    | ✅ extend with an import flow                                                   |
| Human-vs-protocol user-event classification                              | `ILogParser.classifyUserEvent` → `UserEventClassification` (`"tool-result" \| "injected-prompt" \| "resume-signal" \| "human-steer" \| "other"`), overridden by all six parsers; `extractUserSteerText` for the prompt text                                        | ✅ reuse as the turn-boundary test (added 2026-10-10)                           |
| Workflow lineage without a workspace file                                | `WorkflowVariantService` → `WorkflowLineageRepository.createLineage(…, provenance)` + draft `workflow.ctrlyoke.json` (the "Duplicate This Run as New Workflow…" path)                                                                                              | ✅ model for step 3 (added 2026-10-10)                                          |

**The two real gaps:**

1. **Turn segmentation.** Every parser today extracts _one_ response from a log
   (it assumes ctrlyoke sent one prompt). Import needs the log split into an **ordered
   list of turns**, each a `(userPrompt, assistantResponse)` pair. Assistant extraction
   is first-class; user-prompt _classification_ now is too (`classifyUserEvent` /
   `extractUserSteerText` in every parser, e.g. `ClaudeLogParser.ts:617`), but only as a
   per-event judgement for live steer emission — nothing groups events into turns.
2. **Session enumeration.** Parsers can _discover_ a log matching a known prompt, but
   nothing _lists_ all sessions in a harness's native directory with display metadata.

---

## Core new primitive: session turn segmentation

Add to `ILogParser` (default impl in `BaseLogParser`, overridable per harness):

```ts
interface SessionTurn {
  /** 1-based order within the session */
  index: number;
  /** The human prompt text that opened this turn */
  promptText: string;
  /** Raw events belonging to this turn (prompt boundary → next prompt boundary) */
  events: BaseCliEvent[];
  startedAtMs: number;
  endedAtMs?: number;
}

interface ILogParser {
  /**
   * Split a full session log into ordered user→assistant turns.
   * A "turn" starts at a genuine human prompt and ends at the next human prompt
   * (or EOF). Programmatic user-role events (tool_result blocks, injected system
   * prompts) MUST NOT open a turn.
   */
  segmentSessionTurns(events: BaseCliEvent[]): SessionTurn[];
}
```

- **No new per-harness `isHumanPromptEvent`.** (Updated 2026-10-10.) Every parser
  already overrides `classifyUserEvent(event, ctx)` (Claude `:617`, Copilot `:1016`,
  Codex `:742`, Qwen `:413`, OpenCode `:263`, Antigravity `:934`). Called with an
  empty `ctx` (no `dispatchedPromptText`), it cannot tell ctrlyoke-injected prompts
  from typed ones, so both come back `"human-steer"` — which is exactly the import
  semantics (see "Injected ctrlyoke prompts" below). A turn boundary is therefore
  `classifyUserEvent(e, {}) === "human-steer"`, and `promptText` comes from
  `extractUserSteerText(e)`. If a harness needs a different answer for import, fix it
  in that classifier, not beside it.
- `BaseLogParser` provides the default `segmentSessionTurns` that walks events, opens a
  turn on each human-steer event, and closes it at the next one. Because the base
  `classifyUserEvent` returns `"other"`, a parser that never overrides it yields a
  single turn (or none) — acceptable for a hypothetical future harness.
- Per-harness caveats to verify with fixtures: Copilot system reminders arrive as
  `user.message` with `source: "system"` and must stay non-human (already handled by
  its classifier); Claude `queue-operation` / task-notification `user` events are
  `"resume-signal"`, not turns.
- Per turn, response content comes from the **existing** `extractResponse(turn.events)`
  — no new extraction logic, just a narrower event slice. Same for
  `extractStructuredEventsFromEvent` if we want per-event granularity, and
  `formatStatistics` for token stats.

The boundary test (`classifyUserEvent`) is shared with the live steer path in
`CliLogEventPump`; the segmentation itself is import-only.

---

## Session enumeration

Add to `ILogParser`:

```ts
interface HarnessSessionSummary {
  harnessId: HarnessId;
  sessionId: string;
  logPath: string; // absolute path to the session's JSONL
  firstPrompt: string; // for the picker label
  turnCount?: number; // cheap estimate if available without full parse
  modifiedAtMs: number;
  createdAtMs?: number;
  projectPath?: string; // Claude/Copilot record the originating cwd
  model?: string;
}

interface ILogParser {
  /**
   * List native sessions for this harness, newest first. Reads only enough of
   * each log (index file or first N events) to build a summary — no full parse.
   */
  listNativeSessions(options?: {
    limit?: number;
    modifiedAfterMs?: number;
    projectPath?: string; // optionally filter to the current workspace
  }): Promise<HarnessSessionSummary[]>;
}
```

Implementation notes:

- Reuse `findModifiedSessionLogs` (already in `BaseLogParser`) for the directory scan;
  it already handles both flat-file and `session-id/events.jsonl` layouts and mtime
  sorting.
- **Claude** should prefer `sessions-index.json` (has `firstPrompt`, `messageCount`,
  `created`, `projectPath` per entry — see investigation doc) instead of opening every
  file. Fall back to `readFirstNJsonlEvents` when the index is stale/missing.
- The harness log directory currently lives in private methods or inline code (e.g.
  `ClaudeLogParser.getClaudeProjectDirectory()` ~line 1482; Copilot builds
  `~/.copilot/session-state` inline inside `discoverSessionLog` ~line 1122). Promote a `protected getLogDirectory()` /
  `resolveLogPath()` so `listNativeSessions` and `discoverSessionLog` share one source
  of the path. (DRY — matches project single-source principle.)
- Default `projectPath` filter = the current workspace folder, so the picker shows
  "sessions for this project" by default, with a toggle to show all.

A small backend service — `HarnessSessionImportService` (in `src/core/orchestration/`)
— fans out over the registered providers' `logParser` instances to aggregate
`HarnessSessionSummary[]` across all harnesses for the picker.

---

## Import pipeline

`HarnessSessionImportService.importSession(summary): Promise<{ workflowFilePath: string }>`

1. **Read + parse.** `parser.readFirstNJsonlEvents` (or a full read) → all events for
   `summary.logPath`.
2. **Segment.** `turns = parser.segmentSessionTurns(events)`.
3. **Synthesize the workflow file.** Build a `<name>.ctrlyoke.json` with one step per
   turn: `prompt.text = turn.promptText`, `harness = summary.harnessId`,
   `model = summary.model` when known. Name it e.g.
   `imported-<harness>-<sessionShortId>`. Write it (validated against
   `schemas/workflow-schema.json` via `PromptFileParser`) so the extension's file
   watcher picks it up like any other workflow. Mark provenance in a workflow-level
   field (e.g. `importedFrom: { harnessId, sessionId, logPath, importedAtMs }`) — add to
   the schema and `CtrlYokeTypes`.
   _Alternative (2026-10-10):_ skip the workspace file entirely and create a
   lineage-only workflow the way `WorkflowVariantService` does for "Duplicate This Run
   as New Workflow…" — `WorkflowLineageRepository.createLineage(…, provenance)` plus a
   draft `workflow.ctrlyoke.json` written through `WorkingFileManager`. Provenance then
   lives in the lineage descriptor (`workflow.json` / `WorkflowLineageDescriptor`,
   which already carries optional variant provenance — `sourceWorkflowKey`,
   `sourceRunRef`, … — so an optional `importedFrom` sits naturally beside it) rather
   than in the authored-workflow schema, and importing
   doesn't litter the user's repo with generated files. Prefer this unless there's a
   reason the import must be an editable file in the workspace.
4. **Materialize one run.** Via `OutputHistoryManager`. Note the run **directory** is
   allocated first and history is seeded into it — `initializeRunAt` does not create the
   run, it populates one (`OutputHistoryManager.ts:331`):
   - Allocate the lineage and run through the normal path
     (`WorkflowLineageRepository.allocateRun` via `WorkingFileManager.promoteToNewRun`),
     yielding `{ workflowKey, runRef, runDir, runId }`.
   - `initializeRunAt(workflowKey, runRef, runDir, runId, startedAt, [], initialDefinition)`
     → `{ filePath, runCount }`; `filePath` is the `historyFilePath` below. Pass the
     session's original start time as `startedAt` (see step 5).
   - For each turn `i`: - `universal = parser.extractResponse(turn.events)` - Map `universal → CliOutput` (`prompt`, `response`, `structured`, `elapsed`,
     `tokens`, `timestampMs = turn.startedAtMs`, `workingDirectory =
summary.projectPath`, `runIndex: 0`, `attemptIndex: 0`). Reuse the **same**
     `UniversalCliOutput → CliOutput` mapping the live path uses (single-source it if
     it isn't already a shared helper). - `saveExecutionOutput(historyFilePath, { kind: queue, stepIndex: i }, [cliOutput])`
     → appends a `cliOutputRecorded` event.
   - `finalizeRun(historyFilePath, EXECUTION_STATES.COMPLETED, turns.length)`.
5. **Timestamps.** Because history uses real `timestampMs`/`startedAt`, and the
   `run-<timestamp>` directory name encodes the start time (`WorkflowPaths.formatRunRef`),
   the imported run should be stamped with the **session's original** times, not now — so
   an imported run sorts into history where it actually happened. Pass the session start
   time as `initializeRunAt`'s `startedAt` (already a parameter) rather than `Date.now()`.
   The `runRef` must be derived from the same timestamp or the directory name and the
   manifest disagree.
6. **Close the run.** `finalizeRun(historyFilePath, EXECUTION_STATES.COMPLETED,
turns.length)` (`OutputHistoryManager.ts:1007`); pass `activeExecutionMs` when the
   log gives enough information to compute it. Note `finalizeRun` stamps
   `completedAt = Date.now()` internally, so a faithful session end time needs a
   `completedAt` override parameter (small, additive).

No new storage format: an imported run is byte-compatible with a ctrlyoke-run one, so
`OutputPane`, the minimap, search indexing, and undo/redo work with zero UI changes.

**Factor this step out.** `RUN_EXPORT_PLAN.md` needs the identical "allocate → seed →
append events → finalize" sequence with a different front end. Extract it as a
`RunMaterializer` taking already-shaped events, and let both the session importer and the
bundle importer call it. Built separately, the two will diverge.

### Undo/redo for imports — what actually works

Earlier drafts assumed imports can't support undo because they lack a
`workspaceSnapshot`. That's only half true. ctrlyoke's undo has **two tiers**, and only
one of them needs a snapshot:

| Undo tier                                                                                 | Data source                                                                                       | Works for imports?         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------- |
| **Per-file / per-event** (`buildUndoDialogInputForSpecificEvent`, `promptUndo.ts:1053`)   | The structured CLI event itself                                                                   | ✅ mostly — see below      |
| **Prompt-level "undo all changes"** (`buildUndoCandidatesForOutputs:295`, gate at `:383`) | `instruction = snapEntry ? resolveSnapshotUndoInstruction(snapEntry) : null` — **snapshot-gated** | ❌ null without a snapshot |

Per-event undo derives its instruction directly from the event:

- `FILE_EDIT` → `REVERSE_PATCH` built from `editData.structuredPatch`
  (`promptUndo.ts:~1096-1112`) — **no snapshot needed**. The extension reads the current
  file and reverse-applies the patch (`WorkspaceSnapshotService.ts:~1189`).
- `FILE_WRITE` → `DELETE` the created file (`resolveEventUndoInstruction`,
  `promptUndo.ts:128`) — **no snapshot needed**.
- `FILE_DELETE` → needs `contentToRestore`, which only a snapshot carries today
  (`promptUndo.ts:~139-155`) — **degrades** unless the source log recorded the deleted
  file's prior content.
- **Redo** works regardless: `redoInstructions` are captured at undo-apply time by
  reading current content just before overwriting (`WorkspaceSnapshotService.undoFiles`, `:1089`),
  so redo is generated live, not at import time.

Because import reuses the **same** `extractResponse` / structured events as the live run,
imported `FILE_EDIT`/`FILE_WRITE` cards render diffs and expose the per-file undo button
exactly like a native run — as long as each harness parser populates
`FileEditData.structuredPatch` (which the live path already relies on). Harnesses whose
structured extraction lacks a patch degrade to display-only, same as they do live.

**So the plan is: enable per-file undo/redo for imported turns from the event-attributed
diffs. Do NOT globally disable undo.** Two follow-on decisions:

1. **Prompt-level bulk undo for imports.** Optional enhancement: teach
   `buildUndoCandidatesForOutputs` to synthesize an event-based instruction (reverse the
   accumulated `eventPatches` for `FILE_EDIT`, delete for `FILE_WRITE`) when `snapEntry`
   is absent, instead of returning `null`. That lights up the "undo all changes in this
   step" button for imports too. Without it, imports get per-file undo only.
2. **`FILE_DELETE` restore** stays unavailable unless we extend the per-harness parsers
   to capture the pre-delete content where the log exposes it.

### Undo target must clamp to the _open_ workspace (security) — already enforced

The apply-undo guard is `WorkspaceSnapshotService.undoFiles(files, workspacePath,
namedRoots?)` (`WorkspaceSnapshotService.ts:1089`). It resolves each instruction with
`resolveNamedRelativePath` and rejects anything not inside its trusted-root set —
`workspacePath` plus every named root — as "Path traversal detected — skipping", using
the shared `isPathWithinDirectory` helper (`src/utils/PathSecurity.ts`).

The hazard this section originally flagged — `workspacePath` being derived in the webview
from an output's recorded `workingDirectory` — **is fixed** (2026-10-10 audit; landed in
`2204f7a7d` "guard undo against mismatched worktrees"). `UndoPromptChangesMessage` no
longer carries a workspace path; `UndoRedoCoordinator.applySnapshotEntries` resolves the
root extension-side via `resolveUndoExecutionWorkspace()`, which uses the currently open
workspace roots unless the run's `_runtime.worktree` names a validated managed worktree.
So an imported foreign-project output can no longer steer undo writes outside the open
workspace — its absolute paths simply fail the guard.

Remaining import-specific work is small:

- **Never set `_runtime.worktree`** on an imported run's working file; that is the one
  recorded value the coordinator still honours (after validation).
- **UX, not security:** today a foreign path only fails at apply time. Pre-disabling the
  apply button for files outside the open workspace (diff stays visible), or routing
  through `permissions.trustedExternalRoots` (`../implemented/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`)
  when the user opts in, is the friendlier behaviour.

`RUN_EXPORT_PLAN.md` §6 raises the same issue one severity higher: for an imported run
bundle, `workingDirectory` is attacker-chosen, so that plan recomputes it on
materialization. The extension-side root resolution above already protects both sources;
recomputing `workingDirectory` remains worthwhile for display correctness.

---

## UI

### WorkflowControls entry

Add a dropdown option in `WorkflowControls.tsx` (`dropdownOptions`, which today holds
"New From Template…", "Load from File…", "Queue from File…"/"Append and Continue from
File…", and "Duplicate Workflow…"/"Duplicate This Run as New Workflow…"):

```ts
{
  label: "Import from Harness Session…",
  value: "import-session",
  icon: <LucideIcon icon={Import} />,
  onClick: handleImportSession,
}
```

`Import` is the `lucide-react` export, rendered through the shared `LucideIcon` wrapper
like the file options next to it.

`handleImportSession` opens a new modal (both webview and standalone) rather than a VS
Code quick-pick, because the list is rich (harness badge, first prompt, turn count,
timestamp, project). Model it on `WorkflowFilePickerModal`.

### Session picker modal

`HarnessSessionPickerModal`:

- On open, requests `LIST_HARNESS_SESSIONS` → renders grouped-by-harness list of
  `HarnessSessionSummary` (harness icon, `firstPrompt` truncated, relative time,
  `turnCount`, project path).
- Filters: harness toggle, "this project only" toggle (default on), text filter over
  `firstPrompt`.
- Selecting one sends `IMPORT_HARNESS_SESSION` with the chosen summary; the backend
  imports and then loads the new workflow (reusing the existing post-create load path so
  the imported run shows immediately in `OutputPane`).

## Message plumbing

Add the constants to `MESSAGE_TYPES` (`src/types/DashboardConstants.ts`) and the payload
interfaces to `src/types/WebviewMessageTypes.ts` (`src/ui/webview-react/types/messages.ts`
only re-exports them), then handle them in the extension-side router:

- `LIST_HARNESS_SESSIONS` (webview→ext) / response payload `HarnessSessionSummary[]`.
- `IMPORT_HARNESS_SESSION` (webview→ext) with `{ summary }`; on success, reuse the
  existing "workflow created/loaded" notification path.

Keep the summary type in a shared `src/types/*` module (single-sourced across
core/ext/webview per project conventions), not duplicated in the webview.

---

## Relationship to Terminal Follow-up Tracking

**This section was written before the follow-up tracker shipped, and its central claim no
longer holds.** `../implemented/TERMINAL_FOLLOWUP_TRACKING_PLAN.md` is **implemented** (for
Claude, Copilot, and Antigravity), and it solved a narrower problem with a different
architecture: `SessionActivityWatcher` keeps the shared provider log reader alive after a
prompt monitor resolves, and `CliLogMonitor` holds completion while
`BackgroundFollowUpState` (`src/core/harness/shared/BackgroundFollowUpState.ts`) tracks
background-task identities and a resumed-turn latch. It detects _"is this prompt really
finished?"_, not _"where does each human turn begin?"_

Verified 2026-08-14 (and again 2026-10-10): `segmentSessionTurns`, `isHumanPromptEvent`,
`SessionTurn`, and `listNativeSessions` appear nowhere in `src/`. **Both primitives are
still unbuilt, and this plan is now their only consumer.** Two consequences:

- The old "build it once, and doing import first de-risks the live tracker" framing is
  obsolete. There is no second consumer waiting; phase 1 is justified by import alone.
- The nearest existing work is **user-steer classification**, which the shipped pump
  already owns (`CliLogEventPump.ts:32` — "user-steer classification/emission";
  `SessionActivityWatcher.ts:12` forwards user-steer events). That classifier is now a
  first-class `ILogParser.classifyUserEvent` overridden by all six parsers, so the
  "is this user-role event a real human turn?" judgement is **reused directly** (see
  the segmentation section) rather than reimplemented — two disagreeing answers to one
  question was the failure mode.

|           | Session Import (this plan)                | Terminal Follow-up Tracking (shipped)        |
| --------- | ----------------------------------------- | -------------------------------------------- |
| Input     | a finished session log, read once         | a live session, watched after prompt resolve |
| Core need | `segmentSessionTurns` over all events     | background-task + resumed-turn state         |
| Output    | N `cliOutputRecorded` events in a new run | completion held/released for the live prompt |

Convergence point that still stands: an imported run, a live-observed follow-up turn, and
an imported run bundle (`RUN_EXPORT_PLAN.md`) should all carry an origin marker and render
with a visual badge in `OutputPane`, distinguishing observed and imported turns from
ctrlyoke-dispatched ones. Design that badge once, for three origins.

---

## Edge cases & challenges

- **Injected ctrlyoke prompts in a native log.** If the session being imported was
  itself partly driven by ctrlyoke (temp-file prompts, MCP dequeue markers), those user
  events are still "human turns" from the log's perspective. Acceptable for v1 (we're
  faithfully reproducing the session); optionally strip `queue-operation` markers.
- **Huge sessions.** Some logs are large. Read incrementally; cap imported turns
  (configurable) and warn. `events.jsonl` append is streaming, so memory is bounded by
  the largest single turn's `extractResponse`.
- **Copilot format split** (flat file vs `session-id/events.jsonl`, v0.0.384+). Handled
  inline in `CopilotLogParser.discoverSessionLog` (there is no `resolveLogPath`
  helper) — extract that layout probe into a shared method and have enumeration call it,
  not assume a layout. Check `versionPolicy.minimum` first: if every supported Copilot
  writes the directory format, drop the flat-file branch instead of extending it.
- **Missing model/tokens.** Older logs may lack usage; map to `undefined` and let
  `formatStatistics` omit them (it already guards on non-zero usage).
- **Duplicate imports.** Key the generated workflow name on `sessionId`; if a workflow
  for that session already exists, offer "open existing" vs "re-import as new run".
- **Cross-project sessions (allowed).** Claude/Copilot record `projectPath`. We **allow**
  importing a session from another project — it becomes a workflow here for browsing and
  search. Keep **absolute paths** throughout (the CLI logs already emit absolute tool-call
  paths, and `sameFilePath` at `promptUndo.ts:83` already tolerates absolute-vs-relative),
  so the import is not rewritten to be workspace-relative. Consequences:
  - **Display** always works — diffs render from the event data regardless of where the
    original files live.
  - **Undo writes** are clamped to the currently-open workspace (see the security section
    above). For a same-workspace import, undo applies normally. For a foreign-project
    import, the target files sit outside the open workspace, so the apply button is
    disabled (diffs still visible) unless the user opts in via allowed external roots.
  - This is strictly safer than the old "disable undo for all imports" stance: same-project
    imports keep full per-file undo; only genuinely out-of-workspace writes are withheld.
- **Non-file harnesses.** `listNativeSessions` returns `[]` for any harness without a
  `logParser`. Only file-backed CLI harnesses are importable. All six current harnesses
  are CLI-based, so this is a guard for future harnesses rather than an exclusion today.

---

## Phasing

1. **Parser primitives.** `segmentSessionTurns` on top of the existing
   `classifyUserEvent`/`extractUserSteerText` (+ tests in
   `src/test/suite/harness/LogParsers.test.ts` against fixture logs for each harness).
   Promote a `getLogDirectory`/layout-resolution helper to shared/protected.
2. **Enumeration.** `listNativeSessions` per parser + `HarnessSessionImportService`
   fan-out. Unit tests over fixture directories.
3. **Import pipeline.** `importSession` → workflow file + run history via the shared
   `RunMaterializer` over `OutputHistoryManager`. Single-source the
   `UniversalCliOutput → CliOutput` mapping. Add `importedFrom` to the lineage
   descriptor (preferred) or to schema + `CtrlYokeTypes`.
4. **UI.** WorkflowControls entry, `HarnessSessionPickerModal`, message plumbing, load
   imported workflow on success.
5. **Undo wiring + provenance.** Per-file undo/redo works for imports out of the box via
   the shared event-based path, and writes are already clamped to the open workspace
   extension-side (`2204f7a7d`). The remaining work is (a) pre-disabling apply for
   out-of-workspace files in the UI, (b) optionally synthesizing event-based prompt-level undo instructions when no snapshot
   exists, and (c) an "imported" / "observed" badge in `OutputPane` (shared with the
   follow-up tracker) that also signals which turns support undo.

Phases 1–2 are this plan's own foundation, not a shared one — the follow-up tracker
shipped without them (see Relationship). What _is_ shared is phase 3's materializer, which
`RUN_EXPORT_PLAN.md` phase 2 also consumes; whichever plan reaches it first should extract
it rather than inline it.

---

## Open questions

1. Should imports default to **current-project sessions only**, or all sessions across
   all projects? (Proposed: current project by default, toggle to widen.)
2. Should re-importing a session that grew since last import **append a new run** to the
   same workflow (nice: "run history" of the same conversation over time) or always mint
   a fresh workflow? (Proposed: same workflow, new run.)
3. Do we import **tool-result / thinking** detail at full fidelity into `structured`, or
   collapse to text for very large sessions to keep `events.jsonl` lean?
4. For prompt-level bulk undo on imports, do we ship the event-based instruction
   synthesis (reverse accumulated `eventPatches`) so "undo all changes" works, or accept
   per-file-only undo for imports in v1?
5. Should the picker also surface sessions that ctrlyoke already tracks (to avoid
   confusing duplicates), or hard-filter those out by `sessionId`?
