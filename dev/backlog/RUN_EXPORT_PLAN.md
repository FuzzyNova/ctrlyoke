# Run Export / Import

> **Status:** Proposed — not implemented. Written 2026-08-14 against current code.
>
> **2026-10-10 audit:** Still not started (no exporter, bundle format, materializer, or
> `export`/`import` CLI command). Since writing, user-scoped run history
> (`dev/implemented/USER_SCOPED_RUN_HISTORY_PLAN.md`), workflow-relative asset refs, and
> secrets/redaction (`dev/implemented/SECRETS_AND_REDACTION_PLAN.md`) have all shipped; references
> updated accordingly. Corrected: `TIMELINE_EVENT_TYPES` gained
> `workflowRuntimeTransitionRecorded`; the asset writer is the `writeWorkflowBundle` function;
> undo-guard/undo-hook line refs; and the redaction step — live outputs are already scrubbed of
> resolved secrets by `StreamingSecretRedactor` before they reach `events.jsonl`, but a
> `RunSecretRedactor` only holds values while its run executes, so the exporter has to re-resolve
> the workflow's declared secrets itself (see §2.1).
>
> **Problem in one line:** run history is machine-local and (since the user-scoped history
> change) lives outside the repo by default, so there is no supported way to hand someone a run — and
> `USER_SCOPED_RUN_HISTORY_PLAN.md` §2.6.1 rules out the obvious workaround of
> committing the run-storage directory.
>
> **Relationship to neighbours.** `dev/implemented/USER_SCOPED_RUN_HISTORY_PLAN.md` §2.6.2 names
> this document as the answer it defers to. `HARNESS_SESSION_IMPORT_PLAN.md` (still backlog)
> already specifies the run **materializer** this plan's importer reuses — one
> materializer, two sources. `dev/implemented/WORKFLOW_RELATIVE_ASSET_REFS_PLAN.md` listed
> "making live run storage portable" as an explicit non-goal; this is where that
> gets picked up.

---

## 1. Why a storage setting cannot answer this

`storage.runHistoryLocation: "workspace"` puts run history back inside the repo,
and that is genuinely useful for durability and locality. It is not sharing, for
reasons `USER_SCOPED_RUN_HISTORY_PLAN.md` §2.6.1 works through: a run directory
is untracked until someone commits it, so plain `git clean -fd` still destroys
in-flight runs; `runner.json` carries a live PID that means nothing on another
machine; `workflow.json`'s `nextRunId`/`latestRunRef` conflict on every
concurrent run; and `events.jsonl` is raw harness transcript.

The last one is the decisive one. **Storage location is a placement decision;
sharing is an egress decision.** They need different machinery — path rewriting,
identity stripping, redaction, asset bundling — none of which a location enum
can express. Conflating them is what produced the inert `.gitignore` dial.

Three concrete requests this plan serves:

- "Attach the run that produced this bug to the bug report."
- "Commit the run that justifies this PR, next to the PR."
- "Send me the run where the harness went sideways so I can look at it."

None of them want a shared live history. All of them want one immutable,
reviewable artifact.

---

## 2. What a run actually is

Verified against current code. Every path below is constructed by
`src/utils/WorkflowPaths.ts` from `runsRoot()` — never assembled by hand.

| Artifact                               | Owner                                         | Export?                                                                 |
| -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `run-<ts>/workflow.ctrlyoke.json`      | `WorkingFileManager`                          | **Yes** — the definition, with `_runtime` blocks stripped to provenance |
| `run-<ts>/manifest.json`               | `TimelineRecorder` (`WorkflowRunManifest`)    | **Yes** — minus identity fields (2.3)                                   |
| `run-<ts>/events.jsonl`                | `TimelineRecorder.appendEvents`               | **Yes** — the payload, after rewrite + redaction                        |
| `<lineage>/workflow.json`              | `WorkflowLineageRepository`                   | No — `latestRunRef`/`nextRunId` are per-root allocator state            |
| `<lineage>/runner.json`                | lock                                          | **Never** — a live PID                                                  |
| `<lineage>/draft/`                     | pre-first-run definition                      | No                                                                      |
| Referenced attachments / prompt bodies | `<stateRoot>/.ctrlyoke/{attachments,prompts}` | **Yes** — bundled (2.4)                                                 |
| `.search-index/`, `.usage/`            | derived projections                           | No — rebuilt by the importer's own writes                               |

`WorkflowRunManifest` (`src/types/WorkflowTimelineTypes.ts:93-118`) carries
`schemaVersion`, `storageKind`, `workflowId`, `runId`, `startedAt`,
`completedAt`, `activeExecutionMs`, `executionState`, `definitionRevision`,
`initialDefinition`, `stepCount`, `eventCount`, `nextSequence`, `lastUpdatedAt`,
and `tokenTotals`. Everything except the identity triple survives export intact.

`events.jsonl` holds the union in `TIMELINE_EVENT_TYPES`
(`WorkflowTimelineTypes.ts:35-57`) — `workflowRuntimeTransitionRecorded`, `cliOutputRecorded`,
`cliOutputChunkAppended`, `cliOutputEventsAppended`, `attemptStarted`,
`attemptTerminated`, `scriptExecutionRecorded`, `retryScheduled`,
`followUpResponseAppended`, `runTerminated`, `statusMessageRecorded`,
`definitionRevisionCommitted`, `workspaceSnapshotCaptured`, `undoApplied`,
`redoApplied`, plus three legacy aggregates retained for read compatibility.

### 2.1 Four things make a run non-portable

This is the whole plan. Everything else is plumbing.

**Absolute paths.** Every `CliOutput` carries `workingDirectory`; structured
tool-call events carry absolute file paths as the harnesses emit them; a
`workspaceSnapshotCaptured` payload carries the captured file set. Export
records a declared `sourceRoot` and rewrites every path **under** it to
root-relative. Paths outside it stay absolute and are listed in `run.json` as
`externalPaths` so a reader can see what the run touched outside the project
without the bundle silently claiming those files are its own.

**Identity.** `allocateWorkflowKey` guarantees uniqueness only within one runs
root (`USER_SCOPED_RUN_HISTORY_PLAN.md` §2.1). A bundle that carried its
`workflowKey`/`runRef`/`runId` as authoritative would collide on import. Export
demotes all three to provenance; import allocates fresh ones through the normal
lineage path and records the originals — the same shape as `importedFrom` in
`HARNESS_SESSION_IMPORT_PLAN.md`. Harness `sessionId` is provenance too: it
refers to a session log that exists only on the exporting machine.

**Secrets.** `events.jsonl` is everything the harness printed, including what it
read out of the repo. `SECRETS_AND_REDACTION_PLAN.md` already names exports as
an egress point that must not leak resolved values. **Redaction runs at the
export boundary and is irreversible by design** — the bundle is the redacted
artifact, not a redacted view over a full one. Ship export with at least the
resolved-secret scrub, and surface a redaction summary in `run.json` so the
exporter can see what was removed before sharing.

What already exists: during execution, `StreamingSecretRedactor`
(`src/utils/SecretRedactionService.ts`, used by `CliTransportCoordinator`,
`PtyProcessManager`, and `ScriptExecutionReporter`) scrubs resolved secret
values out of output before it is persisted, so a run's `events.jsonl` should
already be free of the secrets *that run* resolved. That is not sufficient for
export: a `RunSecretRedactor` holds values only while its run executes (cleared on
unregister), heuristics may have been off, and the harness can still print
secrets it read from the repo that ctrlyoke never resolved. The exporter should
therefore re-resolve the workflow's declared `${secret:NAME}` values from the
secret store where available and run `redactPreviewText`
(`src/types/PreviewRedactor.ts`) with those exact values **plus** heuristics over
every rewritten payload. Do not write a second matcher.

**Assets.** Attachments and prompt bodies referenced by the run live in
`<stateRoot>/.ctrlyoke/{attachments,prompts}/`, are gitignored, and stay
workspace-scoped (`USER_SCOPED_RUN_HISTORY_PLAN.md` §2.3). A bundle without them
is a bundle of dangling `@` references. **Reuse the Save As machinery** —
`analyzeWorkflowBundle` / `WorkflowBundleAnalyzer` (`src/utils/WorkflowBundleAnalyzer.ts`)
already discovers references, plans copies, inlines lone prompt bodies, and
rewrites refs; `writeWorkflowBundle` (`src/utils/WorkflowBundleWriter.ts`) already stages and
publishes them atomically. Do not write a second asset copier.

---

## 3. Bundle format

A **directory**, not an archive:

```
<name>.ctrlyokerun/
  run.json                 ← bundle manifest (below)
  workflow.ctrlyoke.json   ← definition at the exported revision, refs rewritten bundle-relative
  manifest.json            ← WorkflowRunManifest, identity demoted to provenance
  events.jsonl             ← rewritten + redacted timeline, event order preserved
  assets/                  ← bundled attachments, same convention as Save As `*.assets/`
```

Directory-and-JSONL because the point is to put this in a PR, an issue, or a
repo. It diffs, it reviews, it greps. A zip is opaque in exactly the place people
want to use it. Anyone who wants one file can archive the directory themselves.

`run.json`:

```jsonc
{
  "schemaVersion": 1,
  "kind": "ctrlyoke.run.bundle",
  "exportedAt": "2026-08-14T18:04:00.000Z",
  "exportedByVersion": "0.9.x",
  "sourceRoot": "C:\\dev\\ctrlyoke", // what relative paths inside are relative to
  "lineage": {
    "workflowName": "Fix tests",
    "originalFile": "workflows/fix-tests.ctrlyoke.yaml", // optional
  },
  "provenance": {
    "workflowKey": "fix-tests-2026-08-01T…",
    "runRef": "run-1786712286",
    "runId": 7,
    "harnessId": "claude-cli",
    "model": "claude-opus-5",
    "sessionId": "…", // informational only
  },
  "redaction": { "policy": "secrets-v1", "removedCount": 3 },
  "externalPaths": ["C:\\other-repo\\notes.md"],
  "assets": [{ "path": "assets/shot one.png", "sha256": "…", "bytes": 51234 }],
}
```

`sourceRoot` is recorded, not applied: the importer resolves relative paths
against **its own** workspace and never against the exporter's absolute path.
Keeping the original visible is for the reader; using it would be the bug.

---

## 4. Export pipeline

`RunBundleExporter` (`src/core/orchestration/`, vscode-free so the CLI and the
extension share it):

1. **Resolve the run.** `WorkflowPaths.manifestPath` / `eventsPath` /
   `runFilePath` from `{ workflowKey, runRef }`. Refuse to export a run whose
   lineage holds a live `runner.json` — a run still being written has no stable
   `eventCount`.
2. **Read.** Reuse the existing timeline read path rather than parsing
   `events.jsonl` again; `OutputHistoryManager`/`RunOutputResolver` already own
   streaming reads and legacy-event normalization.
3. **Plan assets.** `analyzeWorkflowBundle` over the run's definition → copy plan
   - inline plan + diagnostics. Surface its diagnostics as export warnings; a
     missing attachment must be reported, not silently dropped.
4. **Rewrite.** Apply the `sourceRoot`-relative path transform across the
   definition, the manifest, and each event payload. One transform module, one
   test suite — this is where portability actually lives.
5. **Redact.** Apply the export policy over the rewritten payloads. Count and
   summarize.
6. **Write atomically.** Stage into a hidden sibling of the destination, fsync,
   then rename into place — the same discipline `writeWorkflowBundle` and
   `WorkflowPaths.stagingRunDir` already use. A half-written bundle that someone
   commits is worse than a failed export.

CLI surface, registered alongside the existing run-scoped commands in
`src/cli/CliRunCommandDefinitions.ts` (which already own `rerun`/`append`/
`continue` and the `--from <ref|runId>` selector via `resolveCliRunRefAtLineage` in
`src/cli/CliRunSelector.ts`):

```
ctrlyoke export [--from <ref|runId>] --out <dir> [--redact <policy>] [--json]
ctrlyoke import <bundleDir> [--open]
```

Dashboard surface: an **Export run…** action on a run in the history list, and a
drop target / **Import run bundle…** entry in `WorkflowControls.tsx`, beside the
harness-session import entry once `HARNESS_SESSION_IMPORT_PLAN.md` adds it (it does
not exist yet).

---

## 5. Import pipeline — the same materializer, a second source

This is why the plan is cheap. `HARNESS_SESSION_IMPORT_PLAN.md` §"Import
pipeline" already specifies materializing a synthetic run: allocate the lineage
and run directory, `OutputHistoryManager.initializeRunAt(workflowKey, runRef,
runDir, runId, startedAt, …)`, append `cliOutputRecorded` events, then
`finalizeRun`. **Factor that into one `RunMaterializer` with two callers:**

| Source                       | Produces                                       |
| ---------------------------- | ---------------------------------------------- |
| Native harness session log   | turns → synthesized definition + events        |
| ctrlyoke run bundle (`this`) | definition + events, already in ctrlyoke shape |

The bundle path is strictly simpler — no turn segmentation, no per-harness
parsing, because the events are already ctrlyoke timeline events. If the two
plans are built independently they will grow two materializers, and the second
one will drift. Build the materializer once, with the bundle importer as its
first consumer (it is the easier of the two to get right, and it exercises the
seam without depending on `segmentSessionTurns`).

Import steps: validate → allocate identity → rewrite paths to the importing
workspace → materialize → record provenance → refresh search index (already a
side effect of the history writes).

---

## 6. Security — a bundle is untrusted input

Export is an egress decision; **import is an ingress one**, and the ingress side
is the sharper risk. A bundle arrives from a repo, an issue attachment, or a
stranger.

- **Validate before touching disk.** Reject an unknown `kind` or a newer
  `schemaVersion`. Cap total bytes, event count, and per-event payload size.
- **Contain every path.** Asset paths and rewritten references must resolve
  inside the bundle directory / importing workspace. Use the existing
  `isPathWithinDirectory` (`src/utils/PathSecurity.ts`) — the same helper
  `FileAccessPolicy` and the undo guard use. No second containment
  implementation.
- **Never restore `workingDirectory` from a bundle.** This is the one that
  matters. `WorkspaceSnapshotService.undoFiles` guards undo writes against
  `workspacePath` plus the named roots
  (`src/utils/WorkspaceSnapshotService.ts`, `undoFiles` ~`:1089`), and the webview still
  derives that `workspacePath` from an output's recorded `workingDirectory`
  (`useOutputUndoActions.ts`, ~`:220` and `:505`). A bundle that sets `workingDirectory` to
  an attacker-chosen directory therefore chooses where "undo" writes. Recompute
  `workingDirectory` to the importing workspace on materialization, and gate undo
  on the resolved VS Code workspace rather than on anything the bundle said.
  `HARNESS_SESSION_IMPORT_PLAN.md` found this for _foreign_ imports; for bundles
  the same value is _adversarial_, so the clamp is required, not advisory.
- **Imported runs are read-only by default.** Display, search, and browse fully;
  undo/apply is off unless the user explicitly enables it for a bundle whose
  paths resolve inside the open workspace.
- **Show the provenance.** An imported run renders with an origin badge (shared
  with the harness-session import badge), naming the bundle and its declared
  `sourceRoot`. A run that looks native but came from elsewhere is the failure
  mode to avoid.

---

## 7. Non-goals

- Not a sync mechanism, and not shared live history. A bundle is a snapshot.
- Does not change where run history is stored — orthogonal to
  `storage.runHistoryLocation`.
- Does not make live run storage itself committable; the bundle is the committable form.
- No round-trip fidelity guarantee. Redaction is lossy on purpose, and identity
  is intentionally not preserved.

---

## 8. Phasing

| Phase | Content                                                                                             | Ships value alone?                    |
| ----- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1     | Bundle format, path-rewrite module, `RunBundleExporter`, `ctrlyoke export`, asset reuse via Save As | Yes — produces shareable artifacts    |
| 2     | `RunMaterializer` + bundle importer + `ctrlyoke import`, with the ingress guards in 6               | Yes — completes the loop              |
| 3     | Redaction policy integration (reuse `redactPreviewText` / `SecretRedactionService`)                 | Gate for recommending export publicly |
| 4     | Dashboard export action, import drop target, origin badge                                           | Yes                                   |

Phase 3 is a **release gate on phase 1**, not an enhancement: shipping an export
command that writes unredacted transcripts into repos is worse than shipping
nothing. Ship phase 1 behind the redaction policy or with a blunt scrub, never
without one.

---

## 9. Open questions

1. **Bundle a lineage or a single run?** Proposed: a single run in v1. A
   lineage bundle is a trivial extension of the same format (a directory of run
   bundles plus a shared asset store) once the single-run case is right.
2. **Redaction default.** Refuse to export when the policy is unset, or export
   with a blunt scrub and a loud warning? Proposed: blunt scrub plus warning.
   (`SECRETS_AND_REDACTION_PLAN.md` has since shipped, so the "blunt scrub" is
   simply `redactPreviewText` with heuristics on plus any re-resolvable secrets.)
3. **Chunk events.** Keep `cliOutputChunkAppended` streaming deltas, or collapse
   to the sealed aggregate at export? Proposed: collapse — the deltas are a
   streaming implementation detail and they dominate bundle size.
4. **Workspace snapshots.** `workspaceSnapshotCaptured` payloads can carry file
   contents for undo. Export them (large, and the most likely place for
   unintended content), or drop them and accept display-only imports? Proposed:
   drop by default, `--with-snapshots` to opt in.
5. **Re-import of an already-imported bundle.** New lineage every time, or
   dedupe on `provenance.runRef` + `sourceRoot` and offer "open existing"? Same
   question `HARNESS_SESSION_IMPORT_PLAN.md` open question 2 asks; answer both
   the same way.
