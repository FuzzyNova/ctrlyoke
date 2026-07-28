# Git Worktree Support for Workflows

> **Status:** Design complete — ready to implement.
> **Revision note:** Substantially revised twice after codebase audits. Three earlier
> decisions were reversed: worktrees live **outside** the repo (not `.ctrlyoke/worktrees/`),
> the cwd mechanism is a real **root split** (not a "pass a cwd parameter" change, which
> the code does not support), and the managed mode **lands a branch rather than
> auto-merging**. See [Reversed Decisions](#reversed-decisions-and-why).

---

## Goal

Give a workflow its own working directory so agents stop interfering with each other —
and with you. Two coherent shapes, serving different users:

**A scratch space you never visit.** Several independent tasks that must not stomp each
other. The worktree is invisible infrastructure; you never `cd` into it. Its whole job is
keeping agent A's `npm install` away from agent B's test run.

**A place you already live.** The UI-window / backend-window habit. ctrlyoke does not
create anything here — it *targets* a worktree you already have open, so there is nothing
to feel disconnected from.

The shape to avoid is the middle: an ephemeral worktree whose output never comes back.
That strands the result in a directory you have no window on. Every design decision below
follows from refusing that state.

### The result lives in the branch, not the directory

Worktrees share the object store and the refs. A branch created inside a worktree is an
ordinary branch in your repo, visible from your main VS Code window, and it **survives
`git worktree remove`**.

So a single-window user reviews agent output with `git diff main...ctrlyoke/foo`, GitLens,
or a PR — no second window required. You only need a window on the worktree when you want
its tree to stay *live* while you work elsewhere, which is exactly the named/persistent
case where you already have one.

This is why the managed mode removes the directory but keeps the branch.

---

## How git Worktrees Work

A linked checkout of the same repository at a different path. Each worktree is on its own
branch (two worktrees cannot share a branch). They share one `.git` object store but have
independent working trees.

```
C:\dev\FlightPath\                       ← main checkout (branch: main)
C:\dev\FlightPath.worktrees\ui-work\     ← worktree A (branch: ui-work)
C:\dev\FlightPath.worktrees\backend\     ← worktree B (branch: backend)
```

The harness CLI launches with `cwd` set to the worktree path. From the agent's
perspective it is a normal repo at that path.

---

## Worktree Location

### Default layout

```
<parentOf(repoRoot)>/<repoName>.worktrees/<slug>/
```

`C:\dev\FlightPath` → `C:\dev\FlightPath.worktrees\ui-work\`. Sorts next to the repo,
obviously ctrlyoke-owned, removable as a unit, and outside every tool's view of the repo.

### Resolution order

1. `ctrlyoke.worktree.root` setting (absolute, or `~`-prefixed).
2. `<parentOf(repoRoot)>/<repoName>.worktrees/` when the parent is writable.
3. `~/.ctrlyoke/worktrees/<repoSlug>/` — covers read-only parents (devcontainer mounts,
   `/workspaces/<repo>`, network shares).

`repoSlug` uses `ClaudeLogParser.normalizeWorkspacePath`-style flattening so same-named
repos cannot collide. Resolved once per run and recorded in the working file, so crash
recovery never re-derives it.

### Why NOT `.ctrlyoke/worktrees/` (reversed)

Nesting a worktree inside the repo is legal git, but breaks concrete things here:

| Breakage                                                                                                                                                                                                                                                          | Evidence                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **`npm run typecheck` and `compile:extension` fail.** `tsconfig.json` has no `include` and sets `"rootDir": "src"`. Absent `include`, tsc compiles every `.ts` under the project dir except `exclude`; a nested worktree contributes `.../src/**/*.ts` outside `rootDir` → TS6059. | `tsconfig.json`                                                     |
| **Repo attribution silently wrong.** `findRepoForPath` is pure containment, so every worktree file resolves to the _main_ repo — hosted SCM and snapshot/undo would run git against the wrong working tree.                                                        | `src/utils/WorkspaceRepoDiscovery.ts:114-123`                       |
| **Snapshots go blind.** `PATH_CONSTANTS.CTRLYOKE_DIR` is in the filesystem walker's `EXCLUDED_DIRS`, so nested worktree files are never captured — per-step diff and undo silently stop working for the workflows using the feature.                                | `src/utils/WorkspaceSnapshotService.ts:68`                          |
| **`.ctrlyoke/` is not wholesale gitignored.** Root `.gitignore` ignores only `temp/`, `.runs/`, `logs/`, `.search-index/`, `snapshots/`, `attachments/`, `capabilities.json`. Prompts/agents/skills/templates are committed.                                       | `.gitignore`, `src/core/orchestration/WorkspaceInitializer.ts:6-17`  |
| **`git clean -xdf` destroys it**, orphaning `.git/worktrees/<name>` admin entries.                                                                                                                                                                                 | git behavior                                                        |
| **Every non-git tool still walks it.** gitignore hides a path from git only — watchers, test globs, eslint, bundlers, VS Code search all see a second copy of the repo inside the workspace. The opposite of isolation.                                             | —                                                                   |

Sibling placement costs one thing: worktree paths fall outside `workspaceRoots`, so
`evaluateFileAccess` blocks them. Handled in [Path trust](#path-trust).

### External-location consequences

- **`node_modules` is absent** in a fresh worktree (gitignored → not checked out).
  Building or testing requires an install. Not solved in Phase 1; see Phase 5.
- **Windows path length.** Warn (do not fail) when the resolved worktree root exceeds
  150 chars, since `node_modules` trees can then breach `MAX_PATH`.

---

## Three Roots

Worktree support turns one conflated value into three named ones. Establish all three
vocabulary-wise in the split PR even though only the first two are used at that point.

| Root            | Meaning                                        | Source                                                    |
| --------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `stateRoot`     | Where ctrlyoke keeps its own state             | `platform.getWorkspaceRoot()` — never changes              |
| `executionRoot` | Where the agent runs (cwd)                     | worktree path when active, else `stateRoot`                |
| `repoRoot`      | The git toplevel that owns the worktree        | `git rev-parse --show-toplevel`                            |

### Workspace-below-repo mapping

`discoverRepos` already supports a workspace root sitting *below* the git toplevel
(`WorkspaceRepoDiscovery.ts:44-51`) — e.g. workspace `<repo>/packages/web`. A worktree is
always a **full-repo** checkout, so the execution root must preserve the user's relative
position:

```
executionRoot = join(worktreePath, relative(repoRoot, stateRoot))
```

For a workspace at the repo root this collapses to `worktreePath`. The same mapping
handles multi-root workspaces whose roots all live in one repo — each root remaps
independently into the worktree.

### Role assignment

One value currently serves all of these. The split assigns each side:

| Role                                                        | Root          | Call sites                                                                              |
| ----------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| Harness process cwd                                         | execution     | `CliTransportCoordinator.ts:86`, `:183`                                                 |
| Temp prompt files + base for relative `@` refs              | execution     | `CliPromptPreparer.ts:186-191`, `CliIntegration.ts:350`, `:365-374`                     |
| Session-log project directory (`~/.claude/projects/<slug>`) | **execution** | `ClaudeLogParser.ts:1124-1138`, `QwenLogParser.ts:787`                                  |
| Hook/notification directories                               | execution     | `CliTransportCoordinator.ts:105-113`, `CliExecutionRunner.ts:365`, `:594`               |
| endCondition / preCondition / script cwd                    | execution     | `EndConditionEvaluator.ts:609`, `WorkflowExecutor.ts:978`, `:993`                        |
| Snapshot capture root                                       | execution     | `WorkflowExecutor.ts:1196-1220`                                                          |
| `CTRLYOKE_WORKSPACE` for the MCP server                     | **state**     | `CliMcpConfigGenerator.ts:216`, `:377`, `CliProviderUtils.ts:367`                        |
| Run storage, working files, lineage, locks, history         | **state**     | `WorkflowPaths.ts`, `WorkingFileManager.ts`                                              |

Two rows deserve emphasis:

- **Session-log discovery must follow the execution root.** `ClaudeLogParser` derives
  `~/.claude/projects/<flattened-cwd>` from its `workspaceRoot`, and the Claude CLI
  slugifies its *actual cwd*. Diverge and session logs are never found — the run hangs
  waiting for output being written somewhere nobody is watching. Same for `QwenLogParser`.
  This alone invalidates any "only change the cwd" approach.
- **`CTRLYOKE_WORKSPACE` must stay on the state root.** The MCP server writes queue and
  run state; pointing it at the worktree forks ctrlyoke's own state per run and breaks the
  dashboard.

### Implementation shape

`IntegrationFactory.createForExecution()` (`WorkflowInstance.ts:3042`) creates a fresh
integration per run, so `executionRoot` is constructor state, not a threaded parameter.

```
WorkflowInstance (resolves worktree, owns WorktreeInfo)
  ├─ WorkflowExecutionContext.executionRoot?   ← scripts, endConditions, snapshots
  └─ IntegrationFactory.createForExecution(harness, executionRoot?)
       └─ CliIntegration.getExecutionRoot() = this.executionRoot ?? this.getWorkspaceRoot()
```

Add one private `getExecutionRoot()` to `CliIntegration` and repoint the execution-role
call sites. `getWorkspaceRoot()` keeps its current meaning (state root). **When
`executionRoot` is unset every path must be byte-identical to today** — the no-worktree
case is a strict no-op, and that is the acceptance test for the split.

**Multi-root `--add-dir`.** `getWorkspaceRoots()` feeds `--add-dir` and
`getEffectiveAbsolute()`. When a worktree is active, remap *every* root that belongs to
the worktree's repo through the relative-path mapping above; leave non-repo roots and
other-repo roots at their real paths. Without this the agent gets `--add-dir` write access
to the live checkout the worktree exists to isolate it from.

---

## Two Lifecycle Modes

### Mode A — Managed / Ephemeral (`worktree: true`)

Run-scoped. `runner.json` already prevents concurrent runs of one lineage.

1. **On run start**: `git worktree add <root>/<workflowKey>-<runRef> -b ctrlyoke/<workflowKey>-<runRef>`
2. **During execution**: `executionRoot` = worktree path, `stateRoot` unchanged
3. **On completion**: auto-commit anything uncommitted onto the managed branch, then
   `git worktree remove` — **the branch stays, no merge**
4. Dashboard shows the branch, the diff, and a merge affordance

The default is deliberately *not* a merge. Landing the branch gives a single-window user
a reviewable result with no second window and no rewrite of whatever branch their main
checkout happens to be sitting on.

**Use for:** independent work you want isolated and then reviewable.

### Mode B — Named / Persistent (`worktree: ui-work`)

Discovered if it exists, lazily created if not. No merge, no removal — you own the branch
lifecycle.

**Use for:** long-running parallel tracks with their own VS Code windows.

### Auto-merge (opt-in only)

`worktree: { merge: true }` restores the original automated behavior. Because it rewrites
the branch the main checkout is on, it carries guards that the default does not need:

1. Auto-commit uncommitted worktree changes onto the managed branch.
2. No commits past the fork point → `"nothing-to-merge"`, remove worktree, delete branch.
3. **Refuse when the main checkout is dirty** — a mid-merge failure would leave the user's
   own work conflicted. Report `"blocked"`, leave the branch.
4. `git merge --ff-only`, then `git merge --no-ff`.
5. On conflict: `git merge --abort`, collect `git diff --name-only --diff-filter=U`, leave
   the branch, notify.

All merge commands run with `-C <repoRoot>` against the main checkout, never the worktree.

### Guard rails (both modes)

- **Dirty main checkout** is fine for *creation* — worktrees fork from `HEAD`, not the index.
- **Branch already checked out elsewhere** → surface the existing worktree path, not the
  raw git error.
- **Not a git repo** → fail before the first step, with an actionable message.
- **Uncommitted changes at completion** are always auto-committed. Without this the agent's
  uncommitted work is silently discarded when the worktree is removed — the single most
  likely real-world data-loss path.

---

## Discovery

`git worktree list --porcelain` at run start. Discovery buys three things: `worktree: ui-work`
resolves to *your* existing worktree instead of failing with a raw "branch already checked
out" error; schema completions can offer real worktree names; and the dashboard can show
which worktrees are in use.

**Discovery is not ownership.** The `ctrlyoke/` branch-name prefix marks worktrees ctrlyoke
created. We list yours, we run in yours, we never remove, merge, or auto-commit one we did
not create. A discovered worktree with uncommitted changes at run end is left exactly as
the agent left it.

---

## Concurrency: two ctrlyoke instances, one execution root

Two VS Code windows are two extension hosts and two ctrlyoke instances, each with its own
`stateRoot` — so window A's `.ctrlyoke/.runs/<key>/runner.json` and window B's are
**different files on disk**. The existing runner lock therefore does *not* protect a shared
worktree, and this is the first feature that lets two instances share an execution root at
all (VS Code refuses to open two windows on the same folder, so today it cannot happen).

Three concrete failure modes when window A targets `worktree: ui-work` while window B is
open on that same worktree:

1. **Two agents in one directory** — precisely the interference worktrees exist to prevent.
2. **State corruption.** Window B's ctrlyoke state lives at `<worktree>/.ctrlyoke/`. Window
   A's agent, running with cwd there, can see and modify window B's live `runner.json` and
   `.runs/`. Worse than file interference.
3. **Session cross-attribution** — narrow. `ClaudeLogParser` resolves by session ID first
   (`:754`); the directory-scan fallback (`:807-840`) filters by mtime and matches the
   first 100 chars of prompt text, so it misfires only when both instances run
   near-identical prompt text concurrently.

### Fix: an execution-root lock

Lock the *directory*, not the lineage: `<executionRoot>/.ctrlyoke/execution-lock.json`,
naming pid, host stateRoot, workflow key, runRef, and timestamp. Because it lives in the
shared filesystem location, both instances see it regardless of which one "owns" the
worktree.

Take it for **every** run, including runs whose execution root is just their own workspace
root. That generalizes correctly — it also catches the case where window B is running
natively in the worktree with no `worktree` property at all, which is the most likely
collision in practice.

Advisory and PID-based, same contract as `runner.json`: a stale file with a dead PID is
safe to delete. Add the filename to `PATH_CONSTANTS` and to `GITIGNORE_CONTENT` in
`WorkspaceInitializer` so it never shows up as an untracked file. Worktrees holding a live
lock render as "in use" in the discovery list.

---

## Multi-repo workspaces

A worktree is a checkout of exactly one repo — there is no such thing as a worktree
spanning two. And ctrlyoke cannot know up front which repos a workflow will touch, since
the agent decides at runtime. So the rule has to be structural rather than intent-based,
and it is checkable with a call already made: `discoverRepos(getNamedWorkspaceRoots())`.

**Phase 1 refuses `worktree` when the workspace spans more than one repo**, with an error
naming the repos found. The tempting alternative — worktree the primary root and leave the
others live — is the worst option available, because it delivers *silent partial
isolation*: the user believes they are sandboxed while half the workflow writes straight
into the live checkouts.

Two cases that are **not** multi-repo and must keep working:

- **Several roots inside one repo.** `discoverRepos` collapses them to a single entry
  (`WorkspaceRepoDiscovery.ts:44-51`). One worktree; each root remaps through the
  relative-path mapping.
- **Non-repo roots** (a docs folder, a scratch dir). `discoverRepos` drops them entirely,
  so they do not count toward the repo total and pass through at their real paths.

Deferred: `worktree: { repo: "repoA" }` for explicit single-repo selection in a multi-repo
workspace, and N-worktree fan-out. Both are Phase 5 at the earliest.

---

## Schema

Workflow-level only. Step-level `worktree` is out of scope — a workflow runs in one
worktree for its whole lifetime; mid-run cwd switches create ambiguity about which
worktree `resumeSession` targets and where the next step's session log lives.

```yaml
worktree: true                  # ephemeral; land the branch, remove the directory
worktree: ui-work               # named; discovered or created, never removed
worktree: { merge: true }       # ephemeral + auto-merge into the current branch
worktree: { branch: ui-work }   # explicit named form
worktree: { keep: true }        # ephemeral, but leave the directory in place
```

```json
"worktree": {
  "oneOf": [
    { "type": "boolean" },
    { "type": "string", "minLength": 1, "pattern": "^[A-Za-z0-9._/-]+$" },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "branch": { "type": "string", "minLength": 1, "pattern": "^[A-Za-z0-9._/-]+$" },
        "merge": { "type": "boolean" },
        "keep": { "type": "boolean" }
      }
    }
  ],
  "description": "Run this workflow in a git worktree. true: ctrlyoke creates a run-scoped branch and worktree, auto-commits on completion, then removes the directory and leaves the branch for you to review and merge. A branch name string (e.g. \"ui-work\"): uses that worktree, creating it on first use, never removing it. Object form adds merge (auto-merge into the current branch on completion) and keep (leave the worktree directory in place)."
}
```

`"auto"` as a bare string is ambiguous with a branch named `auto`; reject it in validation
with a message pointing at `worktree: true`.

---

## Architecture

### `WorktreeManager`

`src/core/orchestration/WorktreeManager.ts` — lifecycle policy. Pure git plumbing goes in
`src/utils/GitUtils.ts`, which already owns the `execFile`-based git helpers. `src/git/`
stays out of it per `git.instructions.md` ("intentionally narrow" — commit-message
generation only).

New in `GitUtils.ts`:

```typescript
export async function listWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]>;
export async function addWorktree(repoRoot: string, path: string, branch: string, opts?: { createBranch?: boolean }): Promise<void>;
export async function removeWorktree(repoRoot: string, path: string, force?: boolean): Promise<void>;
export async function pruneWorktrees(repoRoot: string): Promise<void>;
export async function repoToplevel(dir: string): Promise<string | null>;
export async function currentBranch(repoRoot: string): Promise<string | null>;
export async function hasUncommittedChanges(dir: string): Promise<boolean>;
export async function commitAll(dir: string, message: string): Promise<boolean>;
```

```typescript
interface WorktreeInfo {
  branchName: string;
  worktreePath: string;   // the worktree's own toplevel
  executionRoot: string;  // worktreePath + relative(repoRoot, stateRoot)
  repoRoot: string;
  managed: boolean;       // ctrlyoke created it (ctrlyoke/ prefix)
  discovered: boolean;    // pre-existing; never removed or auto-committed
  workflowKey: string;
  runRef?: string;
  createdAt: number;
}

interface CompletionResult {
  outcome: "landed" | "merged" | "nothing-to-merge" | "conflict" | "blocked" | "kept";
  branchName: string;
  targetBranch?: string;         // merge modes only
  mergeStrategy?: "fast-forward" | "merge-commit";
  conflictFiles?: string[];
  autoCommitted?: boolean;
}

class WorktreeManager {
  async resolveWorktreeRoot(repoRoot: string): Promise<string>;
  async createManagedWorktree(workflowKey: string, runRef: string): Promise<WorktreeInfo>;
  async resolveNamedWorktree(branchName: string, workflowKey: string): Promise<WorktreeInfo>;
  async listWorktrees(repoRoot: string): Promise<WorktreeInfo[]>;   // discovered + managed
  async completeRun(info: WorktreeInfo, opts: { merge?: boolean; keep?: boolean }): Promise<CompletionResult>;
  async removeWorktree(info: WorktreeInfo, force?: boolean): Promise<void>;
  async pruneOrphans(repoRoot: string): Promise<WorktreeInfo[]>;
}
```

### Path trust

`evaluateFileAccess` blocks paths outside `workspaceRoots`
(`src/utils/FileAccessPolicy.ts:60-93`), and a sibling worktree is outside. Register the
worktree path via the existing external-roots mechanism
(`ConfigurationUtils.getEffectiveApprovedExternalFileRoots` /
`src/config/ExternalRootsTrustStore.ts`) for the run's duration — **session-scoped, not
persisted into the saved trust store**. Without it, dashboard "open file",
`PromptLinkProvider`, and attachment flows all reject worktree files.

### Repo discovery

Feed the active worktree path in as an extra probe root. `git rev-parse --show-toplevel`
inside a worktree returns the worktree's own path, so `discoverRepos` needs the extra root
and no new logic — snapshot/undo and hosted SCM then resolve worktree files correctly.

### WorkingFile

```typescript
interface WorkingFileRuntime {
  worktree?: {
    branchName: string;
    worktreePath: string;
    executionRoot: string;
    repoRoot: string;
    managed: boolean;
    discovered: boolean;
    state: "active" | "landed" | "merged" | "conflict" | "blocked" | "orphaned" | "removed";
    mergeStrategy?: "fast-forward" | "merge-commit";
    conflictFiles?: string[];
  };
}
```

Written at run start (`"active"`) so a crash leaves a recoverable record; updated at
completion.

---

## Dashboard / UI

```
▶ ui-refactor   [claude-cli] [sonnet]  ● running
  Branch: ctrlyoke/ui-refactor-2026-07-27T14-02-11
  Worktree: ..\FlightPath.worktrees\ui-refactor-2026-07-27T14-02-11
```

Named mode shows `Branch: ui-work` with no run suffix. On completion:

- `✓ branch ready — 12 files` — neutral, with **View Diff** and **Merge** actions (default)
- `✓ merged (fast-forward)` / `✓ merged (merge commit)` — green (opt-in merge)
- `✓ no changes` — neutral
- `⚠ merge conflict — resolve manually` — yellow, links to the branch
- `⚠ merge skipped — main checkout is dirty` — yellow

Worktree paths render relative to the repo parent when they sit under it, absolute
otherwise. An **Open Worktree in New Window** action covers the case where you do want a
window on a live tree. `WorkspaceSessionManager.discoverSessions()` already reads working
files — surface `_runtime.worktree` in the detail string, no structural change.

---

## `ctrlyoke_global_status`

```json
{
  "workflowName": "ui-refactor",
  "executionState": "running",
  "worktree": {
    "branchName": "ctrlyoke/ui-refactor-2026-07-27T14-02-11",
    "worktreePath": "C:/dev/FlightPath.worktrees/ui-refactor-2026-07-27T14-02-11",
    "managed": true,
    "state": "active"
  }
}
```

---

## Harness Notes

The harness set is the six CLI harnesses in `HARNESS_IDS`
(`src/types/DashboardConstants.ts:557`): `copilot-cli`, `claude-cli`, `codex-cli`,
`opencode-cli`, `qwen-cli`, `antigravity-cli`. There is no `copilot-chat` and no
`gemini-cli`; an earlier revision referenced both plus a nonexistent
`src/core/harness/chat/CopilotChatIntegration.ts`. Uniform coverage across all six is the
reason to build this rather than lean on `claude --worktree`, which covers one.

Two harnesses need per-provider verification in the split phase because their session-log
discovery is cwd-derived: **claude-cli** (`ClaudeLogParser.ts:1124`) and **qwen-cli**
(`QwenLogParser.ts:787`). For the rest, confirm hook/notification directories resolve
under the execution root.

---

## Files Changed

| File                                                            | Change                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/types/CtrlYokeTypes.ts`                                    | `worktree?` on `PromptFile`; `worktree?` block on `WorkingFileRuntime`                   |
| `src/utils/PropertyResolver.ts`                                 | Resolve `worktree` (workflow-level + global setting; no step tier)                       |
| `src/utils/GitUtils.ts`                                         | Worktree primitives + `repoToplevel`, `hasUncommittedChanges`, `commitAll`                |
| `src/utils/ConfigurationUtils.ts`                               | `ctrlyoke.worktree.root` / `.enabled`; `PATH_CONSTANTS` execution-lock filename           |
| `package.json`                                                  | Contribute the settings                                                                  |
| `schemas/workflow-schema.json`                                  | `worktree` in `executionProperties`                                                      |
| `src/core/orchestration/WorktreeManager.ts`                     | **New** — root resolution, discovery, create, complete, prune                             |
| `src/core/orchestration/WorkspaceInitializer.ts`                | Execution-lock filename in `GITIGNORE_CONTENT`                                            |
| `src/core/WorkflowInstance.ts`                                  | Resolve worktree; own `WorktreeInfo`; execution-root lock; `executionRoot` on the context |
| `src/core/IntegrationFactory.ts`                                | `createForExecution(harness, executionRoot?)`                                             |
| `src/core/harness/CliIntegration.ts`                            | `executionRoot` + `getExecutionRoot()`; repoint execution-role call sites                 |
| `src/core/harness/shared/CliTransportCoordinator.ts`            | cwd from execution root                                                                  |
| `src/core/harness/shared/CliExecutionRunner.ts`                 | Notification dirs + `CTRLYOKE_WORKSPACE_ROOT` from execution root                         |
| `src/core/harness/shared/CliMcpConfigGenerator.ts`              | `CTRLYOKE_WORKSPACE` explicitly from the **state** root                                   |
| `src/core/harness/shared/CliPromptPreparer.ts`                  | `TempFileManager` on the execution root                                                   |
| `src/core/WorkflowExecutor.ts`                                  | Script/endCondition cwd and snapshot root from `context.executionRoot`                    |
| `src/core/EndConditionEvaluator.ts`                             | Accept the execution root as script cwd                                                   |
| `src/utils/WorkspaceRepoDiscovery.ts`                           | Active worktree as an extra probe root                                                    |
| `src/config/ExternalRootsTrustStore.ts`                         | Session-scoped worktree grant (not persisted)                                            |
| `src/mcp-server.ts`                                             | `worktree` in `ctrlyoke_global_status`                                                    |
| `src/core/orchestration/WorkspaceSessionManager.ts`             | Worktree info in `discoverSessions()` detail                                              |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx` | Worktree badge, View Diff / Merge / Open in New Window actions                             |
| `src/test/unit/WorktreeManager.test.ts`                         | **New** — root resolution, discovery, create, complete, prune, multi-repo refusal          |
| `src/test/unit/GitUtils.test.ts`                                | `git worktree list --porcelain` parsing                                                   |
| `src/test/unit/CliIntegration.test.ts`                          | Execution-root vs state-root routing, including the unset no-op                            |

---

## Implementation Order

### Phase 1 — Root split (no `worktree` property, no behavior change)

1. Three-root vocabulary; `getExecutionRoot()` on `CliIntegration`; `executionRoot` on
   `WorkflowExecutionContext` and `createForExecution`.
2. Repoint every execution-role call site in the table above.
3. `CliMcpConfigGenerator` takes the state root explicitly.
4. Workspace-below-repo relative-path mapping helper (unused until Phase 3, but tested).
5. Tests asserting **byte-identical behavior when `executionRoot` is unset**.

Lands and bakes on its own. Roughly 80% of the total work, mechanical, and any regression
shows up as a small isolated diff instead of tangled with lifecycle logic.

### Phase 2 — Execution-root lock

6. `<executionRoot>/.ctrlyoke/execution-lock.json`, taken for every run including
   non-worktree runs; stale-PID reclaim; gitignore entry.
7. Tests: concurrent acquisition, stale reclaim, release on crash paths.

Independently useful — it closes the "two instances, one directory" hole even before
worktrees exist.

### Phase 3 — Discovery + named worktrees

8. `GitUtils` worktree primitives with `--porcelain` parsing.
9. `WorktreeManager.resolveWorktreeRoot()` (writability probe + `~/.ctrlyoke` fallback)
   and `listWorktrees()`.
10. Schema + types + `PropertyResolver` for the string form.
11. **Multi-repo refusal** via `discoverRepos`, plus the same-repo and non-repo-root passes.
12. `resolveNamedWorktree()`; `WorkflowInstance` wiring; `_runtime.worktree`.
13. Path trust: session-scoped external-root grant.
14. Repo discovery: worktree as an extra probe root.
15. `--add-dir` remapping for repo-owned roots.
16. Tests, including a claude-cli and a qwen-cli run in a worktree confirming session logs
    resolve.

Exit criterion: `worktree: ui-work` works against a pre-existing worktree. Serves the
multi-window habit with no lifecycle risk, and validates the split against real harness
behavior.

### Phase 4 — Ephemeral worktrees, branch landing

17. `createManagedWorktree()` with run-scoped branch naming.
18. `completeRun()` — auto-commit, remove the directory, keep the branch. `keep: true`.
19. Dashboard badge, View Diff, Merge action.
20. **Orphan recovery on activation** — `pruneOrphans()` finds `ctrlyoke/`-prefixed
    worktrees with no live run and offers keep or discard.
21. `ctrlyoke_global_status` + `discoverSessions()` enrichment.
22. Tests: create, auto-commit, land, nothing-to-commit, orphan recovery.

### Phase 5 — Opt-in merge and ergonomics

23. `merge: true`: nothing-to-merge → dirty-main refusal → FF → no-ff → conflict, with the
    conflict notification.
24. `ctrlyoke: Manage Worktrees` command — list, state, Remove / Open in VS Code.
25. `worktreeSetup` script hook run once after creation (`npm ci`, `.env` copy).
26. `worktreeBase: <branch>` to fork from something other than `HEAD`.
27. `worktree: { repo: "repoA" }` for multi-repo workspaces.

---

## Reversed Decisions (and why)

### Auto-merge default → land the branch

Auto-merging into whatever branch the main checkout happens to be on rewrites the user's
working branch without review. The tell was that the merge chain already needed a
"refuse when the main checkout is dirty" guard — the design was fighting the user. Landing
the branch delivers the same single-window review experience (branches are shared across
worktrees) while leaving the merge deliberate. Merge remains available as `merge: true`.

### `.ctrlyoke/worktrees/` → sibling directory

The original rationale was that `.ctrlyoke/` is "already gitignored and runtime-owned." It
is neither. The decisive item is that a nested worktree breaks `npm run typecheck` in this
very repo via `tsconfig.json`'s implicit-`include` + `rootDir` combination. Sibling
placement is also the dominant external convention, so existing worktree habits transfer.

### "Pass a cwd parameter" → three-root split

The original plan asserted "the `cwd` is already passed through as a parameter in
`CliExecutionRunner`." There is no such parameter — cwd derives from
`runtimeState.getWorkspaceRoot()` (`CliTransportCoordinator.ts:86`, `:183`), and that one
value simultaneously drives temp-file placement, relative `@`-ref bases, MCP
`CTRLYOKE_WORKSPACE`, hook directories, and session-log discovery. Overriding it wholesale
moves ctrlyoke state into the worktree; overriding only the spawn cwd breaks Claude/Qwen
session-log discovery.

### Harness list

`copilot-chat` and `gemini-cli` no longer exist. The former "worktrees are meaningless for
copilot-chat" open question is moot.

---

## Open Questions

1. **Concurrency ceiling.** Nothing limits how many worktrees are live at once; each is a
   full checkout plus its own `node_modules` once installed. Consider
   `ctrlyoke.worktree.maxConcurrent`, or at minimum a warning past ~5.
2. **Landed-branch accumulation.** The default never deletes branches. After fifty runs
   that is fifty `ctrlyoke/*` refs. Offer a retention policy (delete merged `ctrlyoke/*`
   branches older than N days) or a bulk cleanup in the Manage Worktrees command.
3. **Named-worktree divergence.** A `worktree: ui-work` branch can drift far from `main`
   and ctrlyoke never merges it. Should the dashboard show ahead/behind counts?
4. **Manual worktree deletion.** Deleting the directory by hand leaves a stale admin entry.
   `pruneOrphans()` should call `git worktree prune` — decide whether on activation, on
   demand, or both.
5. **Execution-lock UX.** When a run is blocked by another instance's lock, is that a hard
   failure, a queue, or a prompt? Hard failure with the owner's details is the Phase 2
   answer; queuing may be worth revisiting.
