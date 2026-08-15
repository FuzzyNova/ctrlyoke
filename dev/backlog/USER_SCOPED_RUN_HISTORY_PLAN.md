# User-Scoped Run History

> **Status:** Implementation-ready — not implemented. Written and code-audited
> 2026-08-13.
>
> **Problem in one line:** `git clean -fdx` is routine repo hygiene and it
> permanently destroys every ctrlyoke run in the workspace, because `.ctrlyoke/.runs/`
> is gitignored and `-x` exists precisely to delete ignored files.
>
> **Pre-release, so no compatibility work.** No installed base, no customers, one
> developer. New code reads the new location and nothing reads the old one — no
> read-through fallback, no first-load migration prompt, no deprecation window.
> The author's own repositories are handled by a throwaway script (5.3).

---

## 1. Can this be fixed without moving anything?

No. This was tested rather than assumed, in a throwaway repo with
`.ctrlyoke/.runs/` listed in `.gitignore`:

| Command           | Result for `.ctrlyoke/.runs/`                         |
| ----------------- | ----------------------------------------------------- |
| `git clean -fd`   | **Survives** — ignored files are skipped without `-x` |
| `git clean -fdx`  | **Deleted** — "Removing .ctrlyoke/.runs"              |
| `git clean -ffdx` | Deleted, along with everything else                   |

`-x` means "also remove ignored files." There is no `.gitignore` syntax, no
negation pattern, and no persistent Git config that exempts a path from it —
`.gitignore` is the very list `-x` overrides, so making the entry "stronger"
makes no difference. `git clean -e <pattern>` can exclude per invocation, but it
must be typed every time, which is exactly the muscle memory that fails.

One trick does survive `-fdx`: `git clean` refuses to descend into a directory
containing its own `.git`, printing `Skipping repository .ctrlyoke/.runs2`.
Verified. **Reject it anyway.** It survives `-fdx` but not `-ffdx` (also
verified), it plants a fake repository inside the user's repo, and it would
confuse every tool that walks the tree. Building durability on a safety
interlock that a second `-f` disables is not durability.

**Conclusion: run history must leave the workspace.** The rest of this document
is how.

---

## 2. What actually has to move

`WORKSPACE_INITIALIZER_RUNTIME_ENTRIES` in
`src/core/orchestration/WorkspaceInitializer.ts:21-32` is the authoritative list
of what ctrlyoke gitignores, and therefore the exact list of what `git clean -fdx`
destroys. Auditing it turns up **three** categories, not one. Two entries that
look misplaced (`attachments/` and `prompts/`) are deliberate; see 2.3.

| Entry               | Nature                            | Verdict                                                       |
| ------------------- | --------------------------------- | ------------------------------------------------------------- |
| `.runs/`            | project-derived                   | **Move** → project dir                                        |
| `.search-index/`    | project-derived (indexes `.runs`) | **Move** → project dir                                        |
| `.usage/`           | **mixed** — see 2.1               | **Split**                                                     |
| `notifications/`    | browser-push keys/subscriptions   | **Move** → user scope                                         |
| `certs/`            | machine state                     | **No change** — already user-default; retain workspace opt-in |
| `attachments/`      | ephemeral-run assets              | **Stay**, ignored — see 2.3                                   |
| `prompts/`          | ephemeral-run prompt bodies       | **Stay**, ignored — see 2.3                                   |
| `logs/`             | disposable diagnostics            | **Stay**, ignored — see 2.4                                   |
| `temp/`             | ephemeral by design               | **Stay**, ignored                                             |
| `capabilities.json` | regenerated each activation       | **Stay**, ignored                                             |

Not in the ignore list and not at risk: `workflows/`, `templates/`, `skills/`,
`agents/`, `scripts/`, `mcp/`, `settings.json` — authored and tracked already.

Two other uses of “snapshot” are unrelated to `.usage/provider-snapshots.json`:

- `.ctrlyoke/snapshots/` contains dev-only UX-capture Markdown created by
  `UxSnapshotButton`/`DevCommands`. It stays in the workspace and remains outside
  this plan; `WorkspaceInitializer` deliberately does not add it to generated
  user workspaces.
- `WorkspaceSnapshotService` captures before/after file state for undo. It has no
  snapshot storage directory: the resulting `WorkspaceSnapshot` is persisted in
  the run timeline's `events.jsonl`, so it follows `.runs/` automatically. Undo
  still restores files in the execution workspace.

### 2.1 `.usage/` is three files with three different scopes

The instinct that usage "should be global anyway" is right for part of it and
wrong for the rest. `src/utils/UsagePaths.ts` defines three files:

- **`lifetime-stats.json`** (`LifetimeUsageStore`) — keyed
  `lineages: Record<WorkflowKey, …>` and rebuilt by walking `runsRoot`. It cannot
  go global: `allocateWorkflowKey` only guarantees uniqueness _within one runs
  root_, so two projects can each hold a `fix-tests-2026-08-01T…` key and a
  shared file would silently merge them. **Project dir**, beside the `.runs` it
  summarizes.
- **`observed-usage.json`** (`ObservedHarnessUsageStore`) — `runs` is keyed by
  `{workflowKey, runRef}`, same argument. **Project dir.** Its `buckets`
  (daily/weekly/monthly per harness) _are_ an account-level question, and today
  they are quietly wrong: "tokens I burned on Claude this week" is currently
  split across one file per workspace, each holding a fraction. Once every
  project lives under one root, the correct total is a fold over
  `~/.ctrlyoke/projects/*/.usage/observed-usage.json` — a read-side change, not
  a storage one.
- **`provider-snapshots.json`** (`HarnessUsageService.ts:185`) — a cache of
  provider-reported **account quota windows** (`HarnessQuotaSnapshot`: harness,
  source, fetch/staleness timestamps, reset windows, and plan type). “Snapshot”
  here means a point-in-time usage/quota reading; it is unrelated to UX snapshots
  and undo snapshots. This file has **zero** project derivation. A Claude Pro
  quota is not per-workspace; storing it per-workspace means N copies of one
  account-level truth, each stale in a different way, each wiped by `git clean`.
  **True user scope: `~/.ctrlyoke/usage/provider-snapshots.json`.** Going global means several
  VS Code windows write one file. `HarnessUsageService.persistProviderSnapshots`
  (line 422) already prevents corrupt interleaved writes with `withFileLock` and
  an atomic rename, but it writes the process's entire in-memory map and can still
  overwrite a newer snapshot written by another process. Under the existing lock,
  re-read the shared file and merge per harness by newest `fetchedAt` before
  writing. Cross-process provider-call deduplication is a separate optimization;
  the current in-memory `refreshPromises` map does not provide it, so do not claim
  the scope move eliminates duplicate refresh calls.

### 2.2 `notifications/` must move; `certs/` is already user-default

`WebPushService.ts:76-88` stores the VAPID keypair and the push-subscription
registry under the workspace. Neither is project-scoped: the VAPID keypair is
the identity of _this user's_ push sender, and losing it invalidates every
existing subscription — every phone and browser must re-subscribe, with no error
message explaining why notifications went quiet. `git clean -fdx` in any repo
does this today. **Move to `~/.ctrlyoke/notifications/`.**

This move is **browser push only**. `PATH_CONSTANTS.NOTIFICATIONS_DIR` is consumed
by `WebPushService` for `vapid-keys.json` and `push-subscriptions.json`; it is not
the hook handoff location. Harness start/stop/tool hook monitors continue using
`<stateRoot>/.ctrlyoke/temp/<harness>-notifications/` through
`CliNotificationMonitor`, and `.ctrlyoke/temp/` remains workspace-scoped and
gitignored. VS Code toast notification settings/events also remain configuration
and in-memory delivery behavior, not files under `notifications/`.

This scope change creates a concurrency requirement that does not exist today.
`WebPushService.operationQueue` serializes one server instance only; two VS Code
windows will share the files after the move. Put both VAPID-key creation and
subscription read-modify-write operations behind `withFileLock`, retaining the
atomic temp-file rename. The key-generation lock is essential: two first-time
servers must not return different public keys and then race to persist one of
them. Use distinct locks per file so an outbound send does not block an
unrelated public-key read.

`certs/` holds the self-signed TLS cert for the hosted dashboard. Regenerating it
means re-accepting the certificate warning on every device that had trusted it.
The implementation-readiness audit confirmed this is already solved:

- `GlobalSettingsDrawer` initializes its shared scope toggle to `user`;
- `ServerSection.handleGenerateCert` sends that currently selected scope; and
- `WebviewSettingsSync.handleGenerateServerCert` writes both `cert.pem`/`key.pem`
  and `server.tls.certPath`/`keyPath` to the selected user or workspace scope.

Therefore there is **no certificate storage change in this plan**. Preserve the
current user default and explicit workspace option. Keep `certs/` in the
workspace runtime ignore/landing guard because a user who deliberately selects
Workspace still creates `<stateRoot>/.ctrlyoke/certs/`. Existing workspace certs
are neither moved nor rewritten. Existing `WebviewSettingsSync.test.ts` coverage
already asserts both the user and workspace branches.

### 2.3 `attachments/` and `prompts/` stay ignored — but two comments claim otherwise

These two look misfiled and are not. `dev/implemented/WORKFLOW_PORTABILITY_PLAN.md`
settled it deliberately, and its ledger step 12 ("Missing-assets warning, ignore
entries, docs") is `done` — the entries are the _last_ step of a shipped design,
not an oversight.

The reasoning there is worth restating because it is exactly what makes the
`git clean` question different for these two directories. Both stores serve two
populations at once: files referenced from an **ephemeral run** under `.runs/`
(pasted debug screenshots, prompts composed in the dashboard) and files
referenced from a **durable, committed workflow**. No single ignore rule can
serve both, so the split is made by lifecycle instead: everything in the
generated stores is ephemeral, and **Save As** is the one operation that promotes
work to durable — copying attachments into a tracked sibling
`<workflow>.assets/`, inlining lone prompt-file bodies, and rewriting the
references (`WorkflowBundleAnalyzer.ts` plus the bundle writer, steps 5–7,
all `done`).

So there is no dangling-reference bug: a committed workflow's dependencies live
in `*.assets/`, which is tracked, and `git clean -fdx` does not touch tracked
files. What it deletes here is ephemeral-run scratch, which is the intent.

**Separately, and more decisively for this document: they cannot move either.**
Both stores hold files that are `@`-referenced into prompts and therefore read
_by the harness_, and harnesses sandbox to the workspace. A user-scoped
`~/.ctrlyoke/attachments/` would need a per-harness escape hatch to be readable
at all — Claude Code's `--add-dir`, and an equivalent for each of the other five
— turning a pasted screenshot into a permissions problem. Run history has no
such constraint: ctrlyoke reads it itself and projects it into the prompt, so
nothing about it needs to be inside the sandbox. That asymmetry is the reason
`.runs/` can move and these two cannot, and it holds regardless of how the
tracking question is settled.

**What is genuinely wrong is two stale code comments** that still assert the
pre-step-12 policy:

- `TempFileManager.getAttachmentsDir()` — "It is a sibling of `temp/` and
  intentionally **not** gitignored, so committing the workflow file alongside
  this folder is enough to share both."
- `ConfigurationUtils.ts` `ATTACHMENTS_DIR` — "Committed, un-gitignored home for
  pasted images belonging to saved workflows."

Both describe the opposite of shipped behavior, and both sit at exactly the spot
a reader looks to answer "should this be tracked?" — this document's first draft
took them at face value and proposed reversing a deliberate decision. Correct
them to point at the Save-As bundling contract. That is the whole fix here; it is
a comment change, not a policy change.

The one real residual gap is already decided in that plan's §8.4: adding a _new_
screenshot to an already-committed workflow lands ignored until the workflow is
re-saved. Covered by a release note, deliberately not by code.

### 2.4 `logs/` should stay

Tempting, but no — for three reasons:

1. Losing them costs nothing. They are diagnostics for a problem you are
   actively debugging, not a record you return to months later.
2. The durable thing you actually want after the fact is the run's own
   `events.jsonl`, which already lives in `.runs/` and therefore already moves.
3. The cost is real. `src/scripts/ctrlyoke-hook-utils.js` derives the logs
   directory _positionally_ — it walks up two levels from the notify directory to
   reach `.ctrlyoke/` and appends `logs/`. Those scripts are spawned by external
   harness CLIs with the workspace as cwd. Moving logs means threading a new
   absolute path into every `src/scripts/ctrlyoke-*-hook.js`, plus rewriting the
   debugging section of `.github/copilot-instructions.md` that sends people to
   `.ctrlyoke/logs/`.

Real plumbing cost, zero durability benefit. Leave them.

### 2.5 Resulting move set

Three scope outcomes, with the two move units cleanly separable:

- **Project-derived** → `~/.ctrlyoke/projects/<key>/`: `.runs/`,
  `.search-index/`, `.usage/{lifetime-stats,observed-usage}.json`. These are
  three projections of one run corpus and must never diverge — they move together
  or not at all.
- **Account/machine** → `~/.ctrlyoke/`: `notifications/` and
  `usage/provider-snapshots.json`. Independent of the above; ships on its own.
  Note this _strengthens_ the "secrets, hard rule" line in
  `WORKFLOW_PORTABILITY_PLAN.md` §2 rather than relaxing it — a private key that
  lives outside the repo cannot be committed by an edited `.gitignore` at all.
- **Workspace runtime** → stays under `<stateRoot>/.ctrlyoke/`: `attachments/`,
  `prompts/`, `logs/`, `temp/`, and `capabilities.json`.

Nothing gets un-ignored. `attachments/` and `prompts/` stay exactly as they are
(2.3).

### 2.6 The `.gitignore` dial stops being able to answer "commit my runs"

`WORKFLOW_PORTABILITY_PLAN.md` §1 promises "how much is ignored is a dial, not a
fixed setting… someone who wants their runs in source control edits
`.ctrlyoke/.gitignore`," and its §7 draft docs say it to users outright:
"**Want your runs committed instead?** Edit `.ctrlyoke/.gitignore` and remove the
lines you want tracked."

After this change that is simply false. Un-ignoring `.runs/` does nothing,
because there is no longer a `.runs/` in the workspace to track. The dial still
works for what remains in the workspace — `attachments/`, `prompts/`, `logs/`,
`temp/` — but the headline use case it was documented for is gone. An affordance
users were explicitly pointed at going silently inert is the worst version of
this; it has to be replaced in the same release, not left to be discovered.

**`storage.runHistoryLocation` (5.4) is the replacement — but it is a
_durability and locality_ control, not a sharing mechanism, and the docs must
not promise otherwise.** The `.gitignore` dial only ever chose whether to
_track_ runs that were already in the workspace; the setting chooses where they
_live_. `"workspace"` restores the precondition for tracking (a `.runs/` inside
the repo) without being sufficient for it — and tracking run history is a worse
idea than the §7 draft copy implied. See 2.6.1.

#### 2.6.1 The dial was already mostly inert, and tracking runs is not the win it sounds like

Two corrections to the premise, both verified against current code:

- **"Remove the lines you want tracked" does not work.** `ensureGitignore`
  appends every entry it finds missing (`WorkspaceInitializer.ts:157-173`) and
  runs on every activation via `initializeIfNeeded`. Delete `.runs/` and the next
  activation puts it back. The only edit that survives is _appending_ a later
  `!.runs/` negation, which git honors because the exclusion is directory-level.
- **The dial was never repo-declared.** The generated file ignores itself
  (`GITIGNORE_SELF_ENTRY`), and its own header already warns that edits stay on
  one machine unless the user first deletes that line. So "the repo decides to
  track its runs" was not achievable before this plan either — it was always a
  per-clone, per-developer edit.

And tracking buys less than it appears to:

- **It only protects committed runs.** A run directory is untracked until someone
  commits it, so plain `git clean -fd` — no `-x` required — destroys every
  in-flight and uncommitted run. Un-ignoring moves run history out of the `-fdx`
  blast radius and into the `-fd` one; it does not make it durable.
- **What lands in the commit is hostile.** `runner.json` names a live PID, so a
  pulled lock reproduces the false "already running" error the debugging docs
  warn about; `workflow.json`'s `nextRunId`/`latestRunRef` conflicts whenever two
  people run concurrently; `.search-index/` and `lifetime-stats.json` are derived
  churn; and `events.jsonl` is raw harness transcript — everything the harness
  printed, including whatever it read out of the repo (see
  `SECRETS_AND_REDACTION_PLAN.md`).

**Therefore `"workspace"` mode keeps ignoring `.runs/`.** Describe it as "keep
run history beside the repo instead of under your home directory," and answer
"I want to share a run" with an explicit export (2.6.2) rather than a storage
setting.

#### 2.6.2 Sharing a run is a separate feature

Nothing in this plan gives a team shared run history, and nothing should. The
honest shape is a portable, path-independent, redactable **run export** —
`ctrlyoke run export <workflowKey> <runRef> --out <dir>` writing a bundle a
teammate can commit and open — paired with the run materializer already
specified in `HARNESS_SESSION_IMPORT_PLAN.md`, which reuses the existing
`TimelineRecorder`/`OutputHistoryManager` write path to reconstitute a
`manifest.json` + `events.jsonl` in the reader's own history. Export is the
missing half of that plan, not a variant of this one. Storage location and
shareability are independent axes and conflating them is what produced the
inert `.gitignore` dial in the first place.

**The rest is messaging, and the model is already coherent** — it just has to be
stated, because the three pieces were designed at different times:

- **Ephemeral, workspace-scoped:** `attachments/` and `prompts/` — assets for
  runs happening in _this_ workspace, readable by the harness because they are
  inside it (2.3).
- **Ephemeral, user-scoped:** `.runs/` — the run history and metadata those
  assets belong to. Outside the workspace, and outside the harness sandbox,
  because only ctrlyoke reads it.
- **Durable:** a workflow you exported with Save As, hand-authored anywhere in
  the repo, or promoted to a template. Templates are worth naming explicitly as
  the durable form of a workflow you run often — that is the case Save As
  handles least well, since it produces a copy rather than something reusable.

Save As already defaults to the last export directory falling back to the repo
root (`WorkflowSerializer.ts:365`), and saving anywhere in the repo is the
intended behavior. Keep it. No `.ctrlyoke/workflows/` default — the point is that
durable workflows are ordinary repo files, and steering the default into
`.ctrlyoke/` would undercut that.

Worth saying plainly in the docs: **user-level, project-keyed session history is
a familiar harness pattern.** Claude and Codex use it, so users arriving from
those tools will find run history outside the repo unsurprising; what would
surprise them is a tool that puts conversation logs in their commits.

Concretely, in the same release: update the QUICK_START/`docs/guide/` copy
drafted in `WORKFLOW_PORTABILITY_PLAN.md` §7.

**The generated `.gitignore` header needs no change** — verified against
`WorkspaceInitializer.ts:6-16`. An earlier revision of this document claimed the
header offers editing the file as the way to "start tracking runs"; it does not,
and has not since the header was rewritten. What it says today is exactly the
half worth keeping: the warning that edits stay machine-local until the
`.gitignore` self-entry is deleted, plus the managed-worktree landing note.
Leave it alone; the stale user-facing copy is in the docs, not in the generated
file.

---

## 3. Layout

```
~/.ctrlyoke/
  settings.json                     ← already exists (FileConfigBackend.ts:107)
  external-roots-trust.json         ← already exists (ExternalRootsTrustStore.ts)
  agents/  skills/  templates/      ← already exist (HarnessDirectoryUtils.ts)
  certs/                            ← already the default generated-cert location
  notifications/                    ← moved: browser-push VAPID keypair + subscriptions (2.2)
  usage/
    provider-snapshots.json         ← moved: cached provider account-quota windows (2.1)
  projects/
    ctrlyoke-3f9a2c71b947/
      project.json                  ← identity + reverse lookup
      .runs/<workflowKey>/...       ← byte-identical to today's layout
      .search-index/
      .usage/
        lifetime-stats.json         ← WorkflowKey-keyed, must stay project-scoped
        observed-usage.json         ← run-keyed; buckets folded across projects
```

The `.runs/` segment is deliberately preserved. Every path below it is
constructed by `WorkflowPaths.ts`, which derives everything from `runsRoot()` —
so keeping the segment means **nothing below `runsRoot` changes at all.**

### 3.1 Project key

Claude's scheme (`C:\Users\natha\.claude\projects\c--dev-ctrlyoke\`) flattens the
path by replacing separators with `-`. It is readable, and it collides:
`C:\dev\ctrlyoke` and `C:\dev-ctrlyoke` produce the same directory, silently
fusing two projects' histories. Don't copy that part.

**Use `<slug>-<hash12>`:**

- `slug` = lowercase ASCII-sanitized basename of the state root (`ctrlyoke`),
  capped at 48 characters, with `project` as the empty fallback.
- `hash12` = first 12 hex chars of
  `sha256(foldPathForCompare(path.resolve(stateRoot)))`.

`foldPathForCompare` already exists in `src/utils/PathCasing.ts` and already owns
the win32 case-folding problem — reuse it rather than inventing a second
canonicalization. Result: `ctrlyoke-3f9a2c71b947`. Twelve hex characters keep
the directory readable while making a collision negligible even at a scale far
beyond a personal project list. The result is stable across the drive-letter
casing differences that `PathCasing.ts` documents (VS Code emits `c:/…`, Node
emits `C:\…`).

### 3.2 `project.json`

```jsonc
{
  "schemaVersion": 1,
  "statePath": "C:\\dev\\ctrlyoke", // absolute, as first seen
  "gitToplevel": "C:\\dev\\ctrlyoke", // if any, for future relink heuristics
  "createdAt": "2026-08-13T23:00:00.000Z",
  "lastOpenedAt": "2026-08-13T23:40:00.000Z",
}
```

Needed for three things: reverse lookup when a user finds an opaque hash dir,
a future cross-project history browser, and pruning.

Path calculation stays pure and synchronous; metadata persistence does not
belong in `projectStateRoot()`. Add a vscode-free `ProjectStateRegistry` that is
initialized after config bootstrap and before any history scan in the extension
and history-using CLI commands (`run`, not parse-only `validate` or unrelated
`commit`). In user mode it:

1. creates the project directory and `project.json` under a file lock;
2. writes through a same-directory temp file and atomic rename;
3. preserves `createdAt`, refreshes `lastOpenedAt`, and records `gitToplevel`
   when the caller has one; and
4. compares an existing `statePath` with `pathsEqual` before allowing access.

A mismatched `statePath` is a fatal collision/corruption error — never append a
longer hash dynamically, because that makes the mapping nondeterministic between
processes and breaks the migration script. A missing `project.json` is accepted
only when the computed project directory is empty; a non-empty unowned directory
also fails loudly. Reject metadata with a newer unsupported `schemaVersion`.
Workspace mode does not create a user project directory or `project.json`.

Treat the user state tree as private data: create new POSIX directories with
mode `0700` and metadata/notification/usage files with mode `0600` (Windows
ignores these modes). Registry, prune, relink, and migration operations must
reject symlinked project directories and re-run containment checks against the
real `<ctrlyokeStateHome>/projects` root before renaming or deleting anything.

### 3.3 What the key is derived from — and what it is not

Key on **`ExecutionWorkspace.stateRoot`**, the field already documented in
`src/types/WorkflowContextTypes.ts:21` as "Where ctrlyoke stores .ctrlyoke/.runs".
It is already the right abstraction and the worktree work already maintains the
`stateRoot` / `executionRoot` split — a managed worktree run keeps `stateRoot` at
the initiating checkout, so worktree runs land in the initiating project's history.
That is the desired behavior and it comes for free.

**Do not key on repository identity.** Two clones of the same repo at different
paths are two projects with two histories; fusing them by remote URL or by the
initial commit would be wrong and surprising.

Consequence to accept: opening a worktree directory _directly_ as its own VS Code
workspace yields its own history, because its `stateRoot` is that directory.
Correct by the same rule, but worth a doc note.

**Multi-root resolution is already decided by existing architecture:** there is
one history project per resolved ctrlyoke state root, not one per workspace
folder. `getVsCodeWorkspaceRoot()` selects the `.code-workspace` directory, the
configured `ctrlyoke.workspaceDirectory`, or the first folder; all other folders
are additional trusted/execution roots only. Hash that one resolved root. This
preserves the current single dashboard/session namespace for the window and
avoids duplicate `WorkflowKey` namespaces inside one orchestrator.

---

## 4. The change is small, because one function already owns the root

`src/utils/WorkflowPaths.ts` is, by its own header comment, "the _only_ module
allowed to construct a `.runs` path from raw parts." That holds up: every one of
`lineageDir`, `descriptorPath`, `runnerLockPath`, `draftDir`, `draftFilePath`,
`runDir`, `runFilePath`, `pendingRewindDir`, `manifestPath`, `eventsPath`,
`stagingRunDir`, `assertContained`, `parseRunArtifactPath`, and
`allocateWorkflowKey` bottoms out in:

```ts
export function runsRoot(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.CTRLYOKE_DIR,
    PATH_CONSTANTS.RUNS_DIR
  );
}
```

Redirect that one function and roughly 120 `WorkflowPaths.*` call sites keep
compiling and keep working. The parameter stops meaning "the directory this
lives under" and starts meaning "the project identity" — a rename to
`stateRoot`, plus a doc-comment correction, not a signature change.

```ts
// src/utils/ProjectStatePaths.ts  (new — must stay vscode-free)
export function ctrlyokeStateHome(): string;
export function projectStateRoot(
  stateRoot: string,
  location: RunHistoryLocation
): string;
export function projectKey(stateRoot: string): string;

// WorkflowPaths.ts
export function runsRoot(stateRoot: string): string {
  return path.join(
    projectStateRoot(stateRoot, getFrozenRunHistoryLocation()),
    PATH_CONSTANTS.RUNS_DIR
  );
}
```

**Hard constraint:** `ProjectStatePaths.ts` may import only `node:path`,
`node:os`, `node:crypto`, `PathCasing`, and type-only shared storage contracts.
`WorkflowPaths.ts` is deliberately
vscode-free so `src/mcp-server.ts` (plain Node/CJS) can import it — that is why
`mcp-server.ts:806`'s `.runs/` scan can keep using the same path API.
Importing anything vscode-shaped into the new module silently breaks the MCP
server bundle.

The location setting introduces one necessary boundary that the first draft
missed: `projectStateRoot(stateRoot)` cannot both stay pure and discover a user
setting by itself. Resolve `storage.runHistoryLocation` once, after config
backends are initialized, and freeze it for the process lifetime in a small
vscode-free storage-policy module. `WorkflowPaths`, `UsagePaths`, and the search
index use that frozen value. The extension and CLI initialize it before any
history consumer. Export the resolved value to the MCP child process (for
example `CTRLYOKE_RUN_HISTORY_LOCATION`) and initialize the same policy at MCP
startup; the pinned `CTRLYOKE_WORKING_FILE` is not enough because
`ctrlyoke_global_status` scans sibling lineages.

Changing the setting while the extension is running writes the new user value
but does not retarget live instances or locks. The settings UI must label it
"Requires reload" and offer/recommend a window reload. This avoids one process
reading a lock in one root and releasing it in another. CLI invocations naturally
pick up the new value on their next process start.

`ctrlyokeStateHome()` returns the resolved `CTRLYOKE_HOME` override when present,
otherwise `path.join(os.homedir(), ".ctrlyoke")`. The override is intentionally
limited to the new project/account state described by this plan; existing
settings, agents, skills, and templates keep their current home resolution.
Use the same helper for project state, browser-push state, and provider quota
snapshots so tests and side-by-side builds do not leak those new writes into the
real home.

**`CTRLYOKE_HOME` is a test/side-by-side isolation knob, not a user-facing
storage control, and pointing it inside a repo does not produce shareable run
history.** The project key is
`sha256(foldPathForCompare(path.resolve(stateRoot)))` (3.1), so a teammate whose
clone sits at a different absolute path resolves a different
`projects/<slug>-<hash12>` directory and sees an empty history next to the
committed one. It is also process-global — every project opened by that process
writes there — and it drags `notifications/`, which holds the VAPID **private
key**, plus `usage/provider-snapshots.json` into the repo, at a location outside
`.ctrlyoke/` that `WORKSPACE_INITIALIZER_RUNTIME_ENTRIES` does not ignore. Warn
at startup when the resolved value lies inside a git worktree or a known state
root, and never document it as a way to track runs; `storage.runHistoryLocation`
(5.4) is the supported control.

`HistorySearchIndexService.ts:753` gets the same one-line treatment for
`.search-index`: derive it from `projectStateRoot(stateRoot, frozenLocation)`.

`src/utils/UsagePaths.ts` is the one that does **not** get a uniform treatment,
per 2.1: `lifetimeStatsPath` and `observedUsagePath` retarget to the project
dir, while `providerSnapshotsPath` drops its `workspaceRoot` parameter entirely
and returns `<ctrlyokeStateHome>/usage/provider-snapshots.json`. Dropping the parameter
rather than ignoring it is deliberate — it makes the scope change visible at
every call site (`HarnessUsageService.ts:185`) instead of leaving a lie in the
signature.

---

## 5. The parts that do not come for free

These are the reason this is a plan and not a one-line patch. Each one assumes
today that "run artifacts are inside the workspace."

### 5.1 Four VS Code watchers — all will break

`WorkflowOrchestrator.ts:5597-5604` builds its `runner.json` discovery watcher
by making the runs root _relative to the workspace_:

```ts
const runsRootRelative = path
  .relative(workspaceFolderPath, runsRootDir)
  .replace(/\\/g, "/");
const pattern = new vscode.RelativePattern(
  workspaceFolderPath,
  `${runsRootRelative}/*/runner.json`
);
```

After the move this yields a `../../../Users/...` pattern, which VS Code will not
watch. Fix by basing the pattern on the runs root itself:

```ts
const pattern = new vscode.RelativePattern(
  vscode.Uri.file(runsRootDir),
  "*/runner.json"
);
```

VS Code has supported watching outside the workspace via a `Uri`-based
`RelativePattern` since 1.64; `package.json` requires `^1.104.0`, so the API is
available. The pattern contains `/`, making it recursive — **verify recursive
out-of-workspace watching actually fires** on Windows during Phase 1 rather than
trusting the API surface. This watcher is how VS Code notices a CLI-started run,
so a silent failure here is a real regression with no error message.

The initial audit missed the three exact-file watchers in `CliWatchSession`:

- `setupWorkingFileWatcher()` bases the run file on `workspaceFolderPath`;
- `setupLockFileWatcher()` bases `runner.json` on `workspaceFolderPath`; and
- `setupHistoryWatcher()` bases the manifest on `workspaceFolderPath`.

All three will also produce `../../..` patterns. For an exact external file,
base the `RelativePattern` on `vscode.Uri.file(path.dirname(targetPath))` and use
`path.basename(targetPath)` as the pattern. Preserve the existing create/change/
delete subscriptions and heartbeat fallback. Ensure the project and `.runs`
directories exist before installing the discovery watcher; a watcher rooted at
a nonexistent external directory cannot reliably observe the directory itself
being created.

Add focused mocked-pattern tests for all four bases, plus one manual or extension
integration check on Windows that starts a CLI run after VS Code activation and
observes live working-file, manifest, and lock-delete events.

### 5.2 File access policy — run artifacts leave the trusted set

`src/utils/FileAccessPolicy.ts` allows a path when it is inside
`workspaceRoots` or `approvedExternalRoots`, and otherwise returns
`outsideTrustedRoots`. Today run artifacts pass on the first check for free.
After the move they fail both.

Do **not** fix this by pushing the project state root into
`ExecutionWorkspace.workspaceRoots` — that widens what the _harness_ may read,
and does it invisibly. Add a third, explicit reason instead:

```ts
type FileAccessReason =
  | "workspace"
  | "ownStateRoot"
  | "trustedExternalRoot"
  | "outsideTrustedRoots";
```

Add an explicit `ownStateRoots` option to the pure policy comparator and check it
after workspace roots but before approved external roots. `ownStateRoot` covers
ctrlyoke-owned UI reads and stays auditable at each call site. Pass it only from
UI/open-file and prompt-file resolution paths that are allowed to inspect the
current project's run artifacts. Do not pass it to `RunOutputResolver`'s file-
change projection (those paths describe harness workspace edits), and do **not**
feed it into `ExecutionWorkspace.workspaceRoots`, `ContextExpander`, attachment
builders, or any harness approved/additional-root list.

The first draft conflated two different mechanisms. `AddressedPriorContextResolver`
does not accept a literal path; it accepts `{ workflowKey, runRef }`, constructs
the manifest through `WorkflowPaths`, and will follow the move automatically.
A literal `@.ctrlyoke/.runs/...` is only a normal workspace file reference today.
Do not add a compatibility alias or a new `@runs/` virtual filesystem. Such an
alias would create a second history-address grammar and encourage durable
workflows to depend on machine-local artifacts. The supported path-independent
form is `priorContext: { workflowKey, runRef }`; update validation/help text so a
missing old-style `@.ctrlyoke/.runs/...` reference points users to that form
rather than failing without guidance.

### 5.3 A throwaway script, not a migration

ctrlyoke is pre-release with no customers and one developer. There is **no
compatibility contract to honor**: no read-through fallback to the old location,
no first-load migration offer, no `MOVED.md` breadcrumb, no deprecation window,
and no permanent compatibility suite for the old layout. New code reads the new
location, full stop.

What is actually needed is a one-off `scripts/migrate-runs-to-user-scope.mjs`
that the author runs once per repo across roughly five repositories on Windows,
macOS, and Linux, and then deletes. Although disposable, cover its key, dry-run,
live-lock, destination-conflict, and `EXDEV` behavior with a focused test while
it exists; a migration utility whose failure looks like data loss should not be
validated only by inspection.

Cross-platform is the only real requirement, and it is narrower than it sounds —
the script must produce **exactly** the project key the implementation will
compute, or it files history into a directory ctrlyoke never looks in and the
result looks identical to data loss. Two consequences:

- Give it a `--print-key` mode. Run it, compare against the path the extension
  resolves (including the 12-character hash), _then_ move anything.
- Accept `--state-root <path>` (default `process.cwd()`) and print the resolved
  state root, key, and full destination. A repository root is not always the
  state root in a `.code-workspace` or `ctrlyoke.workspaceDirectory` setup.
- Case folding differs by platform (win32 folds, macOS/Linux do not — see
  `PathCasing.foldPathForCompare`). Duplicate that behavior exactly rather than
  approximating it with `toLowerCase()`.
- No project imports. The existing `scripts/migrate-runs-layout.mjs` states this
  property explicitly ("may be copied to another ctrlyoke workspace") and it
  matters here: four of the five target repos are not ctrlyoke and have no
  `out/` build to import from.

Keep three safety properties from the existing script and drop the rest:

- **Dry run by default, `--apply` to commit.** Cheap, and the one thing that
  catches a wrong key before it matters.
- **Move, never copy.** Two live copies of a lineage sharing a `workflowKey` is
  the worst outcome — `runner.json` locks would be evaluated against a root that
  is no longer authoritative.
- **`fs.rename` with an `EXDEV` copy-then-delete fallback.** Likely to be needed:
  `~` and the repo are often on different volumes, which is the whole point.

Refuse to run if any `runner.json` in the tree holds a live PID.

Refuse to merge any destination that already contains a lineage or observed-
usage contribution. A prior extension activation may legitimately have created
a matching `project.json` plus empty `.runs`, `.search-index`, or `.usage`
scaffolding; validate the metadata and allow/remove only that empty scaffold.
Create or validate `project.json` using the same schema and collision rules as
the implementation.
For the `EXDEV` fallback, copy into a hidden staging sibling under the destination
project, fsync/close files, rename the completed staging directory into place,
and only then remove the source. A direct recursive copy exposes a half-migrated
history to an extension opened mid-command.

Move `.runs/` **and** `.usage/observed-usage.json`. The current
`ObservedHarnessUsageStore` has no manifest backfill; deleting that file loses
its retained daily/weekly/monthly contributions until runs happen to be written
again. `lifetime-stats.json` is genuinely rebuildable and `.search-index/` is
derived, so delete those source artifacts on `--apply` after the run move
succeeds. Do not migrate workspace `provider-snapshots.json`; the account-scoped
service can refresh it. Remove an empty source `.usage/` directory, but leave any
unknown files untouched and report them.

Nothing else needs rewriting: `QueueState.workingFilePath` is in-memory per
client, `workflow.json` stores `latestRunRef` (a ref, not a path), recent workflows
are rebuilt by scanning descriptors, and the webview persists
`displayedViewAddress` as `{ workflowKey, runRef? }` rather than an absolute path.

### 5.4 `storage.runHistoryLocation`

Add `storage.runHistoryLocation: "user" | "workspace"`, defaulting to `"user"`.
Not an afterthought opt-out: per 2.6 this is the documented answer to "I want my
runs in source control," replacing an affordance that this change breaks. It
ships with the move, not after it.

`"workspace"` reproduces today's behavior exactly, which makes it the cheap
branch to keep correct — every existing test already covers that path.

**User scope only — but not for the reason an earlier revision gave.** There is
no bootstrap cycle here. The workspace backend reads
`<workspaceRoot>/.ctrlyoke/settings.json` (`FileConfigBackend.ts:112-117`),
resolved from the workspace root before any history consumer runs
(`extension.ts:341-345`, `cli.ts:292-295`), so the order is already
`workspaceRoot → settings.json → runsRoot`. A workspace-scope enum would
bootstrap fine. The three reasons that do hold:

1. **Trust.** `settings.json` is tracked (see the 2 table) and therefore arrives
   with the clone, so a workspace-scope value is repo content deciding where
   ctrlyoke writes on the reader's disk before they have looked at it. This is
   precisely why `worktrees` is already workspace-forbidden
   (`CtrlYokeConfigService.ts:24-28, 178-185`) — both settings direct where
   ctrlyoke creates directories.
2. **Enumeration.** `history prune`, `history relink` (5.5), and the phase-5
   cross-project rollups run with no workspace open, over
   `<ctrlyokeStateHome>/projects/*`. If the mode were per-repo, deciding whether a
   project directory is still authoritative would mean reading a `settings.json`
   inside a repo that may be deleted, moved, or on a disconnected volume — which
   is exactly the condition that triggers prune. The user state root would stop
   being a complete index of the user's history. _This_ is the real circularity,
   and it is an enumeration problem, not a bootstrap one.
3. **Mid-session mutation.** A tracked settings file changes on every checkout,
   pull, and rebase. Because the location is startup-frozen (4), a branch switch
   would leave the frozen value disagreeing with the file on disk for the rest of
   the session — reintroducing the split-root lock hazard the freeze exists to
   prevent, through a mechanism the user never knowingly touched.

The shared JSON schema cannot distinguish which backend it is validating, so
enforce this where scope is known: add `storage` to `CtrlYokeConfigService`'s
workspace-forbidden paths (the same mechanism already used for `worktrees`) and
omit/disable workspace-scope controls in the settings UI. **The read-side half is
mandatory, not belt-and-braces:** the existing `worktrees` guard only blocks
writes through `set()` (line 178), while `getAll()` deep-merges workspace over
user unconditionally (lines 155-160), so a hand-authored workspace `storage`
object would otherwise win. Use the default/user backend value only, and
diagnose the ignored object rather than dropping it silently. Add the
type/default, `RUN_HISTORY_LOCATIONS` constants, schema, `ConfigurationUtils`
accessor, settings UI, docs, and config-service tests.

#### 5.4.1 If repo-declared location is ever wanted, propose-and-confirm — and never a path

Reason 1 above is the only one that a design can neutralize, and ctrlyoke already
has the pattern: `ExternalRootsTrustStore` lets a workspace _request_ external
file roots while `~/.ctrlyoke/external-roots-trust.json` _decides_, per canonical
root and workspace identity, with a durable allow/deny
(`ExternalRootsTrustStore.ts:19-33`). The same shape would work here — a
workspace `storage.runHistoryLocation` surfaced as a pending request on
activation, effective only after a local decision.

It is not free, though: reasons 2 and 3 survive. Prune/relink would have to treat
a trusted workspace-mode project as intentionally absent rather than orphaned,
and the trusted value would still have to be frozen at startup. Worth doing only
if real teams ask for it; explicitly out of scope for this plan.

**Enum only. A configurable history _path_ is a different feature and should be
rejected outright:**

- `allocateWorkflowKey` guarantees uniqueness only within one runs root (2.1), so
  two workspaces aimed at one configured path silently fuse their lineages —
  the same defect that keeps `lifetime-stats.json` project-scoped.
- A committed absolute path is meaningless on every other machine, and a relative
  one still needs containment validation against `.git/`, other projects' state
  roots, and `<ctrlyokeStateHome>/projects`. That validation _is_ a trust
  decision sourced from the repo, which is the genuinely circular version of this
  idea.
- The enum keeps this change a one-line redirect through `runsRoot` (4). A path
  adds validation, collision detection, and a second failure mode behind all
  ~120 `WorkflowPaths.*` call sites.

Switching the setting does not migrate data. The UI warning must say that the
other location will appear as a different history after reload and that the
user can switch back without data loss. The personal migration script handles
only the one-time pre-release workspace → user move; `history relink` handles a
project path change, not a location-mode change.

### 5.5 Smaller items

- `WorkflowSerializer.ts:1336` — the confirm prompt "Delete all workflows and
  their history from .ctrlyoke/.runs?" now names the wrong path. Show the
  resolved absolute path; the user is about to delete data outside their repo.
- **Leave the workspace runtime entry list alone.** The authoritative source is
  now `WORKSPACE_RUNTIME_ENTRY_RULES` (`WorkspaceInitializer.ts:52-63`), a
  two-tier list of `{ entry, blockWhenTracked }`;
  `WORKSPACE_INITIALIZER_RUNTIME_ENTRIES` is a derived projection of its
  `entry` values and `WORKSPACE_INITIALIZER_UNSAFE_ENTRIES` of the
  `blockWhenTracked` ones. It has a second consumer: `WorktreeManager` uses it
  via `isWorkspaceInitializerRuntimePath`/`isWorkspaceInitializerUnsafePath` to
  **block** a managed worktree landing that would stage a runtime path
  ("Managed landing would stage runtime paths: …"). Do not remove the entries
  for moved/default-user data (`.runs/`, `.search-index/`, `.usage/`,
  `notifications/`) or for workspace-opt-in `certs/`, and do not relax any
  `blockWhenTracked: true` flag.
  A pre-migration repo, a user who set
  `storage.runHistoryLocation: "workspace"` (5.4), or a user who explicitly
  generated a workspace certificate can still have them on disk and still needs
  both the ignore rule and the landing guard.
  `ensureGitignore` is append-only anyway, so removing an entry would not reach
  existing workspaces; it would only desynchronize the guard from reality.
- `WorkspaceInitializer` itself scaffolds no subdirectories (`initializeIfNeeded`
  creates only `.ctrlyoke/` and its `.gitignore`; every consumer creates its own
  directory on demand), so there is no directory-creation code to remove — only
  the generated `.gitignore` **header text** to correct per 2.6.
- Home directories under OneDrive/Dropbox now sync run history — mostly a
  feature, but running the same project simultaneously on two synced machines is
  unsupported: PIDs and file locks are machine-local. Document that restriction;
  do not imply the runner lock can coordinate across devices.
- Deleting a repo now orphans its project directory forever. Ship a
  `ctrlyoke history prune` (list projects whose `statePath` no longer exists,
  confirm, delete) in the same release, not "later." Treat inaccessible paths
  (permissions, disconnected network volumes, transient I/O errors) as unknown,
  not orphaned. Refuse to prune a project containing a live `runner.json`; require
  `--yes` for non-interactive deletion and default to a list/dry-run.
- Moving or renaming a repo silently starts an empty history — the same flaw
  Claude has. `ctrlyoke history relink <oldPath> <newPath>` is a cheap fix given
  `project.json` already records `statePath`. Relink computes both keys, refuses
  a live runner or destination containing real history, but may replace the
  matching empty scaffold created by opening `newPath` before relinking. It
  atomically renames the project directory within `<ctrlyokeStateHome>/projects`,
  preserves `createdAt`, and updates
  `statePath`, `gitToplevel`, and `lastOpenedAt` under the registry lock. It is a
  user-history command even when the current storage preference is `workspace`.
- `.github/copilot-instructions.md` documents `.ctrlyoke/.runs/<workflowKey>/`
  as a debugging location (run storage, `runner.json`, `events.jsonl`). That
  section becomes wrong on the day this ships and must be updated in the same
  change. Its `.ctrlyoke/logs/` guidance stays correct — see 2.4.
- Update every current user-facing/debugging reference found by the path audit,
  not only QUICK_START: `README.md`, `QUICK_START.md`, `docs/guide/**`,
  `docs/troubleshooting/index.md`, `.github/copilot-instructions.md`, the scoped
  core/orchestration/types/utils instruction files, and
  `src/templates/agents/ctrlyoke-tech-support.agent.md`. Code comments that name
  the old physical root should say "run storage" or show both resolved modes.

---

## 6. Test impact

27 files under `src/test/` reference `.runs`, `runsRoot`, or `WorkflowPaths`.
Most construct a temp workspace and assert on paths beneath it.

The leverage: point `projectStateRoot()` at an injectable base (`CTRLYOKE_HOME`)
and most of these keep working with an isolated test home. Set it once in the
extension-test bootstrap to a unique temp directory for that process; do not
mutate a process-global environment variable in concurrently running suites.
Tests that hardcode
`path.join(workspace, ".ctrlyoke", ".runs")` must move to
`WorkflowPaths.runsRoot(workspace)` — which is what the module's own header
already tells them to do, so this is a conformance fix, not new debt.

`CTRLYOKE_HOME` is also the honest answer for CI and for anyone running two
ctrlyoke builds side by side. Child MCP processes inherit both it and the frozen
location value.

Required focused coverage:

- deterministic keys across Windows drive-letter casing, slug sanitization,
  workspace/user modes, and `CTRLYOKE_HOME`;
- `project.json` create/update, unsupported schema, missing metadata in a
  non-empty directory, and state-path collision failure;
- user-only config enforcement and reload/frozen-policy behavior;
- all four external watcher patterns;
- `ownStateRoot` allowing UI reads without widening harness trusted roots;
- project-scoped search/usage paths, account-scoped provider-quota/browser-push
  paths, and unchanged workspace-scoped hook-notification/UX-snapshot paths;
- multi-root uses the one resolved state root; managed worktrees keep the
  initiating `stateRoot`; and direct worktree opens get their own key;
- prune/relink dry-run, live-run refusal, inaccessible-path handling, and
  destination collision; and
- migration of `.runs` plus observed usage, including the `EXDEV` staged move.

---

## 7. Phasing

Being pre-release removes the usual constraint that a storage move must be
survivable in stages. There is no installed base to keep working, so the
sequencing below is about reviewable chunks, not compatibility windows.

| Phase | Content                                                                                                                                                                                                                                                          | Ships value alone?                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1     | `ProjectStatePaths`, frozen storage policy/MCP propagation, `ProjectStateRegistry`, redirect `runsRoot`, `.search-index` and project `.usage`, fix all four watchers (5.1), scoped `FileAccessPolicy` support (5.2), `CTRLYOKE_HOME`, test conformance           | **Yes** — default user storage works end to end                                 |
| 2     | `storage.runHistoryLocation` (5.4), reload behavior, plus the 2.6 messaging and complete old-path documentation audit                                                                                                                                            | Required in the same release as 1                                               |
| 3     | **Account/machine scope (2.2):** lock-safe global browser-push `notifications/` and provider-quota cache `provider-snapshots.json` → `<ctrlyokeStateHome>/usage/` with merge-on-write; no cert, hook-notification, UX-snapshot, or undo-snapshot behavior change | Yes — independently reviewable; may introduce the small state-home helper first |
| 4     | `history prune`, `history relink`                                                                                                                                                                                                                                | Yes; release gate for 1/2, though reviewable separately                         |
| 5     | Read-side rollups: fold `observed-usage.json` buckets across projects (2.1)                                                                                                                                                                                      | Yes                                                                             |

`scripts/migrate-runs-to-user-scope.mjs` (5.3) is not a phase — it is a personal
tool written alongside phase 1, run once per repo, and deleted.

Phase 2's "2.6 messaging" covers the _docs_ for 2.6.2, not the feature: run
export and repo-declared location (5.4.1) are both out of scope for this plan.

Phase 3 has no dependency on project-key or run-history redirection. It shares
only the small `ctrlyokeStateHome()` helper and is still worth landing if the
rest of the plan stalls.

`attachments/`, `prompts/` (2.3) and `logs/` (2.4) are deliberately absent — they
stay where they are. The stale comments identified in 2.3 were corrected when this
revision was written, so no phase covers them.

---

## 8. The upside worth naming

Per-workspace storage is also why lifetime usage stats are per-workspace today
(`LifetimeUsageStore.ts:848` and `WorkspaceStatsService.ts:210` both walk a
single workspace's `runsRoot`). Once every project's runs live under one root,
"usage across all my projects" and "search my history everywhere" become
directory walks over `~/.ctrlyoke/projects/*/` rather than features that need
new storage. Relevant to `STATS_AND_USAGE_PAGE_PLAN.md`.

The cost, stated plainly: run history stops living in the repo by default.
Nothing regresses in practice — `.runs` has been gitignored the whole time, the
`.gitignore` dial that supposedly opted into tracking never actually worked
(2.6.1), and `storage.runHistoryLocation: "workspace"` (5.4) still puts history
beside the repo for anyone who wants it there. What this plan deliberately does
_not_ deliver is shared run history; that wants the explicit export in 2.6.2
paired with `HARNESS_SESSION_IMPORT_PLAN.md`, not a storage-location decision.

---

## 9. Decisions recorded by the implementation-readiness review

1. **No `@runs/` alias and no legacy path remap.** Addressed history injection
   uses the existing path-independent `{ workflowKey, runRef }` prior-context
   form. Literal workspace file references remain literal and receive actionable
   missing-reference guidance.
2. **One project per resolved state root in a multi-root window.** Additional
   workspace folders do not create additional history namespaces.
3. **Use `hash12`; fail on metadata mismatch.** Never lengthen a colliding key
   dynamically.
4. **Storage location is startup-frozen and user-only.** A change requires reload,
   does not move data, and is propagated explicitly to MCP children.
5. **Observed usage moves with runs.** It does not currently backfill from
   manifests; lifetime stats and the search index do.
6. **Prune/relink ship in the same release.** They can be separate review phases,
   but user-scoped project directories do not ship without lifecycle tools.
7. **User-only rests on trust, enumeration, and mid-session mutation — not on a
   bootstrap cycle** (5.4). The earlier chicken-and-egg justification was wrong
   and was removed; do not restore it.
8. **Repo-declared location, if ever added, is propose-and-confirm via the
   `ExternalRootsTrustStore` pattern, and stays an enum** (5.4.1). A configurable
   history path is rejected outright.
9. **Workspace mode keeps ignoring `.runs/`, and sharing is a separate export
   feature** (2.6.1, 2.6.2). `storage.runHistoryLocation` is documented as
   durability/locality, never as "commit my runs."

No product decision remains open. The choices above follow the current
architecture and the plan's existing security/compatibility constraints; change
one only if a different product behavior is desired.

---

## 10. Implementation ledger

Each step updates its own row to `done` (or records a deviation) in the same
commit that implements it. Phase numbers refer to §7.

| #   | Step                                                                              | Phase | Status                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ProjectStatePaths` + frozen storage policy + `storage.runHistoryLocation` config | 1/2   | done                                                                                                                                                                                                                                                                                                  |
| 2   | `ProjectStateRegistry` + bootstrap freeze + MCP propagation                       | 1     | done                                                                                                                                                                                                                                                                                                  |
| 3   | Redirect `runsRoot`, `.search-index`, project `.usage`; test conformance          | 1     | done                                                                                                                                                                                                                                                                                                  |
| 4   | Four external watchers + `ownStateRoot` file-access scope                         | 1     | done — mocked watcher-base coverage passes. Windows VS Code 1.133.0 verification showed that recursive external `*/runner.json` create/change events do not fire, so the watcher is retained for compatible hosts and a 1-second `.runs` lineage-directory polling fallback now covers CLI discovery. |
| 5   | `scripts/migrate-runs-to-user-scope.mjs` (throwaway) + focused test               | 1     | done                                                                                                                                                                                                                                                                                                  |
| 6   | Settings UI control + requires-reload behavior                                    | 2     | done                                                                                                                                                                                                                                                                                                  |
| 7   | Documentation/messaging audit (2.6, 5.5)                                          | 2     | done                                                                                                                                                                                                                                                                                                  |
| 8   | Account scope: browser-push `notifications/`, provider-quota cache                | 3     | pending                                                                                                                                                                                                                                                                                               |
| 9   | `ctrlyoke history prune` and `ctrlyoke history relink`                            | 4     | pending                                                                                                                                                                                                                                                                                               |
| 10  | Cross-project observed-usage bucket rollup                                        | 5     | pending                                                                                                                                                                                                                                                                                               |
