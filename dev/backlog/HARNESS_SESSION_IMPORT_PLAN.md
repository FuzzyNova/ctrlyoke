# Harness Session Import Plan

## Overview

Add the ability to **import a native harness session** (a Claude / Copilot / Codex /
Gemini / Qwen / OpenCode session recorded outside ctrlyoke) into ctrlyoke's history so
it becomes a first-class, searchable, browsable workflow with full undo/redo fidelity.

Concretely: a new **"Import from harness session…"** entry in
`WorkflowControls.tsx` opens a picker listing sessions found in each harness's native
log directory. Selecting one runs its log through the harness `ILogParser`, segments it
into turns, and materializes:

- **one new workflow file** (`<name>.ctrlyoke.json`) whose steps are the user prompts
  from that session, and
- **one new run history** (`.ctrlyoke/.history/<workflow-id>/run-<ts>/` with
  `manifest.json` + `events.jsonl`) whose `cliOutputRecorded` events reproduce the
  session's prompts, responses, tool calls, thinking, and token stats.

The result opens in the dashboard exactly like a workflow ctrlyoke ran itself — same
`OutputPane` rendering, same minimap, same undo/redo affordances.

This is the "import" half of the full-fidelity-history goal. The "live capture" half —
watching a still-open TUI for prompts the user types directly — is
`TERMINAL_FOLLOWUP_TRACKING_PLAN.md`. **The two share one new core primitive: turn
segmentation of a session log.** See [Relationship](#relationship-to-terminal-follow-up-tracking).

---

## What exists today (grounding)

| Capability                                                               | Where                                                                                                                                                                                                                                                              | Status for import                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Per-harness JSONL parsing, incremental read                              | `BaseLogParser.readNewLines` / `readFirstNJsonlEvents`                                                                                                                                                                                                             | ✅ reuse                                                                        |
| `events[] → UniversalCliOutput` (text + toolCalls + thinking + metadata) | `ILogParser.extractResponse`                                                                                                                                                                                                                                       | ✅ reuse, but currently assembles the **whole** log as one response             |
| Structured per-event streaming                                           | `ILogParser.extractStructuredEventsFromEvent`                                                                                                                                                                                                                      | ✅ reuse per-turn                                                               |
| Session-id extraction, completion detection, stats formatting            | `extractSessionId`, `isComplete`, `formatStatistics`                                                                                                                                                                                                               | ✅ reuse                                                                        |
| Session-log discovery by prompt/sessionId                                | `discoverSessionLog`                                                                                                                                                                                                                                               | ➖ related, but keyed off a known prompt — not an enumerator                    |
| Parser instance per harness                                              | `ICliProvider.logParser` (`src/core/harness/shared/interfaces/ICliProvider.ts:103`)                                                                                                                                                                                | ✅ the harness→parser map already exists                                        |
| Native log dir per harness (private)                                     | e.g. `ClaudeLogParser` `~/.claude/projects/<project>/<session>.jsonl` + `sessions-index.json`; Copilot `~/.copilot/session-state/<session>/events.jsonl`; Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (see `dev/research/CLI_LOG_FILES_INVESTIGATION.md`) | ➖ each parser knows its dir internally; there is no public "list sessions" API |
| Run-history storage: `manifest.json` + `events.jsonl`                    | `TimelineRecorder`, `OutputHistoryManager`                                                                                                                                                                                                                         | ✅ reuse — write path is already public                                         |
| History event holding a turn                                             | `TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED` → payload `{ cliOutput: CliOutput }` targeting an `OutputExecutionTarget` (`{ kind: queue, stepIndex }`)                                                                                                                | ✅ this is the import target shape                                              |
| Workflow-create UI messages                                              | `WorkflowControls.tsx` → `NEW_WORKFLOW` / `LOAD_WORKFLOW` / `SELECT_FILE` / `APPEND_FILE`; standalone `WorkflowFilePickerModal`                                                                                                                                    | ✅ extend with an import flow                                                   |

**The two real gaps:**

1. **Turn segmentation.** Every parser today extracts _one_ response from a log
   (it assumes ctrlyoke sent one prompt). Import needs the log split into an **ordered
   list of turns**, each a `(userPrompt, assistantResponse)` pair. Today only assistant
   extraction is first-class; user-prompt parsing exists only incidentally (e.g.
   `ClaudeLogParser.ts:241,716` filter `type:"user"` blocks to skip tool-results).
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

  /** True only for a genuine human prompt event (not a tool_result carrier). */
  isHumanPromptEvent(event: BaseCliEvent): boolean;
}
```

- `BaseLogParser` provides a default `segmentSessionTurns` that walks events, opens a
  turn on each `isHumanPromptEvent`, and closes it at the next one. `isHumanPromptEvent`
  is abstract-ish (base returns `false`; each harness overrides).
- **Claude**: human prompt = `type:"user"` whose `message.content` has a non-empty
  `text` block (mirror the `isHumanPrompt` guard already sketched in
  `TERMINAL_FOLLOWUP_TRACKING_PLAN.md` §3; reuse the existing `type:"user"` content
  inspection at `ClaudeLogParser.ts:241`). Tool-result `user` events are excluded.
- **Copilot**: human prompt = `user.message` events (per
  `CLI_LOG_FILES_INVESTIGATION.md`), excluding tool-execution traffic.
- **Codex / Gemini / Qwen / OpenCode**: analogous, using each format's user-message event.
- Per turn, response content comes from the **existing** `extractResponse(turn.events)`
  — no new extraction logic, just a narrower event slice. Same for
  `extractStructuredEventsFromEvent` if we want per-event granularity, and
  `formatStatistics` for token stats.

This one method is the shared dependency with the terminal-follow-up tracker, which
needs the same "is this a real new user turn?" boundary detection on a live-growing file.

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
- The harness log directory currently lives in private methods (e.g.
  `ClaudeLogParser` around line 854). Promote a `protected getLogDirectory()` /
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
4. **Materialize one run.** Via `OutputHistoryManager`:
   - `workflowId = OutputHistoryManager.extractWorkflowId(workflowFilePath)`
   - `initializeRun(workflowId)` → `historyFilePath` (creates
     `run-<ts>/manifest.json` + empty `events.jsonl`).
   - For each turn `i`: - `universal = parser.extractResponse(turn.events)` - Map `universal → CliOutput` (`prompt`, `response`, `structured`, `elapsed`,
     `tokens`, `timestampMs = turn.startedAtMs`, `workingDirectory =
summary.projectPath`, `runIndex: 0`, `attemptIndex: 0`). Reuse the **same**
     `UniversalCliOutput → CliOutput` mapping the live path uses (single-source it if
     it isn't already a shared helper). - `saveExecutionOutput(historyFilePath, { kind: queue, stepIndex: i }, [cliOutput])`
     → appends a `cliOutputRecorded` event.
   - `finalizeRun(historyFilePath, EXECUTION_STATES.COMPLETED, turns.length)`.
5. **Timestamps.** Because history uses real `timestampMs`/`startedAt`, and
   `run-<ts>` directory names encode the start time, the imported run should be stamped
   with the **session's original** times, not now — so an imported run sorts into
   history where it actually happened. Pass the session start time through
   `TimelineRecorder.initializeRun`'s `startedAt` (already a parameter) rather than
   `Date.now()`.

No new storage format: an imported run is byte-compatible with a ctrlyoke-run one, so
`OutputPane`, the minimap, search indexing, and undo/redo work with zero UI changes.

### Undo/redo for imports — what actually works

Earlier drafts assumed imports can't support undo because they lack a
`workspaceSnapshot`. That's only half true. ctrlyoke's undo has **two tiers**, and only
one of them needs a snapshot:

| Undo tier                                                                              | Data source                                                                                       | Works for imports?         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------- |
| **Per-file / per-event** (`buildUndoDialogInputForSpecificEvent`, `promptUndo.ts:403`) | The structured CLI event itself                                                                   | ✅ mostly — see below      |
| **Prompt-level "undo all changes"** (`buildUndoCandidatesForOutputs:213`)              | `instruction = snapEntry ? resolveSnapshotUndoInstruction(snapEntry) : null` — **snapshot-gated** | ❌ null without a snapshot |

Per-event undo derives its instruction directly from the event:

- `FILE_EDIT` → `REVERSE_PATCH` built from `editData.structuredPatch`
  (`promptUndo.ts:403-419`) — **no snapshot needed**. The extension reads the current
  file and reverse-applies the patch (`WorkspaceSnapshotService.ts:853`).
- `FILE_WRITE` → `DELETE` the created file (`resolveEventUndoInstruction`,
  `promptUndo.ts:55`) — **no snapshot needed**.
- `FILE_DELETE` → needs `contentToRestore`, which only a snapshot carries today
  (`promptUndo.ts:60-72`) — **degrades** unless the source log recorded the deleted
  file's prior content.
- **Redo** works regardless: `redoInstructions` are captured at undo-apply time by
  reading current content just before overwriting (`WorkspaceSnapshotService.ts:816`),
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

### Undo target must clamp to the _open_ workspace (security)

The apply-undo guard in `WorkspaceSnapshotService.ts:774-795` resolves the target as
`path.resolve(workspacePath, instruction.path)` and rejects anything **outside
`workspacePath`** as "Path traversal detected — skipping". Critically, `workspacePath`
comes from the **CliOutput's `workingDirectory`**, not the currently-open VS Code
workspace (`useOutputUndoActions.ts:95`).

That matters for cross-workspace imports (next section): if we stamp imported outputs
with the session's **original** absolute `workingDirectory`, the guard would happily
write undo edits back into that _foreign_ directory on disk, because those paths are
"inside" the declared `workingDirectory`. That silently escapes the open workspace.

**Fix:** the undo-apply path must additionally verify the resolved target is inside the
**currently open workspace** (`getVsCodeWorkspaceRoot()`, using the existing `isPathInside`
helper at `WebviewMessageRouter.ts:2050`) — not only inside the output's recorded
`workingDirectory`. Files outside it render their diff read-only with the apply button
disabled (or route through the existing `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md` mechanism if
the user opts in).

---

## UI

### WorkflowControls entry

Add a fourth dropdown option in `WorkflowControls.tsx` (`dropdownOptions`):

```ts
{
  label: "Import from Harness Session…",
  value: "import-session",
  icon: <i className="custom-icon icon-import-session" />,
  onClick: handleImportSession,
}
```

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

Add to `src/ui/webview-react/types/messages.ts` and the extension-side router:

- `LIST_HARNESS_SESSIONS` (webview→ext) / response payload `HarnessSessionSummary[]`.
- `IMPORT_HARNESS_SESSION` (webview→ext) with `{ summary }`; on success, reuse the
  existing "workflow created/loaded" notification path.

Keep the summary type in a shared `src/types/*` module (single-sourced across
core/ext/webview per project conventions), not duplicated in the webview.

---

## Relationship to Terminal Follow-up Tracking

`TERMINAL_FOLLOWUP_TRACKING_PLAN.md` watches a **live** session log and needs to detect
"a new human turn just appeared." This plan parses a **completed** log and needs "split
all human turns." Both are the same boundary problem:

|           | Session Import (this plan)                | Terminal Follow-up Tracking                |
| --------- | ----------------------------------------- | ------------------------------------------ |
| Input     | a finished session log, read once         | a live-growing session log, tailed         |
| Core need | `segmentSessionTurns` over all events     | `isHumanPromptEvent` at the current offset |
| Output    | N `cliOutputRecorded` events in a new run | 1 observed turn appended to the live run   |

**Build `isHumanPromptEvent` + `segmentSessionTurns` once, in the parser layer.** The
follow-up tracker consumes `isHumanPromptEvent` incrementally as new lines arrive; the
importer consumes `segmentSessionTurns` in bulk. Doing the import first is a good forcing
function: it validates per-harness human-prompt detection against real historical logs
before the live tracker depends on it.

Convergence point: an imported run and a live-observed follow-up turn should both carry
an origin marker (`importedFrom` vs `terminal-followup`) and render with a visual badge
in `OutputPane`, distinguishing "observed" turns from ctrlyoke-dispatched ones.

---

## Edge cases & challenges

- **Injected ctrlyoke prompts in a native log.** If the session being imported was
  itself partly driven by ctrlyoke (temp-file prompts, MCP dequeue markers), those user
  events are still "human turns" from the log's perspective. Acceptable for v1 (we're
  faithfully reproducing the session); optionally strip `queue-operation` markers.
- **Huge sessions.** Some logs are large. Read incrementally; cap imported turns
  (configurable) and warn. `events.jsonl` append is streaming, so memory is bounded by
  the largest single turn's `extractResponse`.
- **Copilot format split** (flat file vs `session-id/events.jsonl`, v0.0.384+). Already
  handled by `resolveLogPath` in the Copilot parser — enumeration must call the same
  resolver, not assume a layout.
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
- **Non-file harnesses.** Copilot Chat has no native JSONL log; `listNativeSessions`
  returns `[]` for harnesses without a `logParser`. Only file-backed CLI harnesses are
  importable.

---

## Phasing

1. **Parser primitives.** `isHumanPromptEvent` + `segmentSessionTurns` (+ tests in
   `src/test/suite/harness/LogParsers.test.ts` against fixture logs for each harness).
   Promote `getLogDirectory`/`resolveLogPath` to shared/protected.
2. **Enumeration.** `listNativeSessions` per parser + `HarnessSessionImportService`
   fan-out. Unit tests over fixture directories.
3. **Import pipeline.** `importSession` → workflow file + run history via
   `OutputHistoryManager`. Single-source the `UniversalCliOutput → CliOutput` mapping.
   Add `importedFrom` to schema + `CtrlYokeTypes`.
4. **UI.** WorkflowControls entry, `HarnessSessionPickerModal`, message plumbing, load
   imported workflow on success.
5. **Undo wiring + provenance.** Per-file undo/redo works for imports out of the box via
   the shared event-based path — the real work here is (a) clamping undo writes to the
   open workspace (`WorkspaceSnapshotService` + `useOutputUndoActions` workspace check),
   (b) optionally synthesizing event-based prompt-level undo instructions when no snapshot
   exists, and (c) an "imported" / "observed" badge in `OutputPane` (shared with the
   follow-up tracker) that also signals which turns support undo.

Phases 1–2 are the shared foundation with the terminal-follow-up tracker and should land
first regardless of which consumer ships next.

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
