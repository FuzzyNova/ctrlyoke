# Git Worktree Support for Workflows

> **Status:** Not yet implemented — design complete, cleared for implementation.

---

## Is This Worth Building?

**Yes.** The core problem is real: when multiple FlightPath workflows run in the same
checkout, agents share a filesystem. One agent's test run produces errors the other
caused; `npm install` from one workflow modifies `package-lock.json` while another reads
it; a compile error in the wrong file derails the wrong agent. Worktree isolation
eliminates this class of problem entirely by giving each workflow its own branch and
working directory.

The `flightpath_global_status` MCP tool (already added) provides situational awareness
for agents that *want* to share a workspace. Worktree support is for agents that should
be *isolated* from each other — different concerns, different branches, no interference.

---

## How git Worktrees Work

A git worktree is a linked checkout of the same repository at a different filesystem
path. Each worktree is on its own branch (two worktrees cannot share a branch). They
share the same `.git` object store but have independent working trees, so changes in one
worktree do not appear in another until explicitly merged.

```
C:\dev\FlightPath\           ← main checkout (branch: main)
C:\dev\FlightPath\.flightpath\worktrees\ui-work\   ← worktree A (branch: ui-work)
C:\dev\FlightPath\.flightpath\worktrees\backend\   ← worktree B (branch: backend)
```

The harness CLI (`claude`, `gh copilot`, etc.) is launched with its `cwd` set to the
worktree path. From the agent's perspective it's just a normal repo at that path.

---

## Two Lifecycle Modes

The `worktree` property on a workflow or step accepts either a boolean/`"auto"` or a
branch name string. This controls the entire lifecycle.

### Mode A — Managed / Ephemeral (`worktree: true` or `worktree: auto`)

FlightPath owns the full lifecycle:

1. **On workflow start**: run `git worktree add .flightpath/worktrees/<workflow-name>-<timestamp> -b flightpath/<workflow-name>-<timestamp>`
2. **During execution**: harness `cwd` = worktree path; `FLIGHTPATH_WORKSPACE` env var keeps
   pointing to the main workspace so working files, logs, and history stay centralized
3. **On workflow complete**: attempt auto-merge back to the branch the main checkout is on
4. **Merge succeeded**: run `git worktree remove .flightpath/worktrees/<name>` and delete
   the branch — clean slate
5. **Merge conflict**: leave worktree in place, post a VS Code notification with the path
   and instructions. The user resolves manually; the worktree is marked `orphaned` in the
   working file.

**When to use:** Independent feature work that should land back on the main branch.
Equivalent to: "create a branch, do the work, merge it, delete the branch" — but
automated.

### Mode B — Named / Persistent (`worktree: ui-work`)

The user (or FlightPath on first use) owns the worktree. FlightPath checks if a worktree
for the given name already exists; if not, it creates one with that branch name (lazy
creation). No auto-merge, no auto-remove. The user decides when to merge and when to
delete.

```
worktree: ui-work     ← branch name; worktree at .flightpath/worktrees/ui-work/
```

Multiple workflow runs with the same name reuse the same worktree. This is Nathan's
"I have VS Code open on UI and another on backend" pattern, automated: each named track
persists across sessions.

**When to use:** Long-running parallel tracks (UI dev, backend dev, planning) where
merging is a deliberate decision, not automatic.

---

## Schema Design

### Workflow-level property (applies to all steps)

```yaml
# Mode A — managed lifecycle
worktree: auto

# Mode A shorthand
worktree: true

# Mode B — named, persistent
worktree: ui-work
```

### Step-level override (future phase — not Phase 1)

Step-level `worktree` overrides are not in scope for Phase 1. All steps in a workflow
run in the same worktree. This avoids complex mid-workflow cwd switching.

### Schema addition to `schemas/prompt-schema.json`

Add `worktree` to `executionProperties` alongside `harness`, `model`, etc.:

```json
"worktree": {
  "oneOf": [
    { "type": "boolean" },
    { "type": "string", "minLength": 1 }
  ],
  "description": "Run this workflow in a git worktree. true/\"auto\": FlightPath creates a timestamped branch and worktree, attempts auto-merge on completion, and removes it. A branch name string (e.g. \"ui-work\"): uses that named branch/worktree (creates it on first use, no auto-merge)."
}
```

---

## Architecture

### New: `WorktreeManager`

Extracted class following the same pattern as `WorkspaceSessionManager`. Lives at
`src/flightpath/orchestration/WorktreeManager.ts`.

```typescript
interface WorktreeInfo {
  branchName: string;
  worktreePath: string;
  managed: boolean; // true = auto mode (FlightPath created it, will clean up)
  workflowName: string;
  createdAt: number;
}

interface MergeResult {
  success: boolean;
  strategy: "fast-forward" | "merge-commit" | "conflict";
  conflictFiles?: string[];
}

class WorktreeManager {
  // Mode A: create timestamped branch + worktree
  async createManagedWorktree(workflowName: string): Promise<WorktreeInfo>

  // Mode B: find existing or create named worktree
  async resolveNamedWorktree(branchName: string, workflowName: string): Promise<WorktreeInfo>

  // Attempt merge back to current HEAD branch, return result
  async mergeAndCleanup(info: WorktreeInfo): Promise<MergeResult>

  // List all FlightPath-managed worktrees (branch name starts with "flightpath/")
  async listManagedWorktrees(): Promise<WorktreeInfo[]>

  // Remove a worktree (used after successful merge, or user-initiated cleanup)
  async removeWorktree(info: WorktreeInfo): Promise<void>
}
```

`WorktreeManager` shells out to `git` via `child_process.execFile` (not `CliIntegration`).
Only git commands, no AI. All paths are workspace-scoped.

### CWD Threading

Today every harness integration runs with `cwd = workspaceFolder`. The worktree path
must reach the harness spawn point. The propagation path:

```
WorkflowInstance
  → WorkflowExecutor (has WorkflowExecutionContext)
    → WorkflowExecutionContext.worktreePath?: string  ← NEW FIELD
      → CliIntegration.sendPrompt()
        → CliExecutionRunner.run(cwd: string)
```

`WorkflowExecutionContext` gains an optional `worktreePath` field. When set,
`CliIntegration` (and `CopilotChatIntegration`) uses it as `cwd` instead of the
workspace folder. No changes to harness-specific code — the `cwd` is already passed
through as a parameter in `CliExecutionRunner`.

### `FLIGHTPATH_WORKSPACE` stays the same

The MCP server and all FlightPath state (`.flightpath/.queue/`, `.flightpath/logs/`,
`.flightpath/.history/`) stay anchored to the **main workspace root**, not the worktree.
The existing `FLIGHTPATH_WORKSPACE` env var already ensures this — it's set to the main
workspace root before the harness CLI spawns. No changes needed to the MCP server or
working file path resolution.

### WorkingFile changes

`WorkingFile` (and `PromptFile`) gains a `_worktree?: WorktreeInfo` field in the
`_runtime` block. This records which worktree the workflow is running in, allowing
recovery after a crash (the worktree is still there and can be merged or removed).

```typescript
interface WorkingFileRuntime {
  // ...existing fields...
  worktree?: {
    branchName: string;
    worktreePath: string;
    managed: boolean;
    state: "active" | "merged" | "conflict" | "orphaned";
  };
}
```

---

## Auto-Merge Strategy (Mode A)

After a managed workflow completes, `WorktreeManager.mergeAndCleanup()` runs:

1. Determine the target branch: the branch the main checkout is currently on
2. Try `git merge --ff-only <worktree-branch>` — works when no other commits landed on
   target since the worktree was created
3. If FF fails: try `git merge --no-ff <worktree-branch>` — creates a merge commit but
   succeeds without conflicts if changes are non-overlapping
4. If either merge has conflicts: abort with `git merge --abort`, report conflict file
   list, leave worktree in place with state `"conflict"`
5. On success: `git worktree remove --force <path>` + `git branch -d <branch>`

**VS Code notification on conflict:**
```
FlightPath: Workflow "ui-refactor" completed but merge to main has conflicts.
Worktree left at: .flightpath/worktrees/ui-refactor-2026-04-26/
Conflicting files: src/ui/Dashboard.tsx, src/ui/StatusBar.tsx
[Open Worktree] [Dismiss]
```

The working file records `state: "conflict"` so the dashboard can show a warning badge.

---

## `.gitignore` Requirement

`.flightpath/worktrees/` must be in `.gitignore`. If not present when the first
auto-managed worktree is created, `WorktreeManager` appends it automatically (same
pattern as how the extension ensures `.flightpath/` exists).

Note: git worktrees *are* functional when placed inside the repo directory as long as
the path is gitignored. The `.flightpath/` directory is already runtime-only.

---

## Dashboard / UI Changes

### Workflow card in dashboard

Show a "worktree" badge on workflows running in a worktree:

```
▶ ui-refactor   [claude-cli] [sonnet]  ● running
  Branch: flightpath/ui-refactor-2026-04-26
  Worktree: .flightpath/worktrees/ui-refactor-2026-04-26/
```

For named worktrees: `Branch: ui-work` with no timestamp.

After managed completion: replace running state with a merge result badge:
- `✓ merged (fast-forward)` — green
- `✓ merged (merge commit)` — green
- `⚠ merge conflict — resolve manually` — yellow with a link to the worktree path

### WorkspaceSessionManager

`discoverSessions()` already reads working files from `.queue/` and returns session
metadata. When `_runtime.worktree` is present, include it in the session detail string.
No structural changes needed.

---

## `flightpath_global_status` integration

The existing `flightpath_global_status` MCP tool (already implemented) returns all
workflows. When worktree support lands, include the `worktree` field in each workflow's
status payload so agents know which branch their sibling is working on:

```json
{
  "workflowName": "ui-refactor",
  "executionState": "running",
  "worktree": {
    "branchName": "flightpath/ui-refactor-2026-04-26",
    "worktreePath": ".flightpath/worktrees/ui-refactor-2026-04-26",
    "managed": true,
    "state": "active"
  }
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `schemas/prompt-schema.json` | Add `worktree` to `executionProperties` |
| `src/types/FlightPathTypes.ts` | Add `worktree?: string \| boolean` to `PromptFile`; add `worktree?` to `WorkingFileRuntime` |
| `src/flightpath/orchestration/WorktreeManager.ts` | **New class** — git worktree lifecycle |
| `src/flightpath/WorkflowOrchestrator.ts` | Instantiate `WorktreeManager`; call before/after workflow execution |
| `src/flightpath/WorkflowInstance.ts` | Store `WorktreeInfo` on instance; propagate to `WorkflowExecutionContext` |
| `src/flightpath/WorkflowExecutor.ts` | Pass `worktreePath` from context to `CliIntegration` as `cwd` |
| `src/flightpath/harness/CliIntegration.ts` | Accept optional `cwd` override; pass to `CliExecutionRunner` |
| `src/flightpath/harness/shared/CliExecutionRunner.ts` | Use provided `cwd` over workspace folder when set |
| `src/flightpath/harness/chat/CopilotChatIntegration.ts` | Accept `cwd` override for consistency |
| `src/mcp-server.ts` | Add `worktree` field to `flightpath_global_status` response (already added tool) |
| `src/flightpath/orchestration/WorkspaceSessionManager.ts` | Include worktree info in `discoverSessions()` detail |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx` | Show worktree badge on workflow header |
| `src/test/unit/WorktreeManager.test.ts` | **New** — unit tests for create, resolve, merge, cleanup |
| `src/test/unit/WorkflowOrchestrator.test.ts` | Tests for worktree lifecycle integration |

---

## Implementation Order

### Phase 1 — Infrastructure + Named Worktrees (no auto-merge)

1. **`WorktreeManager` class** with `resolveNamedWorktree()` only
   - `git worktree list --porcelain` parsing to find existing worktrees
   - `git worktree add <path> -b <branch>` for lazy creation
   - `git worktree remove <path>` for cleanup
   - Error handling: non-git repo, branch already checked out elsewhere, dirty worktree

2. **Schema + types**: add `worktree` to `executionProperties` in schema + `PromptFile`

3. **CWD threading**: `WorkflowExecutionContext.worktreePath` → `CliIntegration` cwd
   override → `CliExecutionRunner`

4. **`WorkflowOrchestrator` wiring**: on workflow start, if `worktree` is a string name,
   call `resolveNamedWorktree()` and store result on `WorkflowInstance`

5. **`.gitignore` guard**: `WorktreeManager` ensures `.flightpath/worktrees/` is gitignored
   before creating the first worktree

6. **Tests**: `WorktreeManager.test.ts` covering the named mode

At this point: `worktree: ui-work` works. Named persistent worktrees are fully functional.
No auto-merge, no auto-remove — user owns the branch lifecycle.

### Phase 2 — Managed Lifecycle + Auto-Merge

7. **`WorktreeManager.createManagedWorktree()`** with timestamped branch naming

8. **`WorktreeManager.mergeAndCleanup()`** with FF → merge → conflict fallback chain

9. **`WorkflowOrchestrator`**: call `mergeAndCleanup()` in the workflow completion
   handler (after `EXECUTION_STATES.COMPLETED`); write merge result to `WorkingFileRuntime`

10. **VS Code notification** on merge conflict (platform adapter call)

11. **`WorkingFileRuntime.worktree.state`** tracking (`active` → `merged`/`conflict`/`orphaned`)

12. **Tests**: managed mode creation, successful merge (FF), merge-commit path, conflict path

### Phase 3 — Dashboard Integration

13. **Workflow card badge** showing branch name and merge state

14. **`flightpath_global_status` response** enriched with worktree metadata

15. **`discoverSessions()`** includes worktree info in session detail

16. **Optional**: a FlightPath command `FlightPath: Manage Worktrees` that lists all
    managed worktrees with their state and offers "Remove" / "Open in VS Code" actions

---

## Design Decisions

### Why `.flightpath/worktrees/` instead of a sibling directory?

Sibling directories (`../repo-ui-work/`) are the most common convention, but they're
harder to clean up, pollute the parent directory, and break when the user's workspace is
mounted inside a container or at a non-standard path. Keeping worktrees inside
`.flightpath/` (which is already gitignored and runtime-owned) makes them clearly owned
by FlightPath and trivially removable with the entire `.flightpath/` directory.

### Why not reuse Claude's `--worktree` flag?

Claude Code's `--worktree` flag does the same `git worktree add` and sets the session cwd
— but it only works for the `claude-cli` harness. FlightPath needs worktree support that
works uniformly across all seven harnesses (`copilot-cli`, `claude-cli`, `codex-cli`,
`opencode-cli`, `qwen-cli`, `gemini-cli`, `copilot-chat`). Implementing it in
`WorktreeManager` gives all harnesses the feature for free.

### Why no step-level worktree in Phase 1?

Mid-workflow cwd switches create ambiguity about which branch `resumeSession` targets and
which worktree the next step runs in. The simple rule — "a workflow runs in one worktree
for its entire lifetime" — avoids this and covers all known use cases. Step-level
overrides can be added in a future phase if users ask for it.

### What happens to `endCondition` scripts?

End condition scripts run in isolated child processes via `EndConditionEvaluator`. They
receive the workspace root as their working directory. When worktrees are active, they
should run with `cwd = worktreePath` so they test the actual files the agent modified.
`EndConditionEvaluator` must receive the worktree path and use it as the script's cwd.
This is a `WorkflowExecutionContext` field that already flows to `EndConditionHandler`.

---

## Open Questions

1. **Worktree base branch**: For managed mode, should the branch always fork from the
   current HEAD of the main checkout, or should the user be able to specify a base?
   Default: current HEAD. A `worktreeBase: <branch>` property could be added later.

2. **Resume after crash with active worktree**: If VS Code crashes while a managed
   worktree is active, the worktree persists. On next session start, `WorktreeManager`
   detects orphaned managed worktrees (via `listManagedWorktrees()`) and offers to
   merge or discard. Phase 2 should include this recovery path.

3. **Worktree for `copilot-chat` harness**: The Copilot Chat integration automates the
   VS Code chat UI, which is always attached to the main workspace. Setting its
   `cwd` to a worktree path has no effect on where files are opened in the editor.
   Worktrees are effectively meaningless for `copilot-chat`. Document this limitation
   and emit a warning if `worktree` is set with `harness: copilot-chat`.

4. **`FLIGHTPATH_WORKSPACE` in MCP env vars**: The extension sets `FLIGHTPATH_WORKSPACE`
   when spawning the MCP server. For worktree workflows, this should still point to the
   main workspace root (not the worktree path) so all FlightPath state is centralized.
   Verify this is the case when threading `worktreePath` through the execution context.
