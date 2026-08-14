# User-Scoped Run History

> **Status:** Backlog — not implemented. Written 2026-08-13.
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

| Command          | Result for `.ctrlyoke/.runs/`                       |
| ---------------- | --------------------------------------------------- |
| `git clean -fd`  | **Survives** — ignored files are skipped without `-x` |
| `git clean -fdx` | **Deleted** — "Removing .ctrlyoke/.runs"            |
| `git clean -ffdx`| Deleted, along with everything else                  |

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
destroys. Auditing it turns up **three** categories, not one — and two entries
that are in it by mistake.

| Entry               | Nature                        | Verdict |
| ------------------- | ----------------------------- | ------- |
| `.runs/`            | project-derived               | **Move** → project dir |
| `.search-index/`    | project-derived (indexes `.runs`) | **Move** → project dir |
| `.usage/`           | **mixed** — see 2.1           | **Split** |
| `notifications/`    | account/device state          | **Move** → user scope |
| `certs/`            | machine state                 | **Move** → user scope (default) |
| `attachments/`      | ephemeral-run assets          | **Stay**, ignored — see 2.3 |
| `prompts/`          | ephemeral-run prompt bodies   | **Stay**, ignored — see 2.3 |
| `logs/`             | disposable diagnostics        | **Stay**, ignored — see 2.4 |
| `temp/`             | ephemeral by design           | **Stay**, ignored |
| `capabilities.json` | regenerated each activation   | **Stay**, ignored |

Not in the ignore list and not at risk: `workflows/`, `templates/`, `skills/`,
`agents/`, `scripts/`, `mcp/`, `settings.json` — authored and tracked already.

### 2.1 `.usage/` is three files with three different scopes

The instinct that usage "should be global anyway" is right for part of it and
wrong for the rest. `src/utils/UsagePaths.ts` defines three files:

- **`lifetime-stats.json`** (`LifetimeUsageStore`) — keyed
  `lineages: Record<WorkflowKey, …>` and rebuilt by walking `runsRoot`. It cannot
  go global: `allocateWorkflowKey` only guarantees uniqueness *within one runs
  root*, so two projects can each hold a `fix-tests-2026-08-01T…` key and a
  shared file would silently merge them. **Project dir**, beside the `.runs` it
  summarizes.
- **`observed-usage.json`** (`ObservedHarnessUsageStore`) — `runs` is keyed by
  `{workflowKey, runRef}`, same argument. **Project dir.** Its `buckets`
  (daily/weekly/monthly per harness) *are* an account-level question, and today
  they are quietly wrong: "tokens I burned on Claude this week" is currently
  split across one file per workspace, each holding a fraction. Once every
  project lives under one root, the correct total is a fold over
  `~/.ctrlyoke/projects/*/.usage/observed-usage.json` — a read-side change, not
  a storage one.
- **`provider-snapshots.json`** (`HarnessUsageService.ts:185`) — provider-reported
  quota windows. This one has **zero** project derivation. A Claude Pro quota is
  not per-workspace; storing it per-workspace means N copies of one account-level
  truth, each stale in a different way, each wiped by `git clean`. **True user
  scope: `~/.ctrlyoke/usage/provider-snapshots.json`.** Going global means several
  VS Code windows write one file, but that is already safe:
  `HarnessUsageService.persistProviderSnapshots` (line 422) already wraps the
  write in `withFileLock` and stages through a temp file before renaming. No new
  concurrency work — and the shared file is strictly better, since today two open
  windows each burn their own provider API refresh to learn the same quota.

### 2.2 `notifications/` and `certs/` are not project data at all

`WebPushService.ts:76-88` stores the VAPID keypair and the push-subscription
registry under the workspace. Neither is project-scoped: the VAPID keypair is
the identity of *this user's* push sender, and losing it invalidates every
existing subscription — every phone and browser must re-subscribe, with no error
message explaining why notifications went quiet. `git clean -fdx` in any repo
does this today. **Move to `~/.ctrlyoke/notifications/`.**

`certs/` holds the self-signed TLS cert for the hosted dashboard. Regenerating it
means re-accepting the certificate warning on every device that had trusted it.
Notably, `WebviewSettingsSync.handleGenerateServerCert` (line ~1089) **already**
branches `scope === CONFIG_SCOPE.USER ? homedirFn() : getVsCodeWorkspaceRoot()`,
so `~/.ctrlyoke/certs/` is an existing, working code path. The change is to make
user scope the default, not to build anything.

### 2.3 `attachments/` and `prompts/` stay ignored — but two comments claim otherwise

These two look misfiled and are not. `dev/implemented/WORKFLOW_PORTABILITY_PLAN.md`
settled it deliberately, and its ledger step 12 ("Missing-assets warning, ignore
entries, docs") is `done` — the entries are the *last* step of a shipped design,
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
*by the harness*, and harnesses sandbox to the workspace. A user-scoped
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

The one real residual gap is already decided in that plan's §8.4: adding a *new*
screenshot to an already-committed workflow lands ignored until the workflow is
re-saved. Covered by a release note, deliberately not by code.

### 2.4 `logs/` should stay

Tempting, but no — for three reasons:

1. Losing them costs nothing. They are diagnostics for a problem you are
   actively debugging, not a record you return to months later.
2. The durable thing you actually want after the fact is the run's own
   `events.jsonl`, which already lives in `.runs/` and therefore already moves.
3. The cost is real. `src/scripts/ctrlyoke-hook-utils.js` derives the logs
   directory *positionally* — it walks up two levels from the notify directory to
   reach `.ctrlyoke/` and appends `logs/`. Those scripts are spawned by external
   harness CLIs with the workspace as cwd. Moving logs means threading a new
   absolute path into every `src/scripts/ctrlyoke-*-hook.js`, plus rewriting the
   debugging section of `.github/copilot-instructions.md` that sends people to
   `.ctrlyoke/logs/`.

Real plumbing cost, zero durability benefit. Leave them.

### 2.5 Resulting move set

Three units, cleanly separable:

- **Project-derived** → `~/.ctrlyoke/projects/<key>/`: `.runs/`,
  `.search-index/`, `.usage/{lifetime-stats,observed-usage}.json`. These are
  three projections of one run corpus and must never diverge — they move together
  or not at all.
- **Account/machine** → `~/.ctrlyoke/`: `notifications/`, `certs/`,
  `usage/provider-snapshots.json`. Independent of the above; ships on its own.
  Note this *strengthens* the "secrets, hard rule" line in
  `WORKFLOW_PORTABILITY_PLAN.md` §2 rather than relaxing it — a private key that
  lives outside the repo cannot be committed by an edited `.gitignore` at all.

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

**`storage.runHistoryLocation` (5.4) is the replacement, and it is a better
one.** The `.gitignore` dial only ever chose whether to *track* runs that were
already in the workspace; the setting chooses where they *live*. Present it as
the answer to "I want my runs in source control," not as an unrelated storage
knob.

**The rest is messaging, and the model is already coherent** — it just has to be
stated, because the three pieces were designed at different times:

- **Ephemeral, workspace-scoped:** `attachments/` and `prompts/` — assets for
  runs happening in *this* workspace, readable by the harness because they are
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

Worth saying plainly in the docs: **this is what every other harness does.**
Claude, Codex, and the rest all keep session history in a user-level directory
keyed by project path. Users arriving from those tools will find run history
outside the repo unsurprising; what would surprise them is a tool that puts
conversation logs in their commits.

Concretely, in the same release: update the QUICK_START/`docs/guide/` copy
drafted in `WORKFLOW_PORTABILITY_PLAN.md` §7, and update the `.gitignore` header
text generated by `WorkspaceInitializer` — it currently tells users that editing
the file is how you "start tracking runs," which becomes the wrong instruction.

---

## 3. Layout

```
~/.ctrlyoke/
  settings.json                     ← already exists (FileConfigBackend.ts:107)
  external-roots-trust.json         ← already exists (ExternalRootsTrustStore.ts)
  agents/  skills/  templates/      ← already exist (HarnessDirectoryUtils.ts)
  certs/                            ← moved; path already supported today (2.2)
  notifications/                    ← moved: VAPID keypair + subscriptions (2.2)
  usage/
    provider-snapshots.json         ← moved: account-level quota, not project (2.1)
  projects/
    ctrlyoke-3f9a2c71/
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

**Use `<slug>-<hash8>`:**

- `slug` = sanitized basename of the state root (`ctrlyoke`), for human scanning.
- `hash8` = first 8 hex chars of `sha256(foldPathForCompare(path.resolve(stateRoot)))`.

`foldPathForCompare` already exists in `src/utils/PathCasing.ts` and already owns
the win32 case-folding problem — reuse it rather than inventing a second
canonicalization. Result: `ctrlyoke-3f9a2c71`. Readable at a glance, collision-free
in practice, and stable across the drive-letter casing differences that
`PathCasing.ts` documents (VS Code emits `c:/…`, Node emits `C:\…`).

### 3.2 `project.json`

```jsonc
{
  "schemaVersion": 1,
  "statePath": "C:\\dev\\ctrlyoke",   // absolute, as first seen
  "gitToplevel": "C:\\dev\\ctrlyoke", // if any, for future relink heuristics
  "createdAt": "2026-08-13T23:00:00.000Z",
  "lastOpenedAt": "2026-08-13T23:40:00.000Z"
}
```

Needed for three things: reverse lookup when a user finds an opaque hash dir,
a future cross-project history browser, and pruning.

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

Consequence to accept: opening a worktree directory *directly* as its own VS Code
workspace yields its own history, because its `stateRoot` is that directory.
Correct by the same rule, but worth a doc note.

---

## 4. The change is small, because one function already owns the root

`src/utils/WorkflowPaths.ts` is, by its own header comment, "the *only* module
allowed to construct a `.runs` path from raw parts." That holds up: every one of
`lineageDir`, `descriptorPath`, `runnerLockPath`, `draftDir`, `draftFilePath`,
`runDir`, `runFilePath`, `pendingRewindDir`, `manifestPath`, `eventsPath`,
`stagingRunDir`, `assertContained`, `parseRunArtifactPath`, and
`allocateWorkflowKey` bottoms out in:

```ts
export function runsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR, PATH_CONSTANTS.RUNS_DIR);
}
```

Redirect that one function and roughly 120 `WorkflowPaths.*` call sites keep
compiling and keep working. The parameter stops meaning "the directory this
lives under" and starts meaning "the project identity" — a rename to
`stateRoot`, plus a doc-comment correction, not a signature change.

```ts
// src/utils/ProjectStatePaths.ts  (new — must stay vscode-free)
export function projectStateRoot(stateRoot: string): string;
export function projectKey(stateRoot: string): string;

// WorkflowPaths.ts
export function runsRoot(stateRoot: string): string {
  return path.join(projectStateRoot(stateRoot), PATH_CONSTANTS.RUNS_DIR);
}
```

**Hard constraint:** `ProjectStatePaths.ts` may import only `node:path`,
`node:os`, `node:crypto`, and `PathCasing`. `WorkflowPaths.ts` is deliberately
vscode-free so `src/mcp-server.ts` (plain Node/CJS) can import it — that is why
`mcp-server.ts:806`'s `.runs/` scan will follow the move with no edit at all.
Importing anything vscode-shaped into the new module silently breaks the MCP
server bundle.

`HistorySearchIndexService.ts:753` gets the same one-line treatment for
`.search-index`.

`src/utils/UsagePaths.ts` is the one that does **not** get a uniform treatment,
per 2.1: `lifetimeStatsPath` and `observedUsagePath` retarget to the project
dir, while `providerSnapshotsPath` drops its `workspaceRoot` parameter entirely
and returns `~/.ctrlyoke/usage/provider-snapshots.json`. Dropping the parameter
rather than ignoring it is deliberate — it makes the scope change visible at
every call site (`HarnessUsageService.ts:185`) instead of leaving a lie in the
signature.

---

## 5. The parts that do not come for free

These are the reason this is a plan and not a one-line patch. Each one assumes
today that "run artifacts are inside the workspace."

### 5.1 The runner.json watcher — will break

`WorkflowOrchestrator.ts:5597-5604` builds its watcher glob by making the runs
root *relative to the workspace*:

```ts
const runsRootRelative = path.relative(workspaceFolderPath, runsRootDir).replace(/\\/g, "/");
const pattern = new vscode.RelativePattern(workspaceFolderPath, `${runsRootRelative}/*/runner.json`);
```

After the move this yields a `../../../Users/...` pattern, which VS Code will not
watch. Fix by basing the pattern on the runs root itself:

```ts
const pattern = new vscode.RelativePattern(vscode.Uri.file(runsRootDir), "*/runner.json");
```

VS Code has supported watching outside the workspace via a `Uri`-based
`RelativePattern` since 1.64; `package.json` requires `^1.104.0`, so the API is
available. The pattern contains `/`, making it recursive — **verify recursive
out-of-workspace watching actually fires** on Windows during Phase 1 rather than
trusting the API surface. This watcher is how VS Code notices a CLI-started run,
so a silent failure here is a real regression with no error message.

### 5.2 File access policy — run artifacts leave the trusted set

`src/utils/FileAccessPolicy.ts` allows a path when it is inside
`workspaceRoots` or `approvedExternalRoots`, and otherwise returns
`outsideTrustedRoots`. Today run artifacts pass on the first check for free.
After the move they fail both.

Do **not** fix this by pushing the project state root into
`ExecutionWorkspace.workspaceRoots` — that widens what the *harness* may read,
and does it invisibly. Add a third, explicit reason instead:

```ts
type FileAccessReason = "workspace" | "ownStateRoot" | "trustedExternalRoot" | "outsideTrustedRoots";
```

`ownStateRoot` covers ctrlyoke's own UI reads (open a run definition, resolve a
prior-context source) and stays auditable at the call site. It must **not** be
fed into the harness's approved-roots list.

Decide explicitly and record the answer: today a user can write
`@.ctrlyoke/.runs/<key>/<run>/…` in a prompt, and
`AddressedPriorContextResolver.ts:97` validates such sources against the runs
root. After the move that literal workspace-relative reference is dead. Either
keep resolving it via the project state root, or introduce an explicit
`@runs/…` form. Silently returning "file not found" is the one unacceptable
outcome.

### 5.3 A throwaway script, not a migration

ctrlyoke is pre-release with no customers and one developer. There is **no
compatibility contract to honor**: no read-through fallback to the old location,
no first-load migration offer, no `MOVED.md` breadcrumb, no deprecation window,
no test suite for the move. New code reads the new location, full stop.

What is actually needed is a one-off `scripts/migrate-runs-to-user-scope.mjs`
that the author runs once per repo across roughly five repositories on Windows,
macOS, and Linux, and then deletes.

Cross-platform is the only real requirement, and it is narrower than it sounds —
the script must produce **exactly** the project key the implementation will
compute, or it files history into a directory ctrlyoke never looks in and the
result looks identical to data loss. Two consequences:

- Give it a `--print-key` mode. Run it, compare against the path the extension
  resolves, *then* move anything.
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

Only `.runs/` needs moving. `.search-index/` and `.usage/` are derived from it
and rebuild themselves (`LifetimeUsageStore` already has a checkpointed backfill
path — `LIFETIME_USAGE_ERROR_CODES.BACKFILL_REQUIRED`), so the script should
delete them and let the next activation regenerate. Confirm `observed-usage.json`
also backfills before relying on this; if it does not, move it rather than
teaching the script to reconstruct it.

Nothing else needs rewriting: `QueueState.workingFilePath` is in-memory per
client, `workflow.json` stores `latestRunRef` (a ref, not a path), and the VS Code
`globalState` recent-workflow entries hold absolute paths used only for dedup,
which self-heal.

### 5.4 `storage.runHistoryLocation`

Add `storage.runHistoryLocation: "user" | "workspace"`, defaulting to `"user"`.
Not an afterthought opt-out: per 2.6 this is the documented answer to "I want my
runs in source control," replacing an affordance that this change breaks. It
ships with the move, not after it.

`"workspace"` reproduces today's behavior exactly, which makes it the cheap
branch to keep correct — every existing test already covers that path.

**User scope only.** A workspace-scope setting that relocates where ctrlyoke
writes state is a cloned repo redirecting another user's writes, and it creates
a chicken-and-egg problem: state location would depend on a file inside the
location being decided. Enforce this in the settings schema, not just by
convention.

### 5.5 Smaller items

- `WorkflowSerializer.ts:1336` — the confirm prompt "Delete all workflows and
  their history from .ctrlyoke/.runs?" now names the wrong path. Show the
  resolved absolute path; the user is about to delete data outside their repo.
- **Leave `WORKSPACE_INITIALIZER_RUNTIME_ENTRIES` alone.** It has a second
  consumer: `WorktreeManager.ts:573` uses it via
  `isWorkspaceInitializerRuntimePath` to **block** a managed worktree landing
  that would stage a runtime path ("Managed landing would stage runtime paths:
  …"). Do not remove the moved entries (`.runs/`, `.search-index/`, `.usage/`,
  `notifications/`, `certs/`) once the directories relocate — a pre-migration
  repo, or a user who set `storage.runHistoryLocation: "workspace"` (5.4), still
  has them on disk and still needs both the ignore rule and the landing guard.
  `ensureGitignore` is append-only anyway, so removing an entry would not reach
  existing workspaces; it would only desynchronize the guard from reality.
- `WorkspaceInitializer` itself scaffolds no subdirectories (`initializeIfNeeded`
  creates only `.ctrlyoke/` and its `.gitignore`; every consumer creates its own
  directory on demand), so there is no directory-creation code to remove — only
  the generated `.gitignore` **header text** to correct per 2.6.
- Home directories under OneDrive/Dropbox now sync run history — mostly a
  feature, but concurrent sync writes to `runner.json` deserve a doc note.
- Deleting a repo now orphans its project directory forever. Ship a
  `ctrlyoke history prune` (list projects whose `statePath` no longer exists,
  confirm, delete) in the same phase, not "later."
- Moving or renaming a repo silently starts an empty history — the same flaw
  Claude has. `ctrlyoke history relink <oldPath> <newPath>` is a cheap fix given
  `project.json` already records `statePath`.
- `.github/copilot-instructions.md` documents `.ctrlyoke/.runs/<workflowKey>/`
  as a debugging location (run storage, `runner.json`, `events.jsonl`). That
  section becomes wrong on the day this ships and must be updated in the same
  change. Its `.ctrlyoke/logs/` guidance stays correct — see 2.4.

---

## 6. Test impact

27 files under `src/test/` reference `.runs`, `runsRoot`, or `WorkflowPaths`.
Most construct a temp workspace and assert on paths beneath it.

The leverage: point `projectStateRoot()` at an injectable base (env var
`CTRLYOKE_HOME`, honored by `ProjectStatePaths` only) and most of these keep
working with a per-test temp home. Tests that hardcode
`path.join(workspace, ".ctrlyoke", ".runs")` must move to
`WorkflowPaths.runsRoot(workspace)` — which is what the module's own header
already tells them to do, so this is a conformance fix, not new debt.

`CTRLYOKE_HOME` is also the honest answer for CI and for anyone running two
ctrlyoke builds side by side.

---

## 7. Phasing

| Phase | Content | Ships value alone? |
| ----- | ------- | ------------------ |
Being pre-release removes the usual constraint that a storage move must be
survivable in stages. There is no installed base to keep working, so the
sequencing below is about reviewable chunks, not compatibility windows.

| Phase | Content | Ships value alone? |
| ----- | ------- | ------------------ |
| 1 | `ProjectStatePaths.ts`, redirect `runsRoot`, `.search-index` and the two project-scoped `.usage` files follow, fix the watcher (5.1), `FileAccessPolicy` `ownStateRoot` (5.2), `CTRLYOKE_HOME`, test conformance | **Yes** — this is the whole fix |
| 2 | `storage.runHistoryLocation` (5.4), plus the 2.6 messaging: QUICK_START/`docs/guide/` copy, generated `.gitignore` header, `ui.instructions.md` | Required in the same release as 1 |
| 3 | **Account/machine scope (2.2):** `notifications/`, `certs/` default to user scope, `provider-snapshots.json` → `~/.ctrlyoke/usage/` | Yes — fully independent, could go first |
| 4 | `history prune`, `history relink` | Yes |
| 5 | Read-side rollups: fold `observed-usage.json` buckets across projects (2.1) | Yes |

`scripts/migrate-runs-to-user-scope.mjs` (5.3) is not a phase — it is a personal
tool written alongside phase 1, run once per repo, and deleted.

Phase 3 has no dependency on the `ProjectStatePaths` work; if this plan stalls,
it is still worth landing on its own.

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

The cost, stated plainly: run history stops being shareable by commit *by
default*. Nobody was committing `.runs` — it has been gitignored the whole time —
so nothing regresses in practice, and `storage.runHistoryLocation: "workspace"`
(5.4) keeps the door open for anyone who wants it. If sharing a single run
becomes a real requirement, that still wants an explicit export/import (see
`HARNESS_SESSION_IMPORT_PLAN.md`) rather than a storage-location decision.

---

## 9. Open questions

1. **`@.ctrlyoke/.runs/…` references** (5.2) — keep resolving the old spelling
   against the new root, or introduce `@runs/…`? Needs a decision before phase 1
   lands. Note the harness-sandbox asymmetry in 2.3 applies here too: whatever the
   spelling, ctrlyoke resolves and injects the content, so the harness never needs
   filesystem access to the runs root.
2. **Multi-root workspaces** — one project dir per folder is the natural reading
   of the current per-`workspaceFolderPath` code, but confirm nothing assumes a
   single history across folders.
3. **`hash8` collision handling** — 8 hex chars over a user's project count is
   effectively safe, but `project.json` makes detection trivial. Fail loudly on
   a `statePath` mismatch, or extend to `hash12`? Cheap to decide, expensive to
   discover later.

**Resolved:** whether `storage.runHistoryLocation` could lag the move — it
cannot; per 2.6 it is the replacement for a documented affordance, so it ships in
the same release (phase 2).
