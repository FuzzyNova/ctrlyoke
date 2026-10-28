# Run Export / Import

> Last reviewed against code: 2026-10-26. The status below is accurate; every cited symbol
> exists. Two gaps found in review, now written into §2.1 and §6: the exporter never maps a
> worktree run's execution root to `${workspaceFolder}`, and an importer must write run files
> through the definition anchor (`bcc6c74a1`, `aa2f6117d`), or the imported run loads
> read-only.
>
> **Status:** Export half built 2026-10-18 and shipped in `0.2.0` (`ctrlyoke export`, bundle
> schema 1). Not built: import, **continuing an imported run** (§5, added 2026-10-24), bundling
> workspace changes and assets, and the dashboard UI. Originally written 2026-08-14.
>
> **Built 2026-10-18:** `exportRunBundle` (`src/core/orchestration/RunBundleExporter.ts`), the
> loader `readRunBundle` (`RunBundleReader.ts`, today used only by media replay), the format types
> (`src/types/RunBundleTypes.ts`) and `ctrlyoke export` (see `docs/cli/ctrlyoke.md`). Where it
> differs from the original text:
>
> - **Paths are tokenized, not root-relative** (`src/utils/RunBundlePaths.ts`): the workspace
>   becomes `${workspaceFolder}/…` and the exporter's home `~/…`, matched in every spelling a run
>   contains (either separator, doubled `\\`, any drive-letter case, MSYS `/c/…`, `file:///c%3A/…`,
>   paths after an ANSI escape). The token makes the rewrite reversible at load time; a relative
>   path would be ambiguous inside prose. A home path a shell flattened (`C:Usersalex…`) keeps
>   all but the user name, which becomes `<user>`.
> - **`--run`, not `--from`**, matching `history show/steps`; `--redact <policy>` is not offered,
>   the policy is fixed at `secrets-v1` (heuristics plus re-resolved declared secrets).
> - **The definition is the authored workflow** (`buildAuthoredWorkflow`, shared with
>   `WorkflowSerializer`), so no `_runtime` reaches the bundle. That makes today's bundle
>   _viewable_ but not _continuable_; §5 adds the runtime state as a separate file.
> - **Snapshots are dropped unless `--with-snapshots`** (open question 4, settled as proposed).
> - Export refuses a run whose runner lock is live, and writes through a staging directory and
>   an atomic rename.
>
> **Compatibility (released contract).** Bundle schema 1, the `ctrlyoke export` flags and its
> `--json` envelope have shipped. Everything below extends them **additively**: new optional
> files and `run.json` fields stay within schema 1, so a `0.2.x` reader still loads a bundle
> written by a newer exporter and simply ignores the continuation parts. Bump to schema 2 only
> if a bundle stops being readable as a schema-1 history bundle.
>
> **Problem in one line:** run history is machine-local and (since the user-scoped history
> change) lives outside the repo by default, so there is no supported way to hand someone a run,
> or to stop a run on one machine and finish it on another. `USER_SCOPED_RUN_HISTORY_PLAN.md`
> §2.6.1 rules out the obvious workaround of committing the run-storage directory.
>
> **Relationship to neighbours.** `dev/implemented/USER_SCOPED_RUN_HISTORY_PLAN.md` §2.6.2 names
> this document as the answer it defers to. `HARNESS_SESSION_IMPORT_PLAN.md` (still backlog)
> specifies the run **materializer** this plan's importer reuses: one materializer, two sources.
> `dev/implemented/WORKFLOW_RELATIVE_ASSET_REFS_PLAN.md` listed "making live run storage
> portable" as an explicit non-goal; this is where that gets picked up.

---

## 1. Why a storage setting cannot answer this

`storage.runHistoryLocation: "workspace"` puts run history back inside the repo, and that is
genuinely useful for durability and locality. It is not sharing, for reasons
`USER_SCOPED_RUN_HISTORY_PLAN.md` §2.6.1 works through: a run directory is untracked until
someone commits it, so plain `git clean -fd` still destroys in-flight runs; `runner.json` carries
a live PID that means nothing on another machine; `workflow.json`'s `nextRunId`/`latestRunRef`
conflict on every concurrent run; and `events.jsonl` is raw harness transcript.

The last one is the decisive one. **Storage location is a placement decision; sharing is an
egress decision.** They need different machinery (path rewriting, identity stripping,
redaction, asset bundling) that a location enum cannot express.

The requests this plan serves:

- "Attach the run that produced this bug to the bug report."
- "Commit the run that justifies this PR, next to the PR."
- "Send me the run where the harness went sideways so I can look at it."
- **"I stopped this run on my desktop; finish it on my laptop."** (§5)

None of them want a shared live history. The first three want one immutable, reviewable
artifact. The fourth wants that artifact plus enough state to pick the run back up.

---

## 2. What a run actually is

Verified against current code. Every path below is constructed by `src/utils/WorkflowPaths.ts`
from `runsRoot()`, never assembled by hand.

| Artifact                               | Owner                                         | Export?                                                                                        |
| -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `run-<ts>/workflow.ctrlyoke.json`      | `WorkingFileManager`                          | **Yes**, twice: authored (`buildAuthoredWorkflow`) and, for continuation, with `_runtime` (§5) |
| `run-<ts>/manifest.json`               | `TimelineRecorder` (`WorkflowRunManifest`)    | **Yes**, minus identity fields                                                                 |
| `run-<ts>/events.jsonl`                | `TimelineRecorder.appendEvents`               | **Yes**, the payload, after rewrite + redaction                                                |
| `<lineage>/workflow.json`              | `WorkflowLineageRepository`                   | No: `latestRunRef`/`nextRunId` are per-root allocator state                                    |
| `<lineage>/runner.json`                | lock                                          | **Never**: a live PID                                                                          |
| `<lineage>/draft/`                     | pre-first-run definition                      | No                                                                                             |
| Pre-rewind backup beside the run       | `_runtime.pendingRewind`                      | No: export refuses a run with an uncommitted rewind (§5.2)                                     |
| Referenced attachments / prompt bodies | `<stateRoot>/.ctrlyoke/{attachments,prompts}` | **Yes**, bundled (2.1)                                                                         |
| The checkout's file changes            | git working tree / managed worktree           | **Only for continuation**, as a patch (§5.3)                                                   |
| `.search-index/`, `.usage/`            | derived projections                           | No: rebuilt by the importer's own writes                                                       |

`WorkflowRunManifest` (`src/types/WorkflowTimelineTypes.ts`) carries `schemaVersion`,
`storageKind`, `workflowId`, `runId`, `startedAt`, `completedAt`, `activeExecutionMs`,
`executionState`, `definitionRevision`, `initialDefinition`, `stepCount`, `eventCount`,
`nextSequence`, `lastUpdatedAt` and `tokenTotals`. Everything except the identity survives
export intact.

`events.jsonl` holds the union in `TIMELINE_EVENT_TYPES` (`WorkflowTimelineTypes.ts`), plus three
legacy aggregates retained for read compatibility.

### 2.1 Four things make a run non-portable

**Absolute paths.** Built: `RunBundlePaths` tokenizes them, and `externalPaths` in `run.json`
lists absolute paths the run touched outside the workspace and home.
**Gap (2026-10-26):** `ctrlyoke export` (`src/cli/RunExportCommand.ts`) passes the source
checkout as `workspaceRoot`. A run that executed in a managed or named worktree
(`_runtime.worktree.executionRoot`, by default under `~/.ctrlyoke/worktrees/<identity>/`)
therefore exports its file paths as `~/.ctrlyoke/worktrees/…` or as external absolute
paths, not as `${workspaceFolder}/…`. The exporter should rewrite the run's
`executionRoot` (and its `namedWorkspaceRoots`) to `${workspaceFolder}` as well. This needs
fixing before import (phase 3), and §5.3 depends on it.

**Identity.** `allocateWorkflowKey` guarantees uniqueness only within one runs root. Export
demotes `workflowKey`/`runRef`/`runId` to `provenance`; import allocates fresh ones through the
normal lineage path and records the originals, the same shape as `importedFrom` in
`HARNESS_SESSION_IMPORT_PLAN.md`. Harness session IDs are carried in `provenance.steps` and,
for continuation, in `_runtime`. Whether they still _resolve_ is decided at continue time (§5.4),
never assumed.

**Secrets.** Built: redaction runs at the export boundary and is irreversible by design. The
exporter re-resolves the workflow's declared secrets (a `RunSecretRedactor` only holds values
while its run executes) and runs `redactPreviewText` with those exact values plus heuristics.
`run.json` records `redaction.removedCount` and `byRule`. Continuation adds one requirement: the
redaction summary must say **which file** was touched, because a removal inside a _pending_
step's prompt changes what the importing machine will execute (§5.2).

**Assets.** Not built. Attachments and prompt bodies live in
`<stateRoot>/.ctrlyoke/{attachments,prompts}/`, are gitignored, and stay workspace-scoped. A
bundle without them is a bundle of dangling `@` references, and a continuable bundle without
them runs pending steps against missing files. **Reuse the Save As machinery**:
`analyzeWorkflowBundle` (`src/utils/WorkflowBundleAnalyzer.ts`) discovers references, plans
copies, inlines lone prompt bodies and rewrites refs; `writeWorkflowBundle`
(`src/utils/WorkflowBundleWriter.ts`) stages and publishes them atomically. Do not write a
second asset copier.

---

## 3. Bundle format

A **directory**, not an archive:

```
<name>.ctrlyokerun/
  run.json                 ← bundle manifest (below)
  workflow.ctrlyoke.json   ← authored definition (no _runtime); loadable as an ordinary workflow
  manifest.json            ← WorkflowRunManifest, identity demoted to provenance
  events.jsonl             ← rewritten + redacted timeline, event order preserved
  assets/                  ← bundled attachments, same convention as Save As `*.assets/`
  run.ctrlyoke.json        ← NEW, optional: the working file WITH _runtime (§5.1)
  changes.patch            ← NEW, optional: workspace changes since the base commit (§5.3)
```

Directory-and-JSONL because the point is to put this in a PR, an issue, or a repo. It diffs, it
reviews, it greps. Anyone who wants one file can archive the directory themselves.

Because `workflow.ctrlyoke.json` is a plain authored workflow, **Load Workflow already opens
it**: "start this workflow over on my machine" needs no import at all.

`run.json` (shipped fields abbreviated; new fields are optional and additive):

```jsonc
{
  "schemaVersion": 1,
  "kind": "ctrlyoke.run.bundle",
  "exportedAt": "2026-10-24T18:04:00.000Z",
  "exportedByVersion": "0.3.0",
  "sourceRoot": "~/dev/ctrlyoke",
  "lineage": {
    "workflowName": "Fix tests",
    "originalFile": "${workspaceFolder}/workflows/fix-tests.ctrlyoke.yaml",
  },
  "provenance": {
    "workflowKey": "…",
    "runRef": "run-…",
    "runId": 7,
    "steps": [/* harness, model, sessionId */],
  },
  "includesSnapshots": false,
  "redaction": {
    "policy": "secrets-v1",
    "removedCount": 3,
    "byRule": { "exact-secret": 2, "bearer-token": 1 },
    "byFile": { "events.jsonl": 2, "run.ctrlyoke.json": 1 }, // NEW
  },
  "externalPaths": [],
  "assets": [{ "path": "assets/shot one.png", "sha256": "…", "bytes": 51234 }], // NEW (phase 2)
  // NEW, present only when run.ctrlyoke.json is (§5)
  "continuation": {
    "executionState": "stopped",
    "nextStep": { "kind": "queue", "stepIndex": 3 }, // or { "kind": "finalStep", "pass": 2 }
    "pendingStepCount": 4,
    "worktreeMode": "managed", // none | managed | named
    "workspace": {
      "baseCommit": "3f9c2a1…", // the commit the patch applies to
      "branch": "fix-tests", // informational
      "patch": {
        "file": "changes.patch",
        "sha256": "…",
        "files": 12,
        "binary": 1,
      },
    },
  },
}
```

`sourceRoot` is recorded, not applied: the importer resolves `${workspaceFolder}` against **its
own** workspace and never against the exporter's path.

---

## 4. Export pipeline

`RunBundleExporter` (`src/core/orchestration/`, vscode-free so the CLI and the extension share
it). Steps 1, 2, 4, 5 and 6 are built.

1. **Resolve the run** and refuse one whose lineage holds a live `runner.json`. _Built._
   Continuation adds: refuse a run with `_runtime.pendingRewind` (commit or discard the rewind
   first), and refuse states `pausing`/`cancelling` (transient; the lock check normally catches
   them).
2. **Read** through `TimelineRecorder.streamEvents`. _Built._
3. **Plan assets** with `analyzeWorkflowBundle`; surface its diagnostics as export warnings. A
   missing attachment is reported, not silently dropped. _Not built._
4. **Rewrite** paths. _Built._
5. **Redact.** _Built._ Add the per-file breakdown.
6. **Write atomically** through a staging sibling and a rename. _Built._
7. **NEW, continuation only:** write `run.ctrlyoke.json` and `changes.patch` (§5.1, §5.3).

Whether a bundle is continuable is **derived, not chosen**: the exporter writes the continuation
parts whenever the run has pending work (`assertRunHasWorkToContinue` in
`RunContinuationService.ts` says yes) and the run is `stopped`, `paused` or `error`. A completed
run gets a history-only bundle. One format, one exporter, no "export kind" to pick.

CLI (additive to the shipped command):

```
ctrlyoke export -w <workflow> [--run <ref|runId>] -o <dir> [--with-snapshots] [--no-changes] [--force] [--json]
ctrlyoke import <bundleDir> [--continue] [--json]
```

`--no-changes` skips `changes.patch` (for a run whose changes the user syncs through git
themselves). The `export` description changes from "one finished run" to "one settled run";
the `--json` envelope gains `continuable` and `continuation`.

---

## 5. Continuing an imported run

**Goal:** stop a run on machine A, export it, import it on machine B (or into another checkout on
A), press Continue, and have it behave as if it had never moved. Where something cannot move (a
harness session that only exists on A), the run continues degraded and **says so**. It never
fails silently, and it never continues against a workspace that doesn't hold the earlier steps'
work.

### 5.1 Runtime state: `run.ctrlyoke.json`

The working file with its `_runtime` blocks, through the same path rewrite and redaction as
everything else. This is what `continue` already reads: `currentIndex`, `executionState`,
per-step terminal status and session IDs, `finalStep` pass state, `activeParallelGroup`
admission, appended steps and their authorship. It is a separate file from
`workflow.ctrlyoke.json` so the shipped authored definition stays exactly as it is (Load Workflow
and schema-1 readers keep working) and a reviewer can see the run state on its own.

On import, the root `_runtime` is normalized, not trusted:

- `executionState` becomes `stopped` (a `paused` run continues the same way); timing fields are
  kept so `activeExecutionMs` stays truthful.
- `worktree` is **dropped** and rebuilt by §5.3. It is full of the exporter's absolute paths and
  branch state.
- `stopReason`, `worktreeNotice` and `pendingRewind` are dropped (export refused the last one
  anyway).
- A new optional `_runtime.importedFrom` records the bundle's `provenance`, `exportedAt`,
  `exportedByVersion` and `sourceRoot`. It is additive in the run-file format, so no
  `schemaVersion` bump is needed; older ctrlyoke ignores it.

### 5.2 The importing machine must hold what the run will execute

A continuable bundle is a **workflow that will run** on the importing machine, not just a
document. Everything §6 says about untrusted input applies, plus:

- **Import never auto-continues.** `--continue` on the CLI and the Continue button after the
  import preview are the only triggers.
- The **preview** lists every pending step with what it will run: prompt, script steps and
  pre/end-condition scripts, `additionalArgs`, MCP servers, secret grants, and the harness/model
  each step **will resolve to on this machine** next to what the run used before. Settings
  differ between machines, so a pending step that inherited `claude-cli` on A may resolve
  differently on B.
- If redaction removed anything from `run.ctrlyoke.json` (`redaction.byFile`), the preview flags
  the affected pending steps: their prompt text is no longer what A would have sent.
- Secret grants follow the normal rule: a grant not approved for this workspace stops the
  workflow at that step. The preview names them up front so the stop isn't a surprise.
- Missing bundled assets (phase 2) block Continue for the steps that reference them.

### 5.3 Workspace changes: `changes.patch`

This is the gap the original plan did not have to face. A history bundle only describes edits;
a continued run needs them **on disk**. Step 4 on machine B assumes steps 1–3 already edited the
checkout. ctrlyoke must not copy files around ad hoc, so carry the changes git-natively:

- **Export** records `baseCommit` (the run's worktree `baseCommit` for a managed or named
  worktree, otherwise `HEAD` of the checkout) and writes `git diff --binary <baseCommit>` of the
  working tree, untracked files included (respecting `.gitignore`), as `changes.patch`. A diff
  from the base commit to the working tree covers both commits made during the run and
  uncommitted edits, so it doesn't matter whether steps committed. Commit history isn't
  preserved, only the tree, and that is enough to continue.
- The patch goes through the **same redaction pass** (it is file contents leaving the machine),
  and the export summary shows its file count before anything is shared. `--no-changes` skips it.
- **Import** requires `baseCommit` to exist locally (`git cat-file -e`). If it doesn't, the user
  is told exactly what to do ("push/fetch commit 3f9c2a1"), and the run imports as view-only
  until they do.
- **Where the patch lands** depends on the run's `worktreeMode`:
  - `managed`: create a **new managed worktree** at `baseCommit` through `WorktreeManager` and
    apply the patch there. The user's checkout is never touched, so this is the safe default.
  - `none`: apply to the current checkout only if it is clean and at `baseCommit`. If it isn't,
    the preview offers "Continue in a managed worktree instead" or "I've synced the code myself"
    (skip the patch; ctrlyoke compares the tree to the patch and warns on mismatch).
  - `named`: the user picks the target checkout. Apply the same clean-at-base check.
- `git apply --index --3way`; on any rejection nothing is half-applied, and the run stays
  view-only.

Same-machine moves (from a worktree checkout back to the main checkout, say) use the same path.
The patch just happens to be local.

### 5.4 Harness sessions: resolve, else start fresh and warn

Session IDs survive in `_runtime` exactly as recorded. Whether one still resolves depends on the
harness, and "same machine" is not a sufficient test. Claude keys its session store by project
directory, so even on machine A a run imported into a different checkout path may not find its
Claude sessions, while Codex and Copilot keep a per-user store.

Today, `SessionResolver.resolveWithProperties` picks the session (`resumeSession` auto-chaining,
numeric `sessionId`, `"finalStep"`, or a literal ID) and `SessionValidator` checks only its
**format**. When a resume is rejected at runtime, only `claude-cli` and `qwen-cli` implement
`isRecoverableSessionError` (`CliExecutionRunner` retries without the resume flag); the other
four harnesses just fail the step. A vanished session is rare in a native run, but in an
imported one it's the expected case.

**Decision (2026-10-24): a missing session is handled the same way in every run, imported or
not. ctrlyoke warns and starts a new session. It never adds context on the user's behalf.**
Rejected: automatically injecting the earlier steps' output as `priorContext`. To do it
correctly ctrlyoke would have to work out every executed step that ran in the missing session.
If steps 1, 3 and 7 shared one session and step 9 resumes it, the right context is
`$step:1,3,7`, not just the step that `sessionId` names. ctrlyoke can compute that, but it would
silently change what the step sends, in a way native runs never do. A step that quietly behaves
differently after a move is the surprise to avoid. A predictable warning is better.

**One rule for every way of naming a session (decided 2026-10-24).** Auto-chaining
(`resumeSession` with no `sessionId`), a step number, `"finalStep"` and an exact ID all behave the
same: if the session can't be resumed on this machine, warn and start a new session. Considered
and rejected: stopping the workflow when an _exact_ ID is missing, on the grounds that a
hand-pinned ID is deliberate. In practice most exact IDs aren't hand-pinned: **Reply to Step**
(`dev/implemented/REPLY_TO_STEP_PLAN.md` §6) writes the concrete session ID of the replied-to step
into the new step. "Reply to step 2 from step 4, then move the run before step 4 runs" is a
normal flow, and it should warn rather than block. One rule also keeps the mental model small
while the product is new. If users turn out to rely on pinned IDs failing loudly, add an opt-in
setting to make a missing session an error. That is additive, so it can come later.

**Badly formatted IDs follow the same rule.** Today `CliSessionResolverAdapter` drops an ID that
fails `SessionValidator.validate` with only a `Log.info` line and starts a new session, so the
user never learns the step didn't resume anything. It gets the same warning as a missing session,
with its own reason ("…is not a valid claude-cli session ID"), recorded and shown the same way.

- **One fallback for every run.** Today the fallback depends on the harness (Claude/Qwen recover,
  the other four fail), so "same as native" first means making native behavior uniform:
  - **Preflight probe.** Add an optional `probeResumableSession(sessionId, workspaceRoot)` to
    `ICliProvider`, returning `available | missing | unknown`. It's backed by each log parser's
    existing session-store lookup, but **by ID only**: `discoverSessionLog` falls back to
    prompt-text matching when the ID isn't found, and that fallback must not count as "found".
  - **Where it runs:** in `CliSessionResolverAdapter.resolve`, for **every** resolved resume,
    not only imported runs. It's a lookup in the local session store, cheap next to a harness
    launch. There's no import special case to keep in sync.
  - **`unknown`** (a harness whose store can't be probed) is treated as available and left to
    the runtime path. Extend `isRecoverableSessionError` to each remaining provider whose CLI
    prints a recognizable "session not found" error, so the runtime path ends in the same
    fallback instead of a failed step.
- **On `missing`:** start a new session, record a `statusMessageRecorded` warning on the timeline
  ("Step 9 could not resume the claude-cli session from step 7; it was not found on this machine.
  Started a new session."), and show it in the step's output. Later steps that resume
  automatically chain onto the new session, as they do natively.
- **The import preview shows the impact before anything runs.** It runs the same probe for every
  pending step, so the user sees "Steps 9 and 11 will start a new session: the sessions they
  resume are not on this machine" **before** pressing Continue. For each affected step it lists
  the executed steps that ran in that session (1, 3, 7), so the workaround below is copy-paste.
  For an exact ID this means the executed steps whose `_runtime.sessionId` equals it. That
  covers Reply to Step ("step 4 replies to step 2's session, which isn't on this machine; use
  `priorContext` instead"). An exact ID that no executed step produced is reported as "not from
  this run". Badly formatted IDs are listed too. The preview doesn't change anything; it only
  informs.
- **Documented workaround** (in the export/import guide page, phase 6): when a run moves to
  another machine, any pending step that continues an earlier step's conversation starts fresh
  instead. Before continuing, either accept that, or give the step that context explicitly. Set
  its `priorContext` to the steps the preview listed (`[1, 3, 7]`, or `$step:1,3,7` in the
  prompt) and optionally remove its `sessionId` / set `resumeSession: false`. Pending steps are
  editable in the imported run like in any stopped run. Call out Reply to Step: it sets
  `priorContext` to an explicit None (its §3), so a reply step needs that changed, not just
  added.
- **Changelog (Changed), when phase 5 ships:** a resume whose session can't be found, or whose ID
  is badly formatted, now warns and starts a new session on every harness. Before, Copilot,
  Codex, opencode and Antigravity failed the step, and Claude/Qwen and badly formatted IDs started
  a new session without telling the user.
- **Possible follow-up, not planned:** if users ask for it, the preview could offer an explicit
  per-step _Add earlier output as context_ button that makes exactly that edit, visibly, in the
  step definition. It would be user-initiated and show up in the definition, unlike the rejected
  automatic version. The step list it needs is already computed for the preview.

### 5.5 Undo and snapshots across the move

Steps executed **after** import capture snapshots and undo normally; they are native. Steps
executed **before** import are display-only: their snapshots are dropped by default, and when
`--with-snapshots` kept them, undo stays gated as §6 describes. The recorded
`workingDirectory` of every imported output is recomputed to the importing workspace (or the
new managed worktree) on materialization, never taken from the bundle.

### 5.6 What lands in history

The import is a **new lineage** with a fresh `workflowKey`/`runRef` (default name: the bundle's
`workflowName`). Its run carries `importedFrom` and renders with the origin badge (§6). Imported
events keep their order and are re-stamped with the new identity, continuing from the bundle
manifest's `nextSequence`. Events appended after import are ordinary. From then on it is a normal
run: `continue`, `append`, `rerun` and export all work, and exporting it again (A → B → A)
produces a bundle whose `importedFrom` chain shows where it has been.

---

## 6. Import pipeline: the same materializer, a second source

`HARNESS_SESSION_IMPORT_PLAN.md` §"Import pipeline" already specifies materializing a synthetic
run: allocate the lineage and run directory, `OutputHistoryManager.initializeRunAt(…)`, append
events, then `finalizeRun`. **Factor that into one `RunMaterializer` with two callers:**

| Source                       | Produces                                                      |
| ---------------------------- | ------------------------------------------------------------- |
| Native harness session log   | turns → synthesized definition + events                       |
| ctrlyoke run bundle (`this`) | definition + events, plus runtime state when continuable (§5) |

The bundle path is strictly simpler (no turn segmentation, no per-harness parsing), so build the
materializer once with the bundle importer as its first consumer.

Import steps: validate → allocate identity → resolve `${workspaceFolder}` onto the importing
workspace (`readRunBundle`, built) → materialize history → **if continuable:** normalize
`_runtime` (§5.1), place workspace changes (§5.3), write the run file, leave it `stopped` → record
provenance → refresh the search index (already a side effect of the history writes).

**Write through the definition anchor.** Since `bcc6c74a1`/`aa2f6117d`, every legitimate
writer of a run's `workflow.ctrlyoke.json` records an anchor under the user state home
(`writeAnchoredRunDefinition` in `src/utils/RunDefinitionAnchor.ts`). Once a run storage
holds a baseline marker, a working file with no anchor counts as _unrecorded_: it loads
read-only and its writes are refused. The materializer must create the imported run's
working file through `writeAnchoredRunDefinition` (the normal `WorkingFileManager` write
path), never with a plain `fs.writeFile`. Otherwise every import shows the "changed outside
ctrlyoke" banner and cannot be continued.

`readRunBundle` returns every event in memory (fine for media replay). The importer should
stream `events.jsonl` into `TimelineRecorder.appendEvents` in batches instead.

### 6.1 Security: a bundle is untrusted input

Export is an egress decision; **import is an ingress one**, and the ingress side is the sharper
risk. A continuable bundle raises it further: it is effectively a workflow file from someone
else, with scripts.

- **Validate before touching disk.** Reject an unknown `kind` or a newer `schemaVersion` (built).
  Cap total bytes, event count and per-event payload size (per-file cap built). Check
  `changes.patch` and asset `sha256` against `run.json`.
- **Contain every path.** Asset paths, patch targets and rewritten references must resolve
  inside the bundle directory / importing workspace or the new worktree. Use
  `isPathWithinDirectory` (`src/utils/PathSecurity.ts`). `git apply` already refuses paths
  outside the tree, but check before calling it anyway.
- **Never restore `workingDirectory` from a bundle.** `WorkspaceSnapshotService.undoFiles`
  guards undo writes against `workspacePath`, and the webview derives that from an output's
  recorded `workingDirectory` (`useOutputUndoActions.ts`). A bundle that sets it chooses where
  "undo" writes. Recompute it on materialization and gate undo on the resolved workspace.
- **Pre-import steps are read-only.** Display, search and browse fully; undo/apply on them is off
  unless the user explicitly enables it for a bundle whose paths resolve inside the open
  workspace.
- **Show the provenance.** An imported run renders with an origin badge (shared with the
  harness-session import badge) naming the bundle, its `sourceRoot` and `exportedAt`.
- **Nothing executes on import** (§5.2).

---

## 7. Dashboard surface, next to Save/Load but not inside it

**Decision: separate actions, placed beside Save and Load, sharing their dialog parts. No
"include runtime state" toggle on the Save dialog.**

Why not a toggle on Save:

- **Different artifacts.** Save writes one authored, schema-validated `.ctrlyoke.{yaml,json}`
  that Load opens as a draft, the editor lints, and people edit and commit. Export writes a
  directory of history, run state and possibly a code patch. A toggle would make Save's output
  sometimes not openable by Load. That would be the confusing part.
- **Different trust posture.** Save/Load moves your own definition around. Export is an egress
  decision (redaction summary, patch file count, external paths to review before sharing).
  Import is ingress (untrusted input, preview before anything runs). Neither belongs behind a
  checkbox in a dialog whose job is "pick a file name".
- **Different scope.** Save works on any workflow, including a draft. Export works on a
  **run**, and continuation on a settled run with pending work.

How they work together instead:

- **Placement (revised 2026-10-28). Neither action gets a header button.** The header is
  already crowded (the narrow-mobile row 2 repeats Save · Undo/Redo · Search · Settings), and
  both actions are rare. The slot the Dry Run button gave up stays empty: Dry Run moved into the
  workflow context menu (below) and is still on the Run button's right-click menu.
  - _Export Run…_ goes in the **workflow context menu** (`useWorkflowContextMenu.tsx`). That one
    menu opens from the header's workflow name (`WorkflowStatus`), the history list rows, the
    run panel rows and the running items, so a single entry covers the header and the per-run
    history menu. Gate it on the target being a `run` address (not a draft) that isn't executing.
    It can export any listed run, not only the displayed one, because export reads the run from
    disk by address. Dry Run can't do that: it previews the client's displayed workflow plus the
    unsaved editor. (An earlier draft named `useWorkflowFileMenuItems.ts`, but that builds the
    Run/Load/Queue entries for workflow _files_ in the workspace explorer and editor menus, not
    a run menu.)
  - _Import Run…_ goes in the **New** split button's dropdown (`WorkflowControls.tsx`), right
    after _Load from File…_. Like Load, it creates a new lineage, so it belongs with Load. The
    harness-session import entry goes beside it once that plan adds one. In the hosted browser it
    goes through `WorkflowFilePickerModal` the way Load does (a directory picker mode).
  - If testing shows Export is hard to find, make the header **Save** button a split button
    (_Save Workflow…_ / _Export Run…_) instead of adding a button. That keeps the two side by
    side without using more header width.
- **Load routes bundles.** When Load Workflow is pointed at a `.ctrlyokerun` directory, it offers
  "Import this run (continue where it stopped)" or "Load its workflow only (start over)". The
  second is just a Load of the bundle's `workflow.ctrlyoke.json`. Users who reach for Load still
  land in the right place, and the pipelines stay separate.
- **Shared parts, not a shared dialog.** Extract the location/name/browse fields from
  `SaveWorkflowDialog.tsx` (including its `selectWorkspacePath` capability branch between the
  native folder picker and the hosted `FileBrowserModal`) into a component that both Save and
  Export use. Export adds its own sections: _what's included_ (history; run state and changes
  when continuable, with the patch's file count; snapshots off), and the redaction summary
  shown after the export, before the user shares the result.
- **Import preview** is its own modal: provenance, base-commit check, where the changes will
  land (§5.3), per-step session availability (§5.4) with the steps each missing session covered, pending
  steps with scripts called out, secret grants. It has two buttons: _Import_ (view-only, still
  continuable later) and _Import and Continue_.

---

## 8. Non-goals

- Not a sync mechanism, and not shared live history. A bundle is a snapshot; continuing it
  forks the run onto the importing machine. The original on machine A is untouched and nothing
  reconciles the two.
- Does not change where run history is stored; orthogonal to `storage.runHistoryLocation`.
- Does not make live run storage itself committable; the bundle is the committable form.
- No round-trip fidelity guarantee. Redaction is lossy on purpose, identity is intentionally not
  preserved, and git commit history inside the run isn't carried (only the resulting tree).
- Does not move harness sessions. Session logs belong to each harness's own store and can carry
  far more than ctrlyoke redacts. §5.4 degrades gracefully instead.

---

## 9. Phasing

| Phase | Content                                                                                                      | Ships value alone?                         |
| ----- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 1 ✅  | Bundle format, path rewrite, `RunBundleExporter`, `ctrlyoke export`, redaction (`secrets-v1`)                | Yes: shareable artifacts (shipped `0.2.0`) |
| 2     | Asset bundling via the Save As machinery; `redaction.byFile`                                                 | Yes: bundles stop dangling `@` refs        |
| 3     | `RunMaterializer` + `ctrlyoke import` (view-only), ingress guards (§6.1), origin badge                       | Yes: completes the share loop              |
| 4     | Continuation: `run.ctrlyoke.json`, `changes.patch`, `_runtime` normalization, `import --continue`            | Yes: the machine-to-machine handoff        |
| 5     | Session preflight probe for all runs, uniform warn-and-start-fresh fallback, malformed IDs included (§5.4)   | Yes: fixes native runs too                 |
| 6     | Dashboard: Export Run / Import Run actions, shared location fields, Load routing, import preview, guide page | Yes                                        |

Phase 5 is a **release gate on phase 4**, the way redaction was on phase 1: without it, four of
six harnesses fail the first step that tries to resume a session from the other machine. It has
no dependency on the import work, so it can land first. A native run whose harness session was
cleaned up benefits the same way.

---

## 10. Open questions

1. **Bundle a lineage or a single run?** Settled: a single run. A lineage bundle is a directory of
   run bundles plus a shared asset store, if ever wanted.
2. **Redaction default.** Settled: always on (`secrets-v1`); no opt-out.
3. **Chunk events.** Keep `cliOutputChunkAppended` streaming deltas, or collapse to the sealed
   aggregate at export? Proposed: collapse. The deltas are a streaming implementation detail
   and dominate bundle size. Still open: the shipped exporter copies them as-is.
4. **Workspace snapshots.** Settled: dropped by default, `--with-snapshots` to opt in.
5. **Re-import of an already-imported bundle.** Settled 2026-10-24: detect (match on
   `provenance.runRef` + `sourceRoot` + `exportedAt`) and offer "open the existing import", with
   "import again" as the explicit second choice. Importing the same bundle twice and continuing
   both would fork the work twice. Answer `HARNESS_SESSION_IMPORT_PLAN.md` open question 2 the
   same way.
6. **Missing-session default (§5.4).** Settled 2026-10-24: warn and start a new session, the
   same in every run and for every way of naming the session (auto, step number, `"finalStep"`,
   exact ID), and for badly formatted IDs too. No automatic context injection, and no error for
   missing exact IDs (Reply to Step writes them). The preview and docs point to `priorContext`
   as the manual fix. An opt-in "error on missing session" setting is a possible later addition.
7. **Uncommitted changes on export when the run is `none`-mode in a dirty checkout.** Settled
   2026-10-24: include them (the run may have depended on them). The export summary lists every
   file in the patch so the user can cancel before sharing.
8. **Exporting a run that is `stopped` mid-step.** The in-flight step re-runs from its start on
   continue (as it does natively), but on another machine its partial edits are in the patch.
   Proposed: same as native; the step's retry sees a partially edited tree either way.
