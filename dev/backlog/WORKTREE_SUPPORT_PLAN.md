# Git Worktree Support for Workflows

> **Status:** Design complete — ready to implement in phases.
>
> **Revision note (2026-07-28):** Revised across several codebase audits. The design
> uses sibling worktrees, lands branches by default, models state and execution
> roots separately, preserves existing parallel non-worktree execution through
> shared/exclusive execution leases, and makes managed-worktree cleanup, snapshots,
> undo, ownership, and merge behavior explicit.
>
> Latest pass closed three verified gaps — `.ctrlyoke/.gitignore` seeding so
> auto-commit cannot sweep runtime files into a user branch, an explicit answer for
> where ctrlyoke assets are discovered, and a single lease-scope definition — and
> corrected the undo model: ctrlyoke has exactly one undo mechanism (filesystem
> content restore), not a filesystem tier plus a git tier. The concurrency-warning
> threshold is explicitly unresolved rather than guessed.

---

## Goal

Give a workflow its own working directory so agents can run concurrently without
interfering with one another or with the user's live checkout.

There are two supported shapes:

1. **Managed worktree:** ctrlyoke creates a run-scoped worktree and branch, runs
   the workflow there, commits any resulting changes, removes the directory, and
   leaves the branch for review.
2. **Named worktree:** ctrlyoke targets a persistent worktree the user already
   owns, or creates it on first use. It never commits, merges, or removes that
   worktree automatically.

Existing non-worktree workflows remain supported and may continue running in
parallel exactly as they do today. Choosing worktree mode opts into stronger
directory isolation; it does not globally serialize ordinary workflows.

### The result lives in the branch

Git worktrees share the object store and refs. A managed branch remains visible
from the initiating checkout after its linked directory is removed:

```text
git diff <base-commit>...ctrlyoke/ui-refactor/run-2026-07-27T14-02-11
```

This avoids the unusable middle state where the agent worked in an ephemeral
directory but left no reviewable result behind.

### Non-goals for the first release

- A workflow does not switch worktrees between steps.
- A worktree does not span several repositories.
- ctrlyoke does not silently expose other repositories or non-repository
  workspace folders to a worktree run.
- Managed-worktree history does not provide undo after the worktree directory has
  been removed. ctrlyoke's only undo mechanism is filesystem content restore, so
  there is no git-based fallback. The captured diff and its attribution remain
  viewable.
- ctrlyoke does not automatically rebase, pull, or synchronize named branches.

---

## Git Worktree Model

A linked checkout of the same repository at a different path. Each worktree has
its own checked-out branch and working directory while sharing Git objects and
refs:

```text
C:\dev\FlightPath\                       branch: main
C:\dev\FlightPath.worktrees\ui-work\     branch: ui-work
C:\dev\FlightPath.worktrees\backend\     branch: backend
```

The harness process launches with its cwd in the selected worktree. From the
agent's perspective it is an ordinary repository checkout.

Two worktrees cannot check out the same branch simultaneously. Discovery and
errors must surface the existing checkout path rather than forwarding Git's raw
"already checked out" failure.

---

## Worktree Location

### Default layout

```text
<parentOf(sourceCheckoutRoot)>/<repoName>.worktrees/<safe-run-id>/
```

Example:

```text
C:\dev\FlightPath
C:\dev\FlightPath.worktrees\ui-refactor-a13f9082
```

The physical directory name is generated independently from the Git branch
name. It uses a readable, length-bounded slug plus a stable hash, so branch
slashes, long workflow names, collisions, and path traversal cannot affect
filesystem placement.

### Resolution order

1. User-scope `worktrees.root`, when configured. Accept an absolute path or a
   path beginning with `~`.
2. `<parentOf(sourceCheckoutRoot)>/<repoName>.worktrees/`.
3. `~/.ctrlyoke/worktrees/<repo-identity>/`.

`repo-identity` is a readable repository slug plus a hash of the canonical Git
common-directory identity. Flattening a path alone is insufficient because
different paths can flatten to the same string.

Root creation is the writability probe: attempt to create the directory and
fall back on an actual permission/filesystem failure. Do not rely only on
`fs.access(W_OK)`.

### Placement guards

After resolving symlinks and existing ancestors:

- Reject a configured root equal to or contained within the source checkout.
- Reject a configured root contained within any discovered worktree.
- Reject a worktree path that escapes its resolved worktree root.
- Warn, but do not fail, when the resulting root path exceeds 150 characters on
  Windows.

The worktree root setting is user-controlled only. Workspace-scope configuration
must not be able to redirect checkout creation to an arbitrary external
directory.

### Why worktrees are not nested under `.ctrlyoke/`

Nesting a worktree under the repository breaks or weakens several existing
systems:

| Problem                                                                               | Current evidence                        |
| ------------------------------------------------------------------------------------- | --------------------------------------- |
| TypeScript sees a second `src/**/*.ts` outside `rootDir` and fails with TS6059.       | `tsconfig.json`                         |
| Pure containment attributes nested worktree files to the source checkout.             | `src/utils/WorkspaceRepoDiscovery.ts`   |
| Snapshot walking excludes `.ctrlyoke`, so worktree changes disappear.                 | `src/utils/WorkspaceSnapshotService.ts` |
| `.ctrlyoke/` is not wholesale ignored or runtime-only.                                | `.gitignore`, `WorkspaceInitializer.ts` |
| `git clean -xdf` can destroy the nested checkout and orphan Git administration state. | Git behavior                            |
| Search, watchers, linting, tests, and bundlers see a second repository copy.          | Tool behavior                           |

Sibling placement is therefore a correctness requirement, not only a
convention.

### Fresh-checkout consequences

A new managed worktree does not contain ignored files such as `node_modules`,
local `.env` files, generated assets, or initialized caches. Managed mode is not
considered ready until it supports a setup command that runs once after
creation and before the first workflow step.

Setup failure marks the worktree blocked and leaves the directory in place for
inspection. ctrlyoke must never delete a directory after a failed setup if that
directory contains uncommitted changes. Persist the blocked state and release
the execution lease so recovery is possible. Reuse the existing script
execution/reporting infrastructure with the worktree as cwd rather than adding
a second shell runner.

### Seeding `.ctrlyoke/.gitignore` in the worktree

A fresh worktree usually has **no `.ctrlyoke/.gitignore`**, and without it managed
auto-commit sweeps ctrlyoke's own runtime files into the user's branch.

`WorkspaceInitializer.ensureGitignore` only ever manages `<ctrlyokeDir>/.gitignore`;
it never writes to the repository root. That generated file lists `.gitignore`
among its own entries (`WorkspaceInitializer.ts:15`), so it ignores itself, stays
untracked, and is absent from any fresh checkout. Meanwhile the role table below
routes temp prompt files, hook artifacts, and notification directories to
`<executionRoot>/.ctrlyoke/`. Those paths are then non-ignored, and managed
finalization commits "all tracked/untracked, non-ignored changes."

This repository is incidentally immune — `.ctrlyoke/.gitignore` was force-added
here and the root `.gitignore` duplicates the entries by hand — so the failure
will not reproduce locally. Neither condition holds for a typical user repository.

**Requirement:** call `WorkspaceInitializer.initializeIfNeeded(executionRoot)`
immediately after creating or attaching a worktree and before running `setup`, so
the ignore file exists before the first harness write. This is idempotent and
reuses existing code. Auto-commit must additionally verify that no path under
`.ctrlyoke/` runtime directories is staged, and fail finalization as `blocked`
rather than committing them if the guard trips.

---

## Execution Workspace and Root Separation

The current code uses "workspace root" for state storage, process cwd, prompt
resolution, script security, snapshots, MCP routing, and multi-root access.
Worktree support makes those roles distinct.

Use one immutable execution-workspace contract rather than threading an
optional cwd through individual calls:

```typescript
interface ExecutionWorkspace {
  /** Where ctrlyoke stores .ctrlyoke/.runs, history, queue state, and locks. */
  stateRoot: string;

  /** The cwd used by the harness, scripts, conditions, and temp prompt files. */
  executionRoot: string;

  /** The checkout from which the worktree was created and optional merge targets run. */
  sourceCheckoutRoot: string;

  /** Trusted roots as seen by the executing harness, with repo-owned roots remapped. */
  workspaceRoots: string[];

  /** Name/path pairs used by multi-root references and snapshots, also remapped. */
  namedWorkspaceRoots: ResolverWorkspaceFolder[];
}
```

When no worktree is active:

```text
executionRoot = stateRoot
workspaceRoots = platform.getWorkspaceRoots()
namedWorkspaceRoots = platform.getNamedWorkspaceRoots()
```

That no-worktree case must remain behaviorally identical to today.

### Mapping a checkout into a worktree

For a source root contained in the repository:

```text
mappedRoot = join(worktreeToplevel, relative(sourceCheckoutRoot, sourceRoot))
```

Every named workspace root belonging to the repository is mapped this way.

`stateRoot` can legitimately be outside the repository, for example when it is
the directory containing a saved `.code-workspace` file. In that case:

- `stateRoot` remains unchanged for ctrlyoke state.
- `executionRoot` is the worktree toplevel.
- Every named repository root is remapped into the worktree.

This avoids `relative(repoRoot, stateRoot)` producing an escaping `..` path.

### Role assignment

| Role                                                      | Root                                |
| --------------------------------------------------------- | ----------------------------------- |
| Harness process cwd                                       | execution                           |
| Temp prompt and harness-config files                      | execution                           |
| Relative `@` references and prompt rendering              | execution plus remapped named roots |
| Claude/Qwen session-log project lookup                    | execution                           |
| Provider hooks, notifications, and workspace-local config | execution                           |
| `preCondition`, `endCondition`, and script cwd            | execution                           |
| Script-path security allowlist                            | execution plus user home scripts    |
| Snapshot capture and per-repo discovery                   | execution plus remapped named roots |
| Harness `--add-dir` workspace arguments                   | remapped execution workspace roots  |
| `endCondition` / `preCondition` script **files**          | execution plus user home scripts    |
| Agent, skill, and template **definition files**           | state (see below)                   |
| Workflow/prompt file discovery                            | state                               |
| MCP `CTRLYOKE_WORKSPACE`                                  | state                               |
| MCP `CTRLYOKE_WORKING_FILE`                               | state working-file path             |
| Run storage, lineage, history, runner locks               | state                               |

`CliMcpConfigGenerator` therefore needs separate locations for where it writes
its temporary config and which state root it exports to the MCP server.

`EndConditionEvaluator` must accept the execution workspace as both cwd and an
allowed script root. Merely changing cwd would cause its existing security check
to reject scripts inside the sibling worktree.

### ctrlyoke asset discovery

The split above assigns where the harness _runs_. It must also state where
user-authored ctrlyoke assets are _found_, because the two answers differ and the
difference is currently accidental rather than chosen.

**Decision for the first release: assets resolve from `stateRoot`; scripts resolve
from `executionRoot`.**

Scripts follow execution because `EndConditionEvaluator.resolveScriptPath` is
already parameterized by root, and because a condition script exists to test the
code the agent just wrote — the branch's version is the correct one.

Agents, skills, and templates stay on state because `AgentDiscovery.ts:128` and
`SkillDiscovery.ts:104` read `workspaceFolder.uri.fsPath` directly from VS Code
and are not parameterized by root at all. Making them follow the execution root is
a real refactor, not a plumbing change. Keeping them on state also preserves
uncommitted local agent/skill definitions, which users commonly rely on and which
would silently vanish inside a fresh worktree.

The consequence is a known, accepted inconsistency: a workflow whose branch edits
an agent or skill definition still runs with the source checkout's version.
`SkillDiscovery.ts:138` additionally calls `findGitRoot()`, whose behavior inside a
linked worktree is unexamined; it is not reached while discovery stays on state,
and revisiting this must include it.

Assert this in tests so it cannot drift silently. Parameterizing the discovery
modules is deferred to Phase 5.

### Integration lifecycle

`IntegrationFactory.createForExecution()` receives the immutable
`ExecutionWorkspace`. `CliIntegration` exposes explicit state/execution accessors
instead of changing the meaning of `getWorkspaceRoot()` invisibly.

An integration retained for PTY injection or post-completion session activity
is reusable only when the next execution has the same execution-workspace
identity. Managed-run finalization must dispose retained integrations and
session watchers before committing or removing their directory.

---

## Workspace Eligibility

A worktree checks out exactly one repository. The first release uses a strict,
structural rule:

1. Discover repositories from all named workspace roots.
2. Require exactly one distinct repository.
3. Require every named workspace root to be contained within that repository.
4. Permit `stateRoot` itself to sit outside the repository solely as ctrlyoke
   state storage.

**A multi-root workspace is not disqualified by being multi-root.** A monorepo
opened as several workspace folders passes: `discoverRepos` collapses roots sharing
a Git toplevel to one entry, every root is contained in that repository, and each
one remaps into the worktree independently. What is refused is _multiple
repositories_, and roots that fall outside the sole repository.

Refuse worktree mode when:

- No Git repository is present.
- More than one repository is present.
- A named root is not inside the sole repository.

This intentionally rejects non-repository passthrough roots. Passing those
roots to `--add-dir` would give the agent write access to live files and create
the same silent partial-isolation problem as worktreeing only one repository in
a multi-repo workspace.

Deferred designs:

- Explicit read-only passthrough roots.
- `worktree: { repo: "repoA" }` in a multi-repo workspace.
- One worktree per repository.

---

## Lifecycle Modes

### Managed / ephemeral

Shorthand:

```yaml
worktree: true
```

Lifecycle:

1. Promote/resolve the run so `workflowKey` and `runRef` are stable.
2. Capture the source checkout path, target branch, and exact base commit.
3. Create an ownership record in Git administrative storage.
4. Create the managed branch and linked worktree from the captured base commit.
5. Persist creating worktree runtime metadata through `WorkingFileManager`.
6. Acquire an exclusive execution lease for that worktree.
7. Seed `.ctrlyoke/.gitignore` into the worktree before any harness write.
8. Run the configured setup command once.
9. Persist active worktree runtime metadata through `WorkingFileManager`.
10. Run every workflow phase there.
11. On terminal settlement, stop integrations and clean provider artifacts.
12. Auto-commit all tracked/untracked, non-ignored changes.
13. Optionally merge when explicitly requested.
14. Remove the worktree directory unless `keep: true` or safe finalization
    failed.
15. Leave the branch and ownership record for review/cleanup.

Terminal settlement includes successful completion, cancellation, stopped
execution, and handled execution failure. Partial work is still data and must be
landed safely. A pause is not terminal: the worktree and lease stay live.

If auto-commit fails because of Git identity, hooks, signing, filesystem errors,
or another cause, finalization becomes blocked and the directory remains.

### Named / persistent

Shorthand:

```yaml
worktree: ui-work
```

Behavior:

- Resolve an existing worktree by its local branch name.
- If the branch exists but is not checked out, attach a worktree under the
  configured root.
- If neither branch nor worktree exists, create both from the captured base.
- Acquire an exclusive execution lease before running setup or workflow code.
- Run setup only when ctrlyoke creates the named worktree.
- Never auto-commit, merge, remove, or delete the branch.

Once created, a named worktree is user-owned even though ctrlyoke performed the
initial creation.

### Finalization order

Managed finalization must occur in this order:

1. Stop session activity watchers and background monitors.
2. Dispose integrations rooted in the worktree; do not park them for injection.
3. Restore/clean provider-specific hook and MCP config artifacts.
4. Remove temporary runtime trust grants that are no longer needed.
5. Auto-commit the remaining user/agent changes.
6. Perform optional merge handling.
7. Remove the worktree if allowed.
8. Release the execution lease.
9. Persist the final branch and directory outcomes.

The lease remains held through commit and removal so another process cannot
enter halfway through finalization. Because leases live in Git administration
storage rather than the checkout, `git add -A` cannot commit them.

### Completion result

Branch state and directory state are independent:

```typescript
interface WorktreeCompletionResult {
  branchOutcome:
    | "landed"
    | "merged"
    | "nothing-to-merge"
    | "conflict"
    | "blocked";
  directoryOutcome: "removed" | "kept" | "remove-failed";
  branchName: string;
  targetBranch?: string;
  mergeStrategy?: "fast-forward" | "merge-commit";
  conflictFiles?: string[];
  autoCommitted?: boolean;
  message?: string;
}
```

`keep: true` affects only directory cleanup; it does not erase whether the
branch landed or merged.

---

## Optional Merge

Merging is opt-in:

```yaml
worktree:
  mode: managed
  merge: true
```

The merge target is the source checkout and branch captured when the managed
worktree was created. It is never "whatever branch happens to be current later."

Merge sequence:

1. Auto-commit worktree changes.
2. Compare managed `HEAD` to the captured base commit.
3. If unchanged, remove the worktree and delete the empty managed branch.
4. Require the source checkout to still be on the captured target branch.
5. Require the source checkout working tree and index to be clean.
6. Attempt `git merge --ff-only`.
7. If the histories diverged, attempt a non-interactive `git merge --no-ff --no-edit`.
8. On conflict, collect unmerged paths **before** `git merge --abort`.
9. Verify abort restored a clean, non-merging state.
10. Leave the managed branch for manual resolution/review.

The source checkout may advance on the same target branch while the agent runs;
that simply determines whether the merge is fast-forward or a merge commit.

Creation itself does not require a clean source checkout because a worktree is
created from a commit, not the source index. Uncommitted source-checkout changes
are not copied into the worktree; surface that fact in run details. Declarative
merge is unavailable when the captured source checkout was detached.

The same merge engine serves:

- Declarative `merge: true`.
- The dashboard's explicit **Merge** action.

The UI action must not be exposed before that engine exists.

---

## Discovery and Ownership

Run `git worktree list --porcelain` through a single parser that represents:

- Worktree path.
- HEAD commit.
- Optional local branch.
- Detached state.
- Bare state.
- Locked state and reason.
- Prunable state and reason.

Discovery is not ownership. A `ctrlyoke/` branch prefix is a naming convention,
not proof that ctrlyoke may delete anything.

### Durable ownership records

Managed worktrees get an atomic record under the repository's Git common
directory:

```text
<git-common-dir>/ctrlyoke/managed-worktrees/<branch-hash>.json
```

The record includes:

- Schema version.
- Branch name and worktree path.
- Source checkout root.
- Base commit and target branch.
- Host `stateRoot`.
- `workflowKey` and `runRef`.
- Created timestamp.
- Current directory/branch outcomes.

This survives linked-directory removal and supports safe branch cleanup. A
branch prefix, path under the configured worktree root, or runtime working file
alone is never sufficient authority to delete a branch.

### Recovery

Creation and finalization are idempotent:

- If a managed run resumes and its ownership record plus worktree still exist,
  reuse them.
- If the directory is gone but the branch exists, reconcile the run as landed.
- If the worktree exists but the originating runner and execution lease are
  stale, expose it as recoverable.
- If the branch was deleted manually, remove the stale ownership record after
  confirmation or safe reconciliation.

Activation performs read-only discovery and reports recoverable managed
worktrees. It does not delete user worktrees automatically.

---

## Concurrency: Shared and Exclusive Execution Leases

The existing `runner.json` remains the per-lineage execution lock. Worktree
support adds a second mechanism for directory-level coordination across
ctrlyoke instances.

A single exclusive `execution-lock.json` would unnecessarily prevent today's
parallel non-worktree workflows. Use a lease set instead:

| Run                            | Lease mode           | Compatible leases in the same execution root |
| ------------------------------ | -------------------- | -------------------------------------------- |
| Ordinary non-worktree workflow | `shared-native`      | Other `shared-native` leases                 |
| Managed worktree workflow      | `exclusive-worktree` | None                                         |
| Named worktree workflow        | `exclusive-worktree` | None                                         |

Leases are scoped by **canonical lease-scope identity**, defined once as: the
worktree-specific Git administrative directory when the execution root is inside a
Git repository, and the canonical execution-root path otherwise. Both storage
locations below derive from that single definition — an earlier draft described
leases as keyed by execution root while storing them by Git directory, which are
different keys and would diverge the moment eligibility rules relax.

Because one worktree hosts exactly one run under the eligibility rules, Git-directory
scope and execution-root scope currently coincide. Any future change that allows
several concurrent runs inside one worktree must revisit this definition before
relying on it.

Therefore:

- Several ordinary workflows can continue running in the source checkout.
- Managed worktrees run concurrently with them because each has a unique root.
- Different named worktrees run concurrently.
- Two worktree-targeted workflows cannot use the same named worktree.
- A worktree-targeted workflow cannot enter a named worktree while a VS Code
  window opened on that worktree is running ordinary workflows there.
- Ordinary workflows started in a directory with an exclusive worktree lease
  are blocked until that lease ends.

Parallel native workflows retain today's interference risk by explicit design.
Users choose worktree mode when they require isolation.

### Lease storage

For Git roots, store leases in the worktree-specific Git administrative
directory resolved by Git, not inside the checkout:

```text
git rev-parse --git-path ctrlyoke/execution-leases
```

```text
ctrlyoke/execution-leases/
  <owner-token>.json
```

For a non-Git ordinary execution root, fall back to:

```text
<executionRoot>/.ctrlyoke/execution-leases/
```

Each lease contains:

```typescript
interface ExecutionLease {
  ownerToken: string;
  mode: "shared-native" | "exclusive-worktree";
  pid: number;
  runner: "vscode" | "cli";
  instanceId: string;
  stateRoot: string;
  executionRoot: string;
  workflowKey: string;
  runRef: string;
  startedAt: number;
  lastHeartbeat: number;
}
```

Acquisition performs scan, stale cleanup, compatibility validation, and
exclusive file creation while holding a short arbitration lock. This prevents a
shared/exclusive check-create race across processes. Every run owns its own
lease file, so one shared workflow finishing cannot release another's lease.

Reuse the existing runner-lock safety model and its actual constants from
`WorkflowLockManager` rather than inventing a second cadence:

- Random owner token.
- `ACQUIRE_TIMEOUT_MS = 5_000` — how long acquisition waits on a lease that is
  still live before failing.
- `STALE_HEARTBEAT_MS = 30_000` — a lease is reclaimable when its PID is dead or
  its `lastHeartbeat` is older than this.
- Heartbeat writes must stay comfortably inside the staleness window; extract the
  interval alongside the constants rather than duplicating a literal.
- Owner-token verification on update and release.
- Actionable owner information in conflicts.

Extract these primitives so `WorkflowLockManager` and `ExecutionRootLeaseManager`
share one implementation; the two locks answer different questions but must not
drift apart on staleness semantics.

### Lease UX

An incompatible live lease is a hard failure in the first release. Do not queue
or prompt.

The error reports:

- Owning workflow and run.
- Runner/instance and PID.
- Owning state root.
- Lease age.
- Retry action.
- Open Owning Workspace action where available.

Worktree discovery renders any root with a live lease as **in use**.

---

## Workflow Schema

`worktree` is workflow-level only. Introduce a separate
`workflowOnlyProperties` definition and apply it to both top-level workflow
shapes (single-step root and multi-step/working-file root). Do not add it to the
shared `executionProperties` definition used by nested steps and runtime
metadata.

Supported forms:

```yaml
worktree: false                 # explicit no-worktree
worktree: true                  # managed shorthand
worktree: ui-work               # named shorthand

worktree:
  mode: managed
  merge: false
  keep: false
  base: main
  setup: npm ci

worktree:
  mode: named
  branch: ui-work
  base: main
  setup: npm ci
```

TypeScript contract:

```typescript
type WorktreeConfig =
  | boolean
  | string
  | {
      mode: "managed";
      merge?: boolean;
      keep?: boolean;
      base?: string;
      setup?: string;
    }
  | {
      mode: "named";
      branch: string;
      base?: string;
      setup?: string;
    };
```

Rules:

- `true` means `{ mode: "managed" }`.
- A string means `{ mode: "named", branch: value }`.
- `false` or omission means ordinary execution.
- `merge` and `keep` are not legal in named mode.
- `branch` is required in named object mode and illegal in managed mode.
- The default base is the source checkout's exact `HEAD` commit.
- `base` must resolve to a commit before any directory is created.
- `base` affects creation only; it is ignored when resolving an existing named
  branch/worktree.
- `setup` runs once only when ctrlyoke creates the worktree.

JSON Schema performs structural and coarse character validation. Runtime
validation calls:

```text
git check-ref-format --branch <branch>
```

The validated branch string is never used as a filesystem-relative path.
There are no reserved string names; a quoted branch named `auto` is simply a
named branch.

Do not add a global `worktree.enabled` or default-on setting. Worktree behavior
must be explicit in the workflow. The only initial global setting is the
user-scope worktree root.

Expose schema forms only when their behavior is implemented. For example,
`merge` must not validate before the merge engine exists.

---

## Core Architecture

### `GitUtils`

Pure Git plumbing stays in `src/utils/GitUtils.ts`. Move the existing private
Git-toplevel implementation from `WorkspaceRepoDiscovery` into this module so
repo identity has one source.

```typescript
interface GitWorktreeEntry {
  worktreePath: string;
  headCommit: string;
  branchName?: string;
  detached: boolean;
  bare: boolean;
  lockedReason?: string;
  prunableReason?: string;
}

export async function repoToplevel(dir: string): Promise<string | null>;
export async function gitCommonDir(dir: string): Promise<string | null>;
export async function gitPath(dir: string, relativePath: string): Promise<string | null>;
export async function listWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]>;
export async function addWorktree(...): Promise<void>;
export async function removeWorktree(...): Promise<void>;
export async function pruneWorktrees(...): Promise<void>;
export async function currentBranch(dir: string): Promise<string | null>;
export async function resolveCommit(dir: string, ref: string): Promise<string>;
export async function hasUncommittedChanges(dir: string): Promise<boolean>;
export async function commitAll(dir: string, message: string): Promise<boolean>;
```

`src/git/` remains limited to commit-message generation per its existing
instructions.

### `WorktreeManager`

`src/core/orchestration/WorktreeManager.ts` owns policy and lifecycle:

```typescript
type WorktreeMode = "managed" | "named";
type WorktreeOrigin = "created" | "discovered" | "recovered";
type WorktreeLifecycleOwner = "ctrlyoke" | "user";

interface WorktreeInfo {
  mode: WorktreeMode;
  origin: WorktreeOrigin;
  lifecycleOwner: WorktreeLifecycleOwner;
  branchName: string;
  worktreePath: string;
  sourceCheckoutRoot: string;
  baseCommit: string;
  targetBranch?: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  createdAt: number;
  executionWorkspace: ExecutionWorkspace;
}

class WorktreeManager {
  async resolveWorktreeRoot(sourceCheckoutRoot: string): Promise<string>;
  async listWorktrees(sourceCheckoutRoot: string): Promise<GitWorktreeEntry[]>;
  async ensureManagedWorktree(...): Promise<WorktreeInfo>;
  async resolveNamedWorktree(...): Promise<WorktreeInfo>;
  async recoverManagedWorktree(...): Promise<WorktreeInfo | undefined>;
  async completeManagedRun(...): Promise<WorktreeCompletionResult>;
  async removeManagedWorktree(...): Promise<void>;
  async discoverRecoverableManagedWorktrees(...): Promise<WorktreeInfo[]>;
}
```

Public removal never uses force automatically. A force operation is an explicit,
confirmed Manage Worktrees action.

### `ExecutionRootLeaseManager`

`src/core/orchestration/ExecutionRootLeaseManager.ts` owns the shared/exclusive
lease protocol and reuses/extracts the heartbeat and owner-token primitives
currently embodied by `WorkflowLockManager`.

It is separate from lineage runner locking because the two locks answer
different questions:

- Runner lock: who executes this lineage/run?
- Execution lease: which runs may use this directory concurrently?

### Runtime trusted roots

Do not persist worktree paths into `ExternalRootsTrustStore`; that store records
user decisions about workspace-requested external roots.

Add a process-session, owner-token/ref-counted runtime trusted-root registry.
File-access callers combine:

- Workspace roots.
- User-approved external roots.
- Validated runtime worktree roots.

The harness itself receives the worktree through its remapped execution
workspace, not by pretending it is a user-approved external root.

Grant lifetime:

- Managed ephemeral: while the worktree exists.
- Named/kept: while the associated run/session is loaded or discoverable in the
  current ctrlyoke process and the path still resolves to the same repository.

This keeps output file links usable after a named run completes without
persisting a permanent trust decision.

### Repo discovery and snapshots

Snapshot capture receives the execution workspace's remapped named roots.
Hosted SCM/file attribution may additionally probe active runtime worktree
roots, but must distinguish the source checkout and linked checkout rather than
assuming they are one toplevel.

Adding only the worktree path as an extra global repo probe is insufficient:
prefix mapping and snapshot capture must also use the execution-scoped roots.

### Working-file persistence

`WorkingFileManager` remains the only writer of
`workflow.ctrlyoke.json`. Worktree lifecycle code updates runtime metadata
through a typed `WorkingFileManager`/queue seam; it does not write the JSON file
directly.

```typescript
interface WorkingFileWorktreeRuntime {
  mode: "managed" | "named";
  branchName: string;
  worktreePath: string;
  executionRoot: string;
  sourceCheckoutRoot: string;
  baseCommit: string;
  targetBranch?: string;
  lifecycleOwner: "ctrlyoke" | "user";
  state:
    | "creating"
    | "active"
    | "paused"
    | "finalizing"
    | "landed"
    | "merged"
    | "conflict"
    | "blocked"
    | "orphaned";
  directoryState: "present" | "removed" | "remove-failed";
  mergeStrategy?: "fast-forward" | "merge-commit";
  conflictFiles?: string[];
  updatedAt: number;
}

interface WorkingFileRuntime {
  // existing fields...
  worktree?: WorkingFileWorktreeRuntime;
}
```

Every ordinary runtime update must preserve this nested block. Promotion to a
new run starts with no old worktree runtime and resolves a fresh worktree after
the new `RunRef` exists.

### Parser and property persistence

Adding the schema/type is not enough. Keep all workflow-property paths aligned:

- `PromptFileParser.copyWorkflowLevelProperties`
- The parser's single root-level script normalization path, which currently
  returns before workflow properties are copied
- `PromptFileLoader` workflow property extraction
- Working-file seed/promote/re-run paths
- Dashboard workflow-property constants and payload normalization, if the
  property is editable there

Worktree resolution is workflow-level plus explicit runtime defaults only. It
does not use the prompt > workflow > settings `PropertyResolver.resolve()` path
because step-level worktree overrides are forbidden.

---

## Snapshots, Diffs, and Undo

### Capture

Before/after snapshots run against:

- `executionRoot` for the primary capture.
- Remapped `namedWorkspaceRoots` for multi-root segments.
- The linked worktree's Git toplevel, not the source checkout.

Persisted snapshot repo metadata therefore names the actual checkout used by the
agent.

### Active and persistent worktrees

Named and `keep: true` worktrees support existing per-step filesystem undo as
long as:

- The worktree still exists.
- It resolves to the recorded repository/branch identity.
- The undo coordinator uses the recorded execution root and remapped named
  roots, not the window's current source roots.

### Landed managed branches

**There is only one undo mechanism, and it is filesystem content restore.**
`UndoRedoCoordinator` routes every undo and redo through
`snapshotService.undoFiles(...)` (`src/ui/UndoRedoCoordinator.ts:163`), which writes
stored before-content back to resolved paths. No revert, reset, or checkout path
exists. Git participates only as a _source of before-content_ when a snapshot's
base source is `GIT_HEAD` — never as the mechanism that performs the undo.

So after a managed directory is removed there is no "git-based undo" to fall back
on. What survives is the recorded diff and its attribution, which are persisted
snapshot data and remain fully viewable. Reverting a landed branch is an ordinary
Git operation the user performs themselves.

After a managed directory is removed:

- Keep snapshot diffs and repo attribution viewable.
- Disable filesystem undo with a clear "worktree landed as branch" explanation.
- Offer View Branch Diff and, when implemented, Merge.

**Disabling the button is not sufficient.** `applySnapshotEntries` resolves paths
against `getVsCodeNamedWorkspaceRoots()` (`src/ui/UndoRedoCoordinator.ts:155`) —
the _current window's_ roots, not the roots the run actually executed against. Any
undo entry belonging to a worktree run would therefore resolve into the source
checkout and write there. The coordinator itself needs a guard that refuses to
apply an entry whose recorded execution workspace is absent or does not match, so
a stale UI state, a queued request, or a future caller cannot bypass the UI check.

Recreating a temporary worktree to apply a reverse patch and commit the result is
deferred. The UI must not silently redirect historical undo into the user's source
checkout.

---

## Dashboard and CLI UX

Running:

```text
▶ ui-refactor   [claude-cli] [sonnet]  ● running
  Branch: ctrlyoke/ui-refactor/run-2026-07-27T14-02-11
  Worktree: ..\FlightPath.worktrees\ui-refactor-a13f9082
```

Completion:

- `✓ branch ready — 12 files` with **View Diff**
- **Merge** only after the shared merge engine exists
- `✓ merged (fast-forward)`
- `✓ merged (merge commit)`
- `✓ no changes`
- `⚠ merge conflict — branch preserved`
- `⚠ merge blocked — source checkout changed or is dirty`
- `⚠ commit blocked — worktree kept at …`
- `⚠ worktree removal failed — branch safe, directory kept`

Actions:

- **View Diff** uses the recorded base commit and managed branch.
- **Open Worktree in New Window** appears only while the directory exists.
- **Merge** re-runs every dirty/branch/lease guard at click time.
- **Manage Worktrees** lists ownership, lease state, branch state, age, and
  safe actions.

Paths render relative to the source checkout parent when possible, absolute
otherwise.

### `ctrlyoke_global_status`

Expose persisted worktree runtime:

```json
{
  "workflowName": "ui-refactor",
  "executionState": "running",
  "worktree": {
    "mode": "managed",
    "branchName": "ctrlyoke/ui-refactor/run-2026-07-27T14-02-11",
    "worktreePath": "C:/dev/FlightPath.worktrees/ui-refactor-a13f9082",
    "state": "active",
    "directoryState": "present"
  }
}
```

`WorkspaceSessionManager.discoverSessions()` includes the branch and worktree
state in its detail string.

### Named branch divergence

Show cached, non-blocking ahead/behind information when a comparison base is
known:

```text
ui-work — 7 ahead, 14 behind main
```

Use the recorded base/upstream and label it. Do not infer an unlabeled base from
whatever branch happens to be checked out, and never auto-sync.

---

## Cleanup and Retention Decisions

### Concurrency ceiling — UNRESOLVED

There is no hard maximum in the first release. Repository size, dependency layout,
and available disk vary too much for a universal cap. That much is settled.

**The warning threshold is not settled and must not be implemented on a guess.**
An earlier draft specified "warn at approximately the sixth active managed
worktree." That number has no basis — it was invented, not measured. Ship without
a threshold, observe real usage, then choose one.

When a threshold is eventually added, it should count live managed execution
leases (not persistent or landed worktrees) and surface the active count plus the
resolved worktree root. Do not add `worktree.maxConcurrent` until usage
demonstrates a need.

### Landed branch retention

Never delete landed branches automatically in the first release.

Manage Worktrees provides bulk cleanup. It may preselect only branches that:

- Have a valid ctrlyoke ownership record.
- Are not checked out in any worktree.
- Have no live/recoverable run or lease.
- Are proven fully merged into their recorded target branch.

Squash/rebase merges are not provable through ancestry and remain explicit
user-selected deletions.

### Manual directory deletion and pruning

Use discovery at activation and mutation on demand:

- Activation performs `git worktree list --porcelain` and read-only stale/
  prunable reporting.
- Manage Worktrees offers explicit prune.
- Resolving a requested branch with a stale admin entry offers targeted repair.
- ctrlyoke may automatically reconcile only an entry proven managed by its
  ownership record and protected by no live lease.

Never automatically run `git worktree prune --expire now` against user-owned
entries. A temporarily unavailable network/removable path can look deleted.

### Execution lease conflicts

Incompatible leases fail immediately with owner details and Retry/Open actions.
No cross-process queue is introduced in the first release.

---

## Harness Coverage

The supported CLI harness set is the six entries in `HARNESS_IDS`:

- `copilot-cli`
- `claude-cli`
- `codex-cli`
- `opencode-cli`
- `qwen-cli`
- `antigravity-cli`

All six must use the same execution-workspace contract.

Provider-specific verification:

- Claude and Qwen session-log lookup follows `executionRoot`.
- Every provider's hook/notification path follows `executionRoot`.
- Provider workspace-local settings/hook files are restored before managed
  commit.
- `CTRLYOKE_WORKSPACE` remains `stateRoot`.
- Workspace/additional-directory arguments use remapped roots and never expose
  the live source checkout during a worktree run.
- Retained PTY/session activity integrations cannot survive managed directory
  removal.

Real-harness tests remain focused on behavior mocks cannot prove; ordinary
path-routing coverage belongs in unit/integration tests.

---

## Files and Cross-Layer Changes

The exact diff may evolve, but the implementation must cover these areas.

| Area                      | Files / responsibility                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Workflow contracts        | `src/types/CtrlYokeTypes.ts`, `src/types/WorkflowContextTypes.ts`                                                |
| Shared constants/messages | `DashboardConstants.ts`, `WebviewMessageTypes.ts`, output/status contracts                                       |
| Config                    | `CtrlYokeSettings.ts`, `ConfigurationUtils.ts`, config/settings UI; user-scope `worktrees.root`, no `.enabled`   |
| Schema/parser             | `schemas/workflow-schema.json`, `PromptFileParser.ts`, `PromptFileLoader.ts`                                     |
| Runtime persistence       | `WorkingFileManager.ts`, queue access seam, `WorkflowInstance.ts`                                                |
| Execution roots           | `IntegrationFactory.ts`, `CliIntegration.ts`, transport/runner/prompt/MCP helpers                                |
| Scripts/conditions        | `WorkflowExecutor.ts`, `EndConditionEvaluator.ts`                                                                |
| Git/worktrees             | `GitUtils.ts`, new `WorktreeManager.ts`, ownership record helper                                                 |
| Worktree scaffolding      | `WorkspaceInitializer.ts` — seed `.ctrlyoke/.gitignore` into a new worktree before first write                   |
| Concurrency               | new `ExecutionRootLeaseManager.ts`; extract shared lease primitives from `WorkflowLockManager`                   |
| Snapshots/repos           | `WorkspaceSnapshotService.ts`, `WorkspaceRepoDiscovery.ts`, `UndoRedoCoordinator.ts` (execution-workspace guard) |
| Runtime file trust        | new session registry plus file-access callers; do not persist into `ExternalRootsTrustStore`                     |
| Recovery/status           | `WorkspaceSessionManager.ts`, activation recovery, `mcp-server.ts`                                               |
| UI actions                | router/sink/message handler/store plus workflow status/steps components                                          |
| VS Code commands          | Open Worktree, View Diff, Merge, Manage Worktrees                                                                |
| Tests                     | focused Git, manager, lease, persistence, lifecycle, snapshot/undo, UI, and provider-routing tests               |

Dynamic completion of discovered branch names is optional ergonomics and should
not be claimed as a schema capability. Static schema completion covers the
property shape; a separate top-level completion provider would be required for
live branch values.

---

## Test Matrix

### Root split

- No-worktree paths and arguments remain identical.
- Saved `.code-workspace` state root outside the repo maps safely.
- Several named roots inside one repo remap correctly.
- Non-repo named root and multi-repo workspace refuse worktree mode.
- Script path resolution accepts the worktree and rejects escapes.
- Condition scripts resolve from the execution root; agents and skills resolve
  from the state root.
- MCP state variables remain rooted at `stateRoot`.

### Schema and persistence

- Worktree is accepted at workflow root and rejected on steps/finalStep runtime.
- Parser and loader preserve every shorthand/object form.
- Promotion/re-run keeps the definition and starts fresh runtime metadata.
- Ordinary runtime writes preserve `_runtime.worktree`.

### Leases

- Two shared-native leases coexist.
- Exclusive acquisition fails while any live lease exists.
- Shared acquisition fails while an exclusive lease exists.
- Exclusive leases on different roots coexist.
- Stale shared/exclusive leases are reclaimed.
- Owner-token release cannot delete another run's lease.
- Scan/check/create is race-safe across processes.

### Named worktrees

- Discover existing branch checkout.
- Attach an existing un-checked-out branch.
- Create a missing branch/worktree and run setup once.
- Never commit/remove a named worktree.
- Native run in the same worktree blocks exclusive targeting.

### Managed worktrees

- Safe branch/path creation from captured base.
- Ownership record creation and recovery.
- Setup success/failure behavior.
- Auto-commit and branch landing.
- Cancellation/failure lands partial work.
- Commit failure keeps the directory.
- Removal failure is reported without losing the branch.
- Retained integrations are disposed before finalization.
- Nothing-to-commit and `keep: true`.

### Merge

- Target branch changed.
- Dirty source checkout.
- Fast-forward.
- Merge commit.
- Conflict paths captured before abort.
- Abort failure.
- Empty branch cleanup.

### Snapshots and undo

- Snapshots capture only the worktree checkout.
- Same-repo multi-root segments use remapped paths.
- Named/kept undo targets the worktree.
- Landed managed runs disable filesystem undo and retain diff display.
- The coordinator refuses an undo entry whose recorded execution workspace is
  missing or mismatched, even when invoked directly rather than through the UI.
- An undo entry from a worktree run never resolves paths into the source checkout.

### Worktree hygiene

- A monorepo opened as several workspace roots is accepted, not refused.
- A newly created worktree has `.ctrlyoke/.gitignore` before the first harness
  write.
- Auto-commit of a managed run stages no `.ctrlyoke/` runtime path, in a
  repository whose root `.gitignore` says nothing about `.ctrlyoke/`.
- Auto-commit fails as `blocked` rather than committing runtime files when the
  guard trips.
- Condition scripts resolve from the worktree; agents and skills resolve from the
  source checkout (asserted, so the accepted inconsistency cannot drift).

### Security

- Branch traversal strings fail semantic validation.
- Directory name never derives directly from the branch.
- Configured worktree root inside a checkout is rejected.
- Ownership prefix alone cannot authorize deletion.
- Workspace-scope config cannot redirect worktree root placement.

---

## Implementation Order

### Phase 1 — Typed execution-workspace split

1. Introduce `ExecutionWorkspace`.
2. Preserve byte-equivalent/no-op behavior when no worktree is active.
3. Route process cwd, temp files, refs, hooks, notifications, and log parsers
   through execution roots.
4. Route MCP state variables explicitly through state roots.
5. Update script/condition security to accept execution roots.
6. Make snapshots accept execution-scoped primary and named roots.
7. Add mapping and no-op tests.

This phase changes vocabulary and dependency boundaries but exposes no worktree
schema.

### Phase 2 — Named worktrees and execution leases

8. Consolidate Git identity helpers and implement porcelain parsing.
9. Implement strict workspace eligibility and safe root resolution.
10. Implement `ExecutionRootLeaseManager` shared/exclusive leases.
11. Add named worktree schema forms, parser, loader, and runtime persistence.
12. Implement named discovery/create/setup.
13. Add runtime trusted-root registration.
14. Route snapshots, hosted repo attribution, and undo through the execution
    workspace.
15. Verify all providers, including Claude and Qwen session logs.

Exit criterion: existing parallel native workflows still coexist; a named
worktree runs safely and is blocked only by incompatible activity in that same
directory.

### Phase 3 — Managed branch landing

16. Implement ownership records and idempotent create/recovery.
17. Add managed shorthand/object schema without `merge`.
18. Seed `.ctrlyoke/.gitignore` into the worktree, then run setup before execution.
19. Implement terminal-settlement cleanup, auto-commit, landing, `keep`, and
    removal failure handling.
20. Prevent retained integrations from outliving managed roots.
21. Persist status and enrich global/session status.
22. Add View Diff and conditional Open Worktree actions.
23. Implement read-only activation recovery and warnings.
24. Enforce landed-run undo behavior.

Exit criterion: managed runs cannot lose uncommitted work on any ordinary
completion/failure/cancellation path, and crash leftovers are discoverable.

### Phase 4 — Merge and management UX

25. Implement one guarded merge engine.
26. Expose declarative `merge` and the dashboard Merge action together.
27. Implement Manage Worktrees with safe remove/prune/branch cleanup.
28. Show cached ahead/behind data for named branches.
29. Add the active-managed-worktree concurrency warning.

### Phase 5 — Deferred expansion

30. Temporary-worktree historical undo for landed branches.
31. Parameterize `AgentDiscovery`/`SkillDiscovery` by root so assets can follow the
    execution workspace, including `findGitRoot()` behavior inside a worktree.
32. Explicit read-only passthrough roots.
33. Explicit repo selection or N-worktree fan-out for multi-repo workspaces.
34. Optional retention policies informed by actual usage.
35. A measured concurrency-warning threshold, once real usage exists.
36. Dependency/cache sharing ergonomics where safe.

---

## Settled Design Decisions

1. **No hard concurrency ceiling.** Do not block and do not add a setting. The
   warning threshold itself is explicitly unresolved — ship without one rather
   than guess a number.
2. **No automatic landed-branch retention policy.** Provide explicit bulk
   cleanup and preselect only provably safe merged branches.
3. **Show named-branch ahead/behind counts.** Compare against a labeled,
   recorded base/upstream; never auto-sync.
4. **Discover stale worktrees on activation, prune on demand.** Automatically
   reconcile only entries proven ctrlyoke-owned and inactive.
5. **Lease conflicts are hard failures with owner details.** No queue in the
   first release.
6. **Parallel native workflows remain allowed.** They use compatible shared
   leases; worktree-targeted runs use exclusive leases.
7. **Managed worktree results land as branches by default.** Merge is explicit.
8. **Transient worktree trust is session-scoped, not persisted as a user trust
   decision.**
9. **Managed directory removal disables undo for that run.** ctrlyoke has exactly
   one undo mechanism — filesystem content restore — so there is no git-based
   fallback to degrade to. Diff and attribution display remain; temporary
   recreation is deferred. The coordinator, not just the UI, must enforce this.
10. **Worktree mode is explicit per workflow.** There is no global enable or
    default-on setting.
11. **ctrlyoke assets resolve from `stateRoot`; scripts resolve from
    `executionRoot`.** Accepted inconsistency for the first release, asserted by
    tests; parameterizing agent/skill discovery is deferred.
12. **A monorepo spanning several workspace roots is supported.** Eligibility
    refuses _multiple repositories_ and roots outside the sole repository — not
    multi-root workspaces as such.

---

## Reversed Decisions and Why

### Default auto-merge → land the branch

Automatically rewriting the source checkout creates unnecessary risk and fights
the review workflow. A shared branch already gives single-window users a
reviewable result.

### Nested `.ctrlyoke/worktrees/` → sibling directory

Nested worktrees break this repository's TypeScript build, attribution,
snapshot walking, and isolation assumptions.

### Single cwd override → typed execution workspace

The current root drives more than spawn cwd: prompt refs, temp files, hooks,
MCP state, session-log discovery, scripts, and snapshots. A typed contract makes
the state/execution split explicit and carries remapped multi-root data.

### One exclusive execution lock → shared/exclusive lease set

A single lock would remove existing parallel non-worktree execution. Shared
native leases preserve that behavior, while exclusive worktree leases protect
the particular directory that must be isolated.

### Non-repo roots pass through → strict first-release eligibility

Passing a live non-repo root to a worktree run is silent partial isolation.
Explicit read-only passthrough can be designed later; the first release refuses
the ambiguous shape.

### "Filesystem undo plus git undo" → one undo mechanism

An earlier revision implied a git-based undo tier survived managed directory
removal. It does not exist. `UndoRedoCoordinator` performs every undo through
`snapshotService.undoFiles(...)`; Git only supplies before-content for snapshots
based on `GIT_HEAD`. Removing a managed directory therefore ends undo for that run
outright, leaving diff and attribution display. Reverting a landed branch is an
ordinary user Git operation, not a ctrlyoke feature.

### Branch prefix as ownership → durable Git-admin ownership records

Names are conventions, not deletion authority. A durable record survives
directory removal and makes cleanup and crash recovery safe.
