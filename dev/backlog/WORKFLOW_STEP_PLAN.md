# Workflow Step Plan

## Overview

Add a first-class `type: "workflow"` step to ctrlyoke. Its schema definition is named
`subWorkflowStep`, so it does not clash with the existing `workflowStep` wrapper. The step runs
another workflow file **to completion as its own child run**: a separate `WorkflowInstance`
with its own lineage, run directory, and dashboard entry. The child keeps its own workflow-level
`harness`, `vars`, `finalStep`, and so on; nothing is merged into the parent's queue. The parent
step blocks until the child reaches a terminal state, then maps that state to its own outcome.

Because a sub-workflow reference is just a step, "queue workflow B to run after workflow A, which
is already running" becomes "append one `{ type: workflow, workflow: B }` step to A's queue".
The queue is already the composition primitive; this plan gives it one more step type.

There is no navigation stack, breadcrumb bar, or auto-navigation. The child is an ordinary
registered instance, so it appears in `WorkflowStatus.tsx`'s dropdown like any other running
workflow. The parent step row gets a link to the child run.

We are pre-release with no backward-compatibility constraints; nothing here needs a compat shim.

> **Revision 2026-10-09.** Reviewed against the current codebase. Changes from the previous draft:
> schema refs moved to `$defs`; file paths and method names corrected; child launch redesigned
> around a host-agnostic port (the CLI has no orchestrator, and `createWorkflow(filePath)`
> returns an already-running instance for the same file); the "queue after running" path
> corrected (`appendAndContinueAtRun` refuses executing runs); pause redesigned to use existing
> PAUSING semantics instead of mirroring state across instances; a rule added for worktree
> inheritance; a Phase 0 refactor added for the ~50 files that branch on
> script-vs-prompt; effort re-estimated. All open questions are answered in
> [Design Decisions](#design-decisions).
>
> **Revision 2 (2026-10-09).** Parallel sub-workflow steps are now **in v1**, because fanning
> workflows out across worktrees and merging between waves is the main driver. Added:
>
> - the full worktree rules (D4a–e): the parent's checkout is the child's source checkout, a
>   dirty check before fan-out, lease delegation chains, and delegated merge leases;
> - a result summary as the step's output, so merge steps can find each lane's branch (D12);
> - a [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps) section listing each blocker
>   and its fix;
> - two prerequisite worktree bugs filed in `dev/bugs/backlog/`.

---

## Use Cases

- **Queue a workflow to run after one you already started.** This is the motivating case.
  Right-click a running workflow in the `WorkflowStatus` dropdown and choose "Queue workflow to
  run next…", then pick a file. One `subWorkflowStep` is appended to that instance's queue.
- **Fan out across worktrees, then merge before the next wave.** A `parallel` group of
  sub-workflow steps, each child on its own worktree, joined by a merge-and-fix step on the
  parent's branch. The next wave then branches from the merged result. This is the
  orchestration done by hand for `dev/implemented/EDITOR_INTELLIGENCE_STAGING_PLAN.md`; see
  [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps).
- **Reusable sub-workflows authored ahead of time**: setup, a test-and-fix loop, teardown.
- **Chains of specialized workflows**: implement → test → report, each in its own file with its
  own harness and model.
- **A team library** of workflow building blocks referenced from project workflows.
- **Independently configured runs**: workflow A uses `claude-cli` in a managed worktree; B, queued
  after it, uses `copilot-cli`. Each keeps its own settings.

---

## Design Decisions

These were the open or wrong points in the previous draft. Each is settled here with its reasoning.

### D1. Launching the child: a host-agnostic port, not `WorkflowOrchestrator.createWorkflow`

- `WorkflowExecutor` has no orchestrator reference.
- The CLI (`src/cli.ts`) builds exactly one `WorkflowInstance` and has no orchestrator at all.
- `WorkflowInstanceRegistry.createWorkflow(filePath)` (`WorkflowInstanceRegistry.ts:225`)
  returns the _existing_ instance when one for the same file is RUNNING/PAUSING/PAUSED. It also
  disposes the panel's idle viewed instance and steals panel focus. All three behaviours are
  wrong for a child.

**Decision:** add an optional `subWorkflowHost?: SubWorkflowHost` port to
`WorkflowExecutionContext` (`src/core/WorkflowExecutor.ts:187`). There is one shared
implementation, `SubWorkflowLauncher` in `src/core/orchestration/`, constructed with a
`createInstance: () => WorkflowInstance` factory:

- **VS Code and the hosted server:** `() => orchestrator.createExternalWorkflowInstance()`
  (`WorkflowInstanceRegistry.ts:218`). This is the same path `CommitMessageGenerator` uses. The
  instance is registered and announced to the dashboard, so it gets a dropdown row without
  changes to the dropdown.
- **CLI:** a factory that builds `new WorkflowInstance(...)` with the CLI's existing
  dependencies.

The launcher follows `CommitMessageGenerator.ts:563-670`: create the instance, load the file,
`await instance.executeLoadedPromptFile()`, then read `promptQueue.getState()` for the outcome.
`executeLoadedPromptFile` can return without throwing on preflight problems, with the state still
IDLE, so the launcher must classify the outcome from queue state, not from "it returned". The
launcher captures the result before the registry retires and disposes the finished child
(`WorkflowInstanceRegistry.ts:691-701`).

```typescript
interface SubWorkflowHost {
  launch(request: SubWorkflowLaunchRequest): Promise<SubWorkflowHandle>;
}

interface SubWorkflowLaunchRequest {
  resolvedPath: string;
  parent: SubWorkflowParentLink;
  /** Parent's execution root + checkout root: inherited when the child has no `worktree` key (D4a),
   *  and used as the source checkout for the child's own worktree (D4b). */
  parentExecution: { executionRoot: string; executionCheckoutRoot: string };
  /** Owner tokens of every blocked ancestor's lease, root first (D4d). */
  delegationChain: readonly string[];
  /** Set when resuming a parent whose step already started a child (D6). */
  resumeChildRun?: { workflowKey: WorkflowKey; runRef: RunRef };
  ancestorPaths: readonly string[];
}

interface SubWorkflowParentLink {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  stepId: string;
  /** Present when the step is the parent's finalStep. */
  loopIndex?: number;
}

interface SubWorkflowHandle {
  readonly workflowKey: WorkflowKey;
  readonly runRef: RunRef;
  readonly done: Promise<SubWorkflowResult>;
  pause(): Promise<void>;
  cancelPause(): Promise<void>;
  stop(): Promise<void>;
}

interface SubWorkflowResult {
  status: PromptTerminalStatus; // COMPLETED | FAILED | CANCELLED
  /** For CANCELLED: whether the parent requested it via handle.stop(), or the child was stopped directly. */
  cancelledBy?: "parent" | "child";
  failureMessage?: string;
  /** Projected from the child's `_runtime.worktree`; feeds D4e and the D12 summary. */
  worktree?: Pick<
    WorkingFileWorktreeRuntime,
    | "mode"
    | "branchName"
    | "baseCommit"
    | "finalBranchTip"
    | "changedFileCount"
    | "landingOutcome"
    | "mergeOutcome"
    | "conflictFiles"
  >;
  finalResponse?: string;
}
```

`WorkflowInstance` is where the context is built (`WorkflowInstance.ts:707-715`), so it is the
one place the port gets plumbed in. A missing host is a configuration error: the step fails with
"Sub-workflow steps are not supported in this host".

### D2. Stop: forward through the step's cancel resource, and propagate up through the outcome

`WorkflowInstance.stop()` (`:2407`) cancels each entry in `activeTargetResources`. With none
registered, it waits for up to 10 s on the detector integration. A step blocked on a child has no
integration, PTY, or process runner, so the sub-workflow step must register a cancel resource
that calls `handle.stop()`.

- **Parent stopped** → the cancel resource stops the child → the child ends STOPPED → `done`
  resolves CANCELLED → the parent step is CANCELLED → the parent confirms stopped.
  Propagation is recursive, because the child's own sub-workflow step does the same.
- **Child stopped directly** (from its own dropdown row) → `done` resolves CANCELLED → the parent
  step is CANCELLED and the parent stops. A stop is never negotiated through `onFail`.

### D3. Pause: reuse PAUSING ("pause after the current step"); no cross-instance state mirroring

The previous draft mirrored the child's `executionState` onto the parent. That means writing
into another instance's `WorkflowStateMachine` from outside. Resume would also break, because
`WorkflowInstance.resume()` (`:2326`) restarts execution through `startWorkflowExecution` while
the old executor is still awaiting the child, leaving two executors on one run.

ctrlyoke's pause already means "pause at the next step boundary": a long AI step keeps running
while the instance sits in PAUSING. A sub-workflow step is just a long step, so:

- **Pause the parent** → the parent enters PAUSING as usual, and `pause()` is forwarded to the
  active child through the handle. The child pauses at _its_ next step boundary and shows PAUSED
  in its own row. The parent stays PAUSING, which is accurate: it will pause when its current
  step, the child run, finishes.
- **Cancel the pause on the parent** (resume while PAUSING; `cancelPauseAtRun` already exists) →
  forwarded as `cancelPause()`/resume to the child.
- **Pause or resume the child directly** → nothing is propagated to the parent. The parent stays
  RUNNING, and its step row shows the child's live state ("Sub-workflow paused"), so the dashboard
  stays accurate without touching the parent's state machine.

Forwarding is one hook in `WorkflowInstance.pause()`/`cancelPause()`. When the active target is a
sub-workflow step, call the handle as well. No orchestrator-level parent↔child registry is
needed: the handle held by the running step _is_ the downward link. This also works in the CLI,
where there is no registry.

### D4. Worktree rules: the parent's checkout is the child's "source checkout"

A child's own `worktree` setting is always honoured. The parent only decides two things: where
a child with **no** `worktree` key runs, and which checkout a child's worktree **branches from
and merges back into**. Today that second checkout is always the VS Code workspace folder's
checkout. That is wrong once the parent is itself in a worktree, and it is what makes fan-out
and merge-back work.

| Child file's `worktree`           | Where the child runs                    | Branches from                    | `merge: true` merges into |
| --------------------------------- | --------------------------------------- | -------------------------------- | ------------------------- |
| _absent_                          | The parent's execution root (inherited) | —                                | —                         |
| `false`                           | The workspace's main checkout, as today | —                                | —                         |
| `true` / `{ mode: managed, … }`   | A new managed worktree                  | `base`, else the parent's `HEAD` | The parent's checkout     |
| `"branch"` / `{ mode: named, … }` | The named worktree (created or reused)  | `base`, else the parent's `HEAD` | — (named never merges)    |

**D4a. Inheritance (absent key).** "Implement in a worktree, then run a test sub-workflow"
must test the parent's changes, not main. The parent holds a lease on its root (exclusive if
it is a worktree), so the inheriting child needs a **delegated lease** (D4d).

**D4b. Source checkout = the parent's execution checkout.** `SubWorkflowLaunchRequest` carries
the parent's execution checkout root. The child's `WorktreeManager` call uses it as
`sourceCheckoutRoot`, instead of `repoToplevel(workspaceFolderPath)`
(`WorkflowInstance.ts:4364-4365`). That gives:

- `base` defaults to the parent's current `HEAD`;
- `targetBranch` is the parent's branch;
- `merge: true` lands in the parent's checkout.

Nested fan-out recurses: a grandchild branches from and merges into its parent's worktree,
which later merges into the root. Resolve the **worktrees root directory** from the
repository's main checkout, not from the source checkout. Otherwise children of a worktree
parent end up in a nested `<parent-wt>.worktrees/` folder.

**D4c. Uncommitted parent work before a worktree child starts.** A new worktree branches from
a commit, so uncommitted changes in the parent's checkout would silently be missing from the
child. The most common case is the "merge and fix" step before the next wave. Before
launching any worktree child, or once before a parallel group fans out so every lane shares one
base, check the parent's execution checkout:

- **Clean:** proceed.
- **Parent is a ctrlyoke-managed worktree:** checkpoint-commit with the same deterministic
  message settlement uses (`buildManagedAutoCommitMessage`). ctrlyoke already owns commits on
  that branch.
- **Parent is the main checkout or a named worktree:** this is a start failure → `onFail`, with
  the message "Commit or stash the parent's changes before starting worktree sub-workflows (dirty:
  N files)". ctrlyoke never commits to a checkout the user owns.

**D4d. Leases.** `ExecutionLeaseRequest` and the persisted `ExecutionLease` gain
`delegationChain?: string[]`: the owner tokens of every blocked ancestor, root first.
`isCompatible` (`ExecutionRootLeaseManager.ts:140`) additionally allows:

1. An existing lease whose `ownerToken` is in the request's chain. The ancestor is blocked
   waiting on this child.
2. Two delegated leases with the same immediate delegator. These are siblings inheriting one
   root, the same sharing parallel prompt members already have.

A **merge lease** from a child (`mergeManagedWorktree`, `WorktreeManager.ts:880-888`) carries
the chain too, so the blocked parent's own lease (shared-native on main, or exclusive on a
worktree) no longer turns `merge: true` into `blocked`. Rule 2 deliberately does **not** apply
to merge leases. A merge into a checkout where an inheriting sibling is still editing stays
blocked, and D8's preflight rejects that combination up front.

**D4e. Merge results are data, not failures.** `merge: true` can end `fast-forward`,
`merge-commit`, `conflict` (aborted cleanly, with `conflictFiles`), or `blocked`. The child
run's outcome is not changed by these, and neither is the parent step's: a COMPLETED child is a
COMPLETED step. The outcome goes into the step's result summary (D12), with a warning badge when
it isn't a clean merge. This fits the merge-and-fix pattern: the parent's next step resolves
whatever didn't merge cleanly.

**Queue-after-running** uses the same table. A file with no `worktree` key queued after a
managed-worktree run continues in that worktree.

**Prerequisite bugs** (both filed while preparing this revision, and both make fan-out
unreliable):

- [`managed-worktree-setup-runs-inside-mutation-lock`](../bugs/backlog/managed-worktree-setup-runs-inside-mutation-lock.md):
  concurrent managed starts fail with a lock timeout after 5 s of someone else's `setup`, or
  take over the lock after 30 s.
- [`managed-worktree-landing-blocked-when-agent-commits-everything`](../bugs/implemented/managed-worktree-landing-blocked-when-agent-commits-everything.md):
  fixed; forward commits on the recorded branch land and merge normally.

### D5. Path resolution: reuse `PromptFileResolver`; no `.ctrlyoke/workflows/` candidate

The previous draft claimed the resolution order was "same as promptStep" and listed
`.ctrlyoke/workflows/`. That directory is not a candidate today, and ctrlyoke does not own a
durable workflows folder (`WorkflowSerializer.ts:415`). Resolve the `workflow` value with
`PromptFileResolver.resolvePath` (`src/core/PromptFileResolver.ts:228`). Its order is: absolute
path, then the source definition's directory (trusted roots only), then the workspace root or
named root, then `<workspaceRoot>/.ctrlyoke/`. It applies the same trusted-root filtering
(`isCandidateAllowed`). This is a single source with prompt file references; any future change to
the order applies to both.

- **Parse time:** check that the file exists the way `validatePromptReference` does
  (`PromptFileParser.ts:902-918`), keeping the authored value as written.
- **Run time:** resolve to an absolute path again before launch, because the file may have moved.
- **Child loading:** the child file is loaded with the full parse/validate pipeline
  (`loadPromptFile`), so a schema error in the child fails the parent step with the validation
  message.

### D6. Resume and reload: reattach to the recorded child run instead of starting a new one

The `_runtime.childWorkflowKey`/`childRunRef` written on launch is what makes this possible.
When the parent re-executes a sub-workflow step (resume after a stop, or a window reload while
the step was in flight) and those fields are already set:

- **The recorded child run is COMPLETED:** the parent step completes without relaunching. This
  covers a crash between the child finishing and the parent recording it.
- **The recorded child run is STOPPED, ERROR, or interrupted:** continue that run through the
  existing continuation path (`executeContinuationAtRun`, `WorkflowInstance.ts:2212`) instead of
  creating a new lineage.
- **The child run directory is missing** (trashed): launch fresh and overwrite the linkage.

An explicit **re-run** of the parent (a new run seeded from the definition) starts with clean
step `_runtime` and therefore always launches fresh child runs.

### D7. Parent link is persisted on the child run

The child's run `manifest.json` records `parentRun: { workflowKey, runRef, stepId, loopIndex? }`.
This lets:

- the child's dropdown row and run view show "Started by _<parent name>_", with a link back;
- history/search reach the parent from a child run;
- D6 confirm that a recorded child run really belongs to this parent step before reattaching.

This is new and separate from the existing variant/re-run provenance (`sourceWorkflowKey`/
`sourceRunRef`, `CtrlYokeTypes.ts:535-570`), which means "derived from", not "spawned by".

### D8. Where the step is allowed

- **`steps[]`:** yes.
- **`finalStep`:** yes. Each pass launches a fresh child run (D6 reattach applies only within one
  pass). `parentRun.loopIndex` distinguishes the passes in history.
- **Inside a `parallel` group:** **yes, in v1.** This is the main driver: fan out several
  workflows onto their own worktrees, join, then merge on the parent's branch before the next
  wave. See [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps) for what this needs.
- **Single-step root** (`singleStepRoot`/`rootScriptStep`): no. A file that is only a reference
  to another file has no purpose.

### D9. Outcome mapping and `onFail`

| Child terminal state                                                  | Parent step                                       | Parent workflow                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| COMPLETED                                                             | COMPLETED                                         | advances                                                                                                                    |
| ERROR, failed, or failed to start (missing file, schema error, cycle) | `onFail: stopWorkflow` (default) → FAILED         | stops (`runtime.fail()`)                                                                                                    |
|                                                                       | `onFail: continue` → COMPLETED + `failureMessage` | advances                                                                                                                    |
| STOPPED (by anyone)                                                   | CANCELLED                                         | stops, regardless of `onFail`. Inside a parallel group, siblings finish first; see [Parallel](#parallel-sub-workflow-steps) |
| COMPLETED, but `merge: true` ended `conflict`/`blocked`               | COMPLETED + warning (D4e)                         | advances                                                                                                                    |

`onFail` uses the existing `ScriptStepAction` type and `CONDITION_ACTIONS` values, mirroring
`scriptStep.onFail` (`workflow-schema.json:960-965`). For `continue`, scripts today record a
plain COMPLETED with no warning state (`WorkflowExecutor.ts:2811-2815`). The sub-workflow step
does the same, and also sets `failureMessage`. The row renders a warning badge when a COMPLETED
sub-workflow step has a `failureMessage`. No new terminal status is introduced.

There is no `onPass`; a completed child always advances the parent.

### D10. Cycle detection only; no depth limit

`WorkflowExecutionContext.ancestorPaths` holds the resolved absolute paths of every workflow file
in the active chain, root first, compared case-insensitively on Windows. If the resolved child
path is already in the list, the step fails before launch with a message that names the cycle
(`a.ctrlyoke.yaml → b.ctrlyoke.yaml → a.ctrlyoke.yaml`). A long chain with no cycle is just N
sequential instances. Queuing the same file after itself is not a cycle, because the ancestor
chain contains only _active_ parents.

### D11. Variables and harness are not inherited

The child uses its own `vars` plus host-level `--var` overrides, and its own `harness`, falling
back to settings defaults (not the parent's harness). `{{var}}` substitution is not applied to
the `workflow` path in v1. Only the execution root is inherited (D4), because it is about _where_
the code lives, not _how_ the workflow is configured.

### D12. The step's output is a result summary that later steps can reference

A merge step has to know what each lane produced. Today it has no way to find out:

- a step that sends nothing to a harness produces no `$step:N` item, because empty text is
  skipped (`RunOutputResolver.ts:1011-1016`);
- `{{worktree.*}}` variables and `CTRLYOKE_WORKTREE_*` environment variables don't exist;
- a managed branch name contains the child's `runRef`, so it can't be written into the parent
  ahead of time;
- cross-run `priorContext: { workflowKey, runRef }` needs keys known when the workflow is
  authored.

**Decision:** when the child settles, the sub-workflow step records a **result summary** as its
output, written to the parent's timeline the same way script steps record stdout. It is
therefore reachable with `$step:N`, `$previous`, and `priorContext`. Referencing a whole
parallel group (`$step:2-5`) collects every lane. The format is a stable, agent-readable
block:

```text
Sub-workflow: f1-location (waves/f1-location.ctrlyoke.yaml)
Run: f1-location-2026-10-09T10-12-03 / run-2026-10-09T10-12-03
Outcome: completed
Worktree: managed, branch ctrlyoke/f1-location/run-2026-10-09T10-12-03 (base 5a1c460, tip 9f02c1d, 14 files changed)
Merge: conflict (src/completions/WorkflowLocationTypes.ts) — branch left unmerged
Final response:
<the child's last completed step output, capped at 8 KB>
```

Fields come from the child's `_runtime.worktree` (`WorkingFileWorktreeRuntime`,
`CtrlYokeTypes.ts:580-612`) and its last completed step's output. Lines that don't apply are
omitted. A script merge step that needs fixed branch names should use named worktrees, whose
branch is authored. An AI merge step reads the summary.

Expanding the child's complete output into the parent is still out of scope; the summary plus
the "Open run" link cover what a merge step needs.

---

## Phase 0 — Prerequisite: make step-kind branching exhaustive

About 50 non-test files branch on `isScriptStep(...)` / `STEP_TYPES.SCRIPT` with an implicit
"otherwise it's a prompt". The heaviest are `PromptQueue.ts` (14), `editorStore.ts` (13),
`FinalStepFooter.tsx`, `WorkflowStepSanitizer.ts`, `PromptFileParser.ts` (10 each),
`ExecutionPreviewService.ts` (9), `WorkflowInstance.ts`, `WorkflowExecutor.ts` (8 each), and
`mcp-server.ts` (7). Adding a third kind to the `WorkflowStep` union would compile cleanly and
silently treat sub-workflow steps as prompts in every one of those places.

Before adding the new step kind:

1. Add `getStepType(step): WorkflowStepType` and an `isPromptStep` guard to `CtrlYokeTypes.ts`,
   next to `isScriptStep` (`:895`).
2. Convert each binary `isScriptStep ? … : …` branch that reads kind-specific fields into an
   exhaustive `switch (getStepType(step))` with an `assertNever` default, or into `isPromptStep`
   where only prompt fields matter.
3. This lands on its own, with no behaviour change, and makes adding the new kind a
   compiler-guided change. `USER_INPUT_STEP_PLAN.md` adds a fourth step kind and benefits from
   the same refactor; whichever plan lands second only adds `case` arms.

---

## Schema Design (`schemas/workflow-schema.json`)

Definitions live under **`$defs`** (draft 2020-12). Step definitions do not set
`additionalProperties`; strictness comes from the `workflowStep` wrapper's
`unevaluatedProperties: false` (`:783`), and the new definition follows that pattern.

### Extract a shared step-lifecycle runtime definition

`promptRuntimeMetadata` (`:1199-1277`) mixes execution-property echoes with lifecycle fields the
queue relies on (`stepId` for `claimStepById`, `startedAt`, `completedAt`, `terminalStatus`,
`elapsed`, `failureMessage`, `terminalFailure`). Extract the lifecycle fields into
`stepLifecycleRuntime`, and have `promptRuntimeMetadata` `allOf` it. Script steps keep reusing
`promptRuntimeMetadata`.

### `subWorkflowStep`

The display properties (`name`, `enabled`, `color`) are declared inline in `promptStep`
(`:852-865`) and again in `scriptStep`. Extract them into a `stepDisplayProperties` def that all
three step definitions `allOf`. This removes the duplication and keeps the new step from adding
a third copy.

```json
"subWorkflowStep": {
  "type": "object",
  "description": "Runs another ctrlyoke workflow file to completion as its own child run, with its own lineage, run history, and dashboard entry. The child keeps its own harness, vars, and finalStep. If the child file has no worktree key, it runs in the parent's execution root; otherwise its worktree setting is honoured. The parent step waits until the child run ends.",
  "allOf": [{ "$ref": "#/$defs/stepDisplayProperties" }],
  "properties": {
    "type": { "type": "string", "const": "workflow", "description": "Marks this step as a sub-workflow step." },
    "workflow": {
      "type": "string",
      "minLength": 1,
      "description": "Path to the workflow file to run. Resolved like a prompt file reference: absolute path, then the referencing file's directory (trusted roots only), then the workspace root, then .ctrlyoke/."
    },
    "onFail": {
      "type": "string",
      "enum": ["continue", "stopWorkflow"],
      "default": "stopWorkflow",
      "description": "What to do when the child run fails or cannot start. 'stopWorkflow' fails this step and stops the parent; 'continue' records the failure on the step and advances. A stopped child always stops the parent."
    },
    "_runtime": { "$ref": "#/$defs/subWorkflowRuntimeMetadata" }
  },
  "required": ["type", "workflow"]
}
```

### `subWorkflowRuntimeMetadata`

```json
"subWorkflowRuntimeMetadata": {
  "type": "object",
  "description": "Runtime linkage to the child run this step started (added automatically during execution).",
  "allOf": [
    { "$ref": "#/$defs/stepLifecycleRuntime" },
    {
      "properties": {
        "childWorkflowKey": { "type": "string", "description": "Lineage key of the child run." },
        "childRunRef": { "type": "string", "description": "Run reference of the child run; used to open it and to reattach on resume." },
        "resolvedWorkflowPath": { "type": "string", "description": "Absolute path the workflow reference resolved to when the child launched." }
      }
    }
  ],
  "unevaluatedProperties": false
}
```

### Wiring

- `workflowStep`'s inner `oneOf` gains `{ "$ref": "#/$defs/subWorkflowStep" }`. `steps[]` and
  `finalStep` both reference `workflowStep`, so both accept it.
- `parallelGroupItem.parallel.items` already references `workflowStep`, so groups accept the
  new kind with no structural change. Update its description: "members share the workspace
  and worktree" now applies only to prompt and script members, and to sub-workflow members
  whose file has no `worktree` key (D4).
- The loose `steps[]`/`finalStep` re-description in the root `allOf/if not _templateMeta` block
  (`:13-82`) must not reject the new kind. Verify it doesn't, and widen it if it does.
- After editing, run `npm run schema:update`. This regenerates the YAML schema,
  `SchemaDescriptions.ts`, `WorkflowSchemaOutline.ts`, and the reference docs. The change is
  additive, so no `schema:bump` is needed.

---

## Type System (`src/types/`)

```typescript
// DashboardConstants.ts — STEP_TYPES (:3440)
export const STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
  WORKFLOW: "workflow",
} as const;
// PREVIEW_STEP_TYPES (:1718) is a separate dry-run copy; add WORKFLOW there too if the preview
// renders sub-workflow steps (see Execution Preview below).

// PROMPT_PROPERTIES (:3688) gains:
WORKFLOW_REF: "workflow",
// ON_FAIL already exists; reuse it.

// New: SUB_WORKFLOW_STEP_COPY_FIELDS, the parser's copy whitelist, alongside
// SCRIPT_STEP_COPY_FIELDS (:3806).
```

```typescript
// CtrlYokeTypes.ts
export interface SubWorkflowStep extends StepDisplayProperties {
  type: typeof STEP_TYPES.WORKFLOW;
  workflow: string;
  onFail?: ScriptStepAction; // continue | stopWorkflow
  _runtime?: SubWorkflowRuntimeMetadata;
}

export interface StepLifecycleRuntime {
  stepId?: string;
  startedAt?: number;
  completedAt?: number;
  terminalStatus?: PromptTerminalStatus;
  elapsed?: number;
  failureMessage?: string;
  terminalFailure?: boolean;
}

export interface SubWorkflowRuntimeMetadata extends StepLifecycleRuntime {
  childWorkflowKey?: WorkflowKey;
  childRunRef?: RunRef;
  resolvedWorkflowPath?: string;
}

export type WorkflowStep = PromptStep | ScriptStep | SubWorkflowStep; // (:881)

export function isSubWorkflowStep(step: WorkflowStep): step is SubWorkflowStep {
  return step.type === STEP_TYPES.WORKFLOW;
}
```

`PromptRuntimeMetadata` (`:968`) extends `StepLifecycleRuntime`, matching the schema extraction.
`WorkflowExecutionContext` gains `subWorkflowHost?` (D1) and `ancestorPaths?: readonly string[]`
(D10).

---

## Parser (`src/core/PromptFileParser.ts`)

- `normalizePromptFile` (`:969`): the `steps[]` loop (`:1037`) and the `finalStep` branch
  (`:1081-1095`) gain a `STEP_TYPES.WORKFLOW` arm that calls a new `buildSubWorkflowStep`, which
  copies `SUB_WORKFLOW_STEP_COPY_FIELDS`. The `finalStep` branch currently drops anything that is
  neither script nor prompt, so it needs the arm explicitly.
- The parallel-member path (`:1009-1035`): `isPromptOrScriptSource` (`:1178-1189`) becomes
  `isParallelMemberSource` and accepts `type: workflow`. Members go through
  `buildSubWorkflowStep`. Other step kinds (e.g. `USER_INPUT_STEP_PLAN.md`'s `userInput`) are
  still rejected (`promptFileParser.test.ts:604-617`), following `PARALLEL_STEPS_PLAN.md:53-56`'s
  explicit-opt-in rule.
- `validateWorkflowSteps` (`:1441`): a sub-workflow branch before the `!item.prompt` check
  (`:1507`). It requires a non-empty `workflow` and runs the file-existence check from D5.
- The root `type: "script"` single-step branch (`:973`) needs no change; a root
  `type: "workflow"` fails schema validation (D8).

---

## Execution Architecture

### Dispatch

`executeTargetContract` (`WorkflowExecutor.ts:1910`) currently routes disabled steps to
`handleSkippedStep`, script steps to `executeScriptStep(step, stepIndex, context, target)`
(`:1944`), and everything else into the inline AI attempt loop (`:1955`). After Phase 0 this is
a `switch (getStepType(step))` with a new `executeSubWorkflowStep(step, stepIndex, context, target)`
arm. Final-step script dispatch passes `stepIndex = -1` (`:1945`), and the new arm follows the
same convention.

Parallel members reach the same `executeTargetContract` through `ParallelGroupRun.runMember` →
`executeWithSnapshot` → `executeTarget`, so the dispatch arm serves both paths. What the
group itself needs is in [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps).

### `executeSubWorkflowStep`

1. `context.dashboardProvider.updateStepStatus(..., RUNNING)`, the same call script steps make
   (`:2571-2575`).
2. Resolve the `workflow` reference (D5). If it is missing or unresolvable, it is a start failure
   → `onFail`.
3. Cycle check against `context.ancestorPaths` (D10). A cycle is a start failure → `onFail`.
4. If `_runtime.childRunRef` is set, follow D6 (complete immediately, reattach, or launch fresh).
5. Otherwise call `context.subWorkflowHost.launch({ resolvedPath, parent, parentExecution, delegationChain, ancestorPaths: [...ancestorPaths, resolvedPath] })`.
   For a sequential step, run the D4c dirty check first. For parallel members, group preflight
   has already run it once.
6. As soon as the handle exists, persist `childWorkflowKey`, `childRunRef`, and
   `resolvedWorkflowPath` to the step's `_runtime`. This lights up the dashboard link and makes
   D6 work if the host dies mid-step.
7. Store the handle on the target's `ActiveTargetResources` entry (`WorkflowInstance.ts:243-249`)
   in a new `subWorkflow?: SubWorkflowHandle` field. The entry is keyed per target
   (`queue:<i>` / `final:<n>`), so a parallel group holds one entry per child. Extend
   `cancelTarget` (`:959-976`), `releaseTargetResources` (`:874`) and `stop()` (`:2464-2476`) to
   call `handle.stop()`, which is what D2 needs. Extend `pause()`/`cancelPause()` to forward to
   every live `subWorkflow` handle (D3).
8. `await handle.done`, then map the result using D9. Record the D12 result summary as the
   step's output event. Record the outcome through the same `promptQueue` calls
   `executeScriptStep` uses (`failStep`, `cancelStep`, and normal completion), so
   `commitSequentialOutcome` (`:1722`), the final-step loop (`:621-840`) and `ParallelGroupRun`
   need no sub-workflow knowledge beyond what the parallel section lists.
9. Always clear the `subWorkflow` field in `finally`.

### `SubWorkflowLauncher.launch` (`src/core/orchestration/SubWorkflowLauncher.ts`)

1. `createInstance()` from the host factory (D1).
2. Load the file through the normal file path (`instance.loadPromptFile(resolvedPath)`), or, for
   reattach, the run-continuation path. Pass the parent link (D7), the ancestor chain, and any
   inherited execution root (D4) through `loadPromptFile`/execution options. Do not use
   post-hoc setters.
3. Start `instance.executeLoadedPromptFile()` without awaiting it. Wrap it into `done`, which
   reads `promptQueue.getState().status` after settlement and maps COMPLETED / STOPPED /
   ERROR-or-unstarted to `SubWorkflowResult`.
4. Return the handle once `workflowKey`/`runRef` are known (after load).

### Final-step interaction

A sub-workflow `finalStep` runs inside the outer final-step loop like any other final step.
Appending a sub-workflow step to a running instance (see Queuing below) grows the in-memory
queue, which the loop-back check (`:793-821`) already sees. The open bug
`dev/bugs/backlog/final-step-loop-decision-misses-unmerged-external-appends.md` affects only
_external on-disk_ appends (MCP, `ctrlyoke step add`), not the dashboard path here, so it does
not block this plan.

---

## Parallel Sub-workflow Steps

The target pattern is the one run by hand for `dev/implemented/EDITOR_INTELLIGENCE_STAGING_PLAN.md`:

1. A wave of independent workflows, each on its own worktree.
2. A join.
3. A "merge and fix" step on the parent's branch.
4. The next wave, branching from the merged result.

As one authored workflow:

```yaml
# editor-intelligence.ctrlyoke.yaml (parent runs on the main checkout)
name: editor-intelligence
worktree: false
steps:
  - parallel: # wave 1
      - { type: workflow, workflow: waves/f1-location.ctrlyoke.yaml } # each child file: worktree: { mode: managed }
      - { type: workflow, workflow: waves/d1-lint-rules.ctrlyoke.yaml }
      - { type: workflow, workflow: waves/m1-palette.ctrlyoke.yaml }
    failFast: false # one lane failing should not kill hours of work in the others
  - name: Merge wave 1 and fix
    prompt: |
      Merge every branch reported in $step:1-3 into the current branch, resolve conflicts,
      run `npm test`, fix failures, and commit the result.
  - parallel: # wave 2 branches from the merge step's commit (D4b/D4c)
      - { type: workflow, workflow: waves/f3-completions.ctrlyoke.yaml }
      - { type: workflow, workflow: waves/d2-diagnostics.ctrlyoke.yaml }
    failFast: false
  - name: Merge wave 2 and fix
    prompt: Merge every branch reported in $step:5-6 into the current branch, …
```

A lane can instead use `merge: true` in its own file to auto-merge at settlement. Conflicts are
then reported in the summary (D4e) and left for the merge step. Auto-merge suits lanes that
rarely conflict; leaving the merge to the AI step suits overlapping lanes.

### What currently prevents this, and the fix for each

| #   | Blocker today                                                                                                                                                                                                | Fix in this plan                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The parser only accepts prompt and script members (`isPromptOrScriptSource`, `PromptFileParser.ts:1168-1189`); the plan previously excluded the kind on purpose                                              | Accept `type: workflow` members (Parser section). The schema already references `workflowStep`.                                               |
| P2  | `ActiveTargetResources` has no slot for a child, so fail-fast's `cancelRunning` → `cancelTarget` (`ParallelGroupRun.ts:661-668`, `WorkflowInstance.ts:959-976`) and `stop()` could not reach a running child | `subWorkflow` handle field per target (Execution step 7)                                                                                      |
| P3  | Group preflight assumes a harness member: `checkHarnessReady`, `ensureIsolatedIntegration`, session-collision checks (`ParallelGroupPreflight.ts:240-329`)                                                   | Sub-workflow members skip those checks, as script members already skip harness and session checks. They get their own checks instead (below). |
| P4  | Every child resolves its worktree base from, and merges into, the VS Code workspace checkout, not the parent's checkout                                                                                      | D4b source-checkout override                                                                                                                  |
| P5  | `merge: true` into a checkout where the parent holds a lease is refused as `blocked` (`WorktreeManager.ts:880-888`); the parent always holds one                                                             | D4d delegated merge lease                                                                                                                     |
| P6  | Wave N+1 branches from `HEAD`, so uncommitted fixes from the merge step are silently missing                                                                                                                 | D4c dirty-parent check before fan-out                                                                                                         |
| P7  | Concurrent managed starts with a slow `setup` fail with a lock timeout, or take over the 30 s-stale mutation lock                                                                                            | Prerequisite bug fix (D4)                                                                                                                     |
| P8  | A child whose agent commits its own work never lands or merges                                                                                                                                               | Fixed; managed settlement accepts forward commits on the recorded branch                                                                      |
| P9  | The merge step has no way to learn each lane's branch                                                                                                                                                        | D12 result summary                                                                                                                            |
| P10 | Several children inheriting one exclusive worktree root would conflict on their leases                                                                                                                       | D4d sibling-delegation rule                                                                                                                   |

### Group preflight for sub-workflow members

`preflightParallelGroupMember` (`ParallelGroupPreflight.ts:154-340`) gains a sub-workflow branch.
It resolves and **parses each child file once**; the launcher reuses that parse. It classifies
the child's execution plan from its `worktree` key using the D4 table, then checks:

- **Unresolvable path, child validation error, or cycle (D10)** → a per-member issue. The member
  settles FAILED and its `onFail` applies, as preflight failures do today (`:526-536`).
- **Two members targeting the same named worktree branch** → `WORKTREE_COLLISION` (a new
  `PARALLEL_PREFLIGHT_ISSUE_CODES` entry). Only one could ever hold its exclusive lease.
- **One member inheriting the parent's root while another has `merge: true` into it** →
  `MERGE_INTO_SHARED_ROOT`. The merge would land under an agent that is still editing. The fix
  for the author is to give the inheriting member its own worktree, or drop `merge`.
- **Parent checkout dirty and any member creates a worktree** → the D4c rule, applied **once for
  the group** before any worker starts. Every lane then branches from one commit.

The existing `INTERACTIVE_MULTIPLEX` check is about one instance multiplexing interactive
terminals. Children are separate instances whose own steps go through their own preflight. A
sub-workflow member therefore counts as non-interactive here. Verify during implementation that
`supportsConcurrentInteractiveSessions` is per instance; if it turns out to be host-wide, the
child's own preflight surfaces it as a start failure.

### Group behaviour

- **Width:** `queue.maxParallelSteps` (default 6) caps concurrently running children. Each
  child's own parallel groups apply their own width, so total harness concurrency is the
  product. That is documented, not capped, in v1.
- **Fail fast:** with `failFast: true` (the schema default), a failing lane cancels its siblings
  through `cancelRunning` → `cancelTarget` → `handle.stop()`. The abort-caused CANCELLED rewrite
  (`ParallelGroupRun.ts:563-569`) already classifies those siblings correctly. The authoring
  guide recommends `failFast: false` for long fan-outs.
- **Stopping one lane directly** (from the child's own dropdown row): only that member settles
  CANCELLED. Its siblings keep running, because stopping one lane should not discard others'
  work. At the join, any user-cancelled member makes the group return `stopped`, so
  `finishParallelGroupRun` (`WorkflowExecutor.ts:1262-1311`) stops the parent **instead of
  advancing to the merge step with a missing lane**. Resuming the parent recovers the settled
  members (`getRecoveredGroupOutcome`) and reattaches the stopped lane's child run (D6). The
  handle tells the two cancellations apart: `SubWorkflowResult.cancelledBy` is `"parent"` when
  the cancel came through `handle.stop()`, and `"child"` otherwise.
- **Stopping the parent:** `subscribeToStop` → `cancelRunning` stops every child (D2).
- **Pause:** `ParallelGroupRun` already stops dispatching new members on PAUSING. D3's forwarding
  pauses every running child at its next step boundary. The parent stays PAUSING until they
  settle, the same contract as a running prompt member.
- **Snapshots:** the group "before"/"after" snapshot covers the parent's root, which includes
  members that inherit it. Children in their own worktrees don't touch it, and their changes
  reach the parent only through merges, which the next snapshot captures. No change needed.
- **Recovery:** members are identified by `stepId` as today. Settled members are recovered;
  in-flight ones re-execute and take the D6 reattach path.

### Ad-hoc fan-out: "Run alongside the current step"

The manual version of this pattern is starting workflows side by side while one is already
running. `appendStepsToActiveParallelGroup` (`RunContinuationService.ts:487-706`) already
supports `QUEUE_POSITION.PARALLEL_WITH_CURRENT`: it joins the active group or promotes the
running step into a new `failFast: false` group. Because it takes any `workflowStep`, a
sub-workflow step can join with no core change. Add a **"Run workflow alongside current
step…"** entry next to "Queue workflow to run next…" (see Entry points). It sends `appendMode:
"subWorkflow"` with `position: "parallelWithCurrent"`. It is subject to that path's existing
rules: the run must be RUNNING, width must be > 1, and the run must not be in the final-step
phase. Check during implementation whether the in-memory `instance.appendFromFile` path honours
`PARALLEL_WITH_CURRENT`. If it does not, route this entry through `RunContinuationService` the
way the MCP tool does (`mcp-server.ts:1191`).

---

## Queuing a Workflow After One That's Already Running

The previous draft said this needed only a different payload on `appendFromFileForClient`. That
is half true:

- **Without a run address**, `appendFromFileForClient` (`WorkflowOrchestrator.ts:1895`) calls
  `instance.appendFromFile` (`WorkflowInstance.ts:2551`). That appends to the live instance's
  queue in memory, even while it is RUNNING, but it spreads `parsed.steps` and drops the file's
  workflow-level settings.
- **With a run address**, it calls `appendAndContinueAtRun`, which **refuses an actively
  executing run** (`RunLifecycleService.validateExplicitContinuationTarget`, `:877-986`). It also
  drops `position` and `parallelGroups`.

**Design:** add one shared builder, used by every entry point:

```typescript
// WorkflowInstance (or a small helper next to appendFromFile)
buildSubWorkflowReferenceStep(filePath: string): SubWorkflowStep
// → { type: STEP_TYPES.WORKFLOW, workflow: <path relative to the workspace root if inside it, else absolute> }
```

Then add an `appendMode: "inline" | "subWorkflow"` parameter, default `"inline"`, to
`appendFromFileForClient` and `instance.appendFromFile`. In `"subWorkflow"` mode the appended
tail is `[buildSubWorkflowReferenceStep(path)]` instead of `parsed.steps`. The child file is
still parsed once up front to fail fast on schema errors; its steps are not used. Route by state:

- **Instance RUNNING/PAUSING/PAUSED** → `instance.appendFromFile(..., "subWorkflow")` (in-memory
  append; it is picked up at the next step boundary and, if the queue already drained, by the
  final-step loop-back).
- **Run COMPLETED/STOPPED/ERROR** → `appendAndContinueAtRun(address, [step], …)`. This is the
  existing continue-a-finished-run path; it just gets a one-element tail.

### Entry points

| Surface                                                                             | Change                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowStatus.tsx` dropdown row context menu (`hooks/useWorkflowContextMenu.tsx`) | New item **"Queue workflow to run next…"** on running/paused/finished run rows, and **"Run workflow alongside current step…"** on running rows (see Parallel, ad-hoc fan-out). |
| `WorkflowControls.tsx` queue split-button (`:101`)                                  | New option **"Queue as sub-workflow…"** next to the existing inline "Queue Workflow".                                                                                          |
| Workspace viewer file menus (`hooks/useWorkflowFileMenuItems.ts:52`)                | Same option for a workflow file.                                                                                                                                               |
| VS Code explorer                                                                    | New `ctrlyoke.queueAsSubWorkflowFromContext` command next to `ctrlyoke.queueFromContext` (`extension.ts:1022`).                                                                |

All of them send the existing `APPEND_FILE` message (`WebviewMessageTypes.ts:2286`) with a new
optional `appendMode` field. There is no new message type. The handler is
`WebviewMessageRouter.ts:875`, not `CtrlYokeWebviewProvider.ts`, which only forwards messages. The
hosted server shares that router through `DashboardApplication`, so hosted parity comes free.
Picking the file follows the existing split: VS Code uses a native picker via
`selectWorkspacePath`; hosted mode uses `WorkflowFilePickerModal`.

Existing inline append behaviour (splicing steps into the current run and session) is unchanged.

---

## Dashboard

### Parent step row

There is no `PromptItem.tsx`. Rows are `WorkflowStepRow` (`prompts/WorkflowStepRow.tsx`), which
renders `WorkflowStepItem` (`prompts/WorkflowStep.tsx`), and script steps are a branch inside it
(`WorkflowStep.tsx:310-343`). After Phase 0 that branch becomes a switch, and the sub-workflow arm
renders:

- a workflow icon, a **"Workflow"** badge, and the referenced file's name as the subtitle;
  `getStepText` (`:97`) returns `step.workflow`; there is no harness/model badge or token count;
- a live status badge for the child, looked up by `_runtime.childWorkflowKey` from the
  workflows the store already tracks (running / paused / completed / failed);
- the warning badge from D9 when the step completed with a `failureMessage`;
- an **"Open run →"** link once `childRunRef` is set. It calls
  `navigateToWorkflowAddress(vscode, { workflowKey, kind: "run", runRef }, name)`
  (`utils/runNavigation.ts:111`). One run-address link covers both a live child and a finished
  one, so no separate "View live output" and "View run" states are needed.

The step's output area (`layout/OutputSection.tsx`) renders the D12 result summary: outcome,
branch, and merge result, with the child's final response collapsed. It does not mirror the
child's full output; that lives in the child's own view. Inside a `ParallelGroupPanel`, members
are ordinary `WorkflowStepRow`s, so each lane gets this variant with no panel change. The
existing per-member output filter chips (`utils/outputRows.ts:179-209`) filter the summaries.

### Child run

The child's dropdown row and run header show **"Started by _<parent>_"**, linked to the parent
run via the same `navigateToWorkflowAddress` call, from `parentRun` in the child's manifest (D7).
The dropdown needs no other change.

### Editor

- **Step-type toggle** (`layout/EditorSection.tsx:286-320`, `editorStore.setStepType`): a third
  **Workflow** option.
- **`components/editor/PromptEditor.tsx`:** an `isSubWorkflowMode` path alongside `isScriptMode`
  (`:308`). It shows a workflow-file field with a browse button (same picker split as above), an
  `onFail` select (reuse the script step's select component), and the shared name/color/enabled
  fields. All prompt-only and script-only sections are hidden.
- **Building properties:** add a `buildSubWorkflowProperties` next to `buildScriptProperties`
  (`:842`). Fold the duplicated inline script-properties logic (`:1111-1164`) into
  `buildScriptProperties` in the same change, so the new mode doesn't copy the duplication.

### Execution preview

`ExecutionPreviewService.ts` (9 script branches) and `utils/executionPreview.ts`: a sub-workflow
step previews as a single "Runs _<file>_" entry. The preview does not expand child steps in v1.

---

## CLI and MCP

- **CLI (`src/cli.ts`):**
  - The CLI constructs its `WorkflowInstance` with a `SubWorkflowLauncher` whose factory builds
    sibling instances with the same dependencies.
  - Child step progress goes through the same console reporter, prefixed with the child
    workflow's name.
  - `CliJsonResultBuilder.ts` adds `subWorkflowRuns: [{ stepId, workflowKey, runRef, status }]`
    to the parent's JSON result.
  - The exit code reflects only the parent's outcome, which already incorporates `onFail`.
  - The `--step` selection and `CliPropertyOverrides.ts` (6 script branches) are covered by
    Phase 0.
- **MCP server (`src/mcp-server.ts`):** no new tool. Existing append tools validate against
  `workflowStep`, so they accept `type: workflow` once the schema arm exists. Its 7 script
  branches are covered by Phase 0.
- **`SCRIPT_GENERATED_STEPS_PLAN.md`:** `ctrlyoke step add` gets sub-workflow steps for free,
  for the same reason.

---

## Completions (`src/completions/`)

- `WorkflowLocationTypes.ts`:
  - add `WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP`;
  - detect it in object-kind detection (`:150-174`) by `type: workflow`;
  - map its text-holding key (`workflow`) to a new file-path role (`:52-91`).
- `WorkflowFileCompletionCore.ts`: key filtering (`:161-203`) gains a `subWorkflowOnly` set from
  `WORKFLOW_SCHEMA_OUTLINE[SUB_WORKFLOW_STEP]`, which `schema:update` generates. Prompt and
  script keys are suppressed. Exclude sub-workflow steps from session/prior-context candidates
  (`:470-472`).
- `WorkflowPropertySnippets.ts`: update the `type` snippet detail (`:31`) to
  `"prompt" | "script" | "workflow"`, and add a sub-workflow step snippet.
- Path completion for the `workflow` value: reuse the existing prompt-file-path completion,
  filtered to workflow file extensions.

---

## YAML Authoring UX

```yaml
# parent.ctrlyoke.yaml
harness: claude-cli
worktree: true # managed worktree; children without their own worktree key run in it too

steps:
  - name: Implement feature
    prompt: Implement the feature described in #file:spec.md

  - name: Test and fix (own harness, same worktree)
    type: workflow
    workflow: workflows/test-and-fix.ctrlyoke.yaml
    onFail: continue

  - name: Ship it
    prompt: Create a PR for the completed changes.

finalStep:
  type: workflow
  workflow: workflows/post-build-checks.ctrlyoke.yaml
```

---

## Edge Cases

| Scenario                                              | Handling                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle (A → B → A)                                     | Start failure naming the cycle (D10) → `onFail`                                                                                               |
| Deep chain with no cycle                              | Allowed; no depth limit                                                                                                                       |
| Same file queued after itself                         | Allowed; not an active-ancestor cycle                                                                                                         |
| Child file missing or unresolvable                    | Start failure → `onFail`                                                                                                                      |
| Child schema/validation error                         | Start failure carrying the validation message → `onFail`                                                                                      |
| Child fails (ERROR)                                   | `onFail` (D9)                                                                                                                                 |
| Child stopped (from either level)                     | Parent step CANCELLED, parent stops (D2)                                                                                                      |
| Parent paused while blocked                           | Parent PAUSING; pause forwarded to the child (D3)                                                                                             |
| Child paused directly                                 | Parent stays RUNNING; the step row shows the child's paused state (D3)                                                                        |
| Window reload or crash mid-child                      | The parent resumes and reattaches to the recorded child run (D6)                                                                              |
| Child has no `worktree` key                           | Runs in the parent's execution root via a delegated lease (D4a/D4d)                                                                           |
| Child has `worktree: false` / managed / named         | Honoured as authored. Worktrees branch from, and merge into, the parent's checkout (D4b)                                                      |
| Parent checkout dirty when a worktree child starts    | Managed parent: checkpoint commit. Main/named parent: start failure → `onFail` (D4c)                                                          |
| Child `merge: true` conflicts or is blocked           | Step COMPLETED with warning; reported in the result summary for the next step (D4e/D12)                                                       |
| Child names the same named worktree the parent holds  | Delegated lease applies only to inheritance; an explicit conflicting worktree raises `ExecutionLeaseConflictError` → start failure → `onFail` |
| Child has its own `finalStep`                         | Runs as part of the child run                                                                                                                 |
| Two parallel members target the same named worktree   | `WORKTREE_COLLISION` preflight issue                                                                                                          |
| Parallel member inherits the root another merges into | `MERGE_INTO_SHARED_ROOT` preflight issue                                                                                                      |
| One parallel lane stopped by the user                 | Siblings finish; parent stops at the join; resume reattaches the stopped lane                                                                 |
| One parallel lane fails, `failFast: true`             | Siblings' children are stopped (CANCELLED); group fails                                                                                       |
| Nested fan-out (a child that fans out itself)         | Grandchildren branch from and merge into the child's worktree (D4b); lease chains cover every level (D4d)                                     |
| `worktree` key on a sub-workflow step                 | Schema error (the existing `workflowStep` wrapper rule)                                                                                       |
| `{{var}}` in the `workflow` path                      | Not substituted in v1 (D11)                                                                                                                   |
| Host without `subWorkflowHost`                        | Step fails with "not supported in this host"                                                                                                  |

---

## File Change Summary

| File                                                                                                                                     | Change                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~50 files with `isScriptStep`/`STEP_TYPES.SCRIPT` branches                                                                               | **Phase 0:** exhaustive `getStepType` switch / `isPromptStep`                                                                                                     |
| `schemas/workflow-schema.json` (+ `npm run schema:update` outputs)                                                                       | `stepLifecycleRuntime` + `stepDisplayProperties` extraction, `subWorkflowStep`, `subWorkflowRuntimeMetadata`, `workflowStep` arm, `parallelGroupItem` description |
| `src/types/DashboardConstants.ts`                                                                                                        | `STEP_TYPES.WORKFLOW`, `PROMPT_PROPERTIES.WORKFLOW_REF`, `SUB_WORKFLOW_STEP_COPY_FIELDS`, `WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP`, `APPEND_MODES`               |
| `src/types/CtrlYokeTypes.ts`                                                                                                             | `SubWorkflowStep`, `StepLifecycleRuntime`, `SubWorkflowRuntimeMetadata`, union, `isSubWorkflowStep`, `getStepType`, `isPromptStep`, manifest `parentRun`          |
| `src/types/WebviewMessageTypes.ts`                                                                                                       | Optional `appendMode` on `AppendFileMessage`                                                                                                                      |
| `src/core/PromptFileParser.ts`                                                                                                           | `buildSubWorkflowStep`, `finalStep` arm, validation, parallel rejection                                                                                           |
| `src/core/WorkflowExecutor.ts`                                                                                                           | Context `subWorkflowHost`/`ancestorPaths`, dispatch arm, `executeSubWorkflowStep`                                                                                 |
| `src/core/orchestration/SubWorkflowLauncher.ts` (new)                                                                                    | `SubWorkflowHost` implementation shared by every host                                                                                                             |
| `src/core/WorkflowInstance.ts`                                                                                                           | Context plumbing, pause/cancel-pause forwarding, `appendFromFile` `appendMode`, parent link and inherited root in load/execution options                          |
| `src/core/orchestration/ExecutionRootLeaseManager.ts`                                                                                    | `delegationChain` on requests and leases; ancestor and sibling compatibility (D4d)                                                                                |
| `src/core/orchestration/WorktreeManager.ts`, `src/core/WorkflowInstance.ts` (`:4364-4411`)                                               | Source-checkout override (D4b), worktrees root from the main checkout, checkpoint commit (D4c), delegated merge lease (D4d), plus the two prerequisite bugs       |
| `src/core/ParallelGroupRun.ts`, `src/core/ParallelGroupPreflight.ts`, `DashboardConstants.ts` (preflight codes)                          | Sub-workflow preflight branch, `WORKTREE_COLLISION` / `MERGE_INTO_SHARED_ROOT`, once-per-group dirty check, user-cancelled lane → stop at join                    |
| `src/core/orchestration/RunOutputResolver.ts` (verify only)                                                                              | Confirm the D12 summary is picked up as step output; it should need no change                                                                                     |
| Run manifest writer (where `manifest.json` is built)                                                                                     | `parentRun` (D7)                                                                                                                                                  |
| `src/core/WorkflowOrchestrator.ts`, `WorkflowInstanceRegistry.ts`                                                                        | Launcher factory via `createExternalWorkflowInstance`; `appendFromFileForClient` `appendMode` routing                                                             |
| `src/ui/WebviewMessageRouter.ts`                                                                                                         | `APPEND_FILE` handler passes `appendMode`                                                                                                                         |
| `src/extension.ts`, `package.json`                                                                                                       | `ctrlyoke.queueAsSubWorkflowFromContext` command and menu entry                                                                                                   |
| `src/cli.ts`, `src/cli/CliJsonResultBuilder.ts`                                                                                          | CLI launcher factory, child progress output, `subWorkflowRuns` in JSON                                                                                            |
| `src/ui/webview-react/components/prompts/WorkflowStep.tsx`, `WorkflowStepRow.tsx`                                                        | Sub-workflow row variant, live child badge, "Open run" link                                                                                                       |
| `src/ui/webview-react/components/layout/EditorSection.tsx`, `components/editor/PromptEditor.tsx`, `store/editorStore.ts`                 | Workflow step type, editor mode, `buildSubWorkflowProperties`                                                                                                     |
| `src/ui/webview-react/hooks/useWorkflowContextMenu.tsx`, `components/workflow/WorkflowControls.tsx`, `hooks/useWorkflowFileMenuItems.ts` | "Queue workflow to run next…" / "Queue as sub-workflow…"                                                                                                          |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`                                                                            | "Started by" label on child rows                                                                                                                                  |
| `src/core/ExecutionPreviewService.ts`, `ui/webview-react/utils/executionPreview.ts`                                                      | Single-entry preview                                                                                                                                              |
| `src/completions/*`                                                                                                                      | Object kind, key filters, snippets, path completion                                                                                                               |
| `docs/` guide page                                                                                                                       | Authoring guide for sub-workflows (the reference pages are generated)                                                                                             |

---

## Tests

- **Schema:** valid in `steps`, `finalStep`, and `parallel`; rejected at the single-step root and
  with `worktree` or unknown keys.
- **Parser:** normalization of the `finalStep` and parallel-member arms; missing-file
  validation; `userInput` still rejected in groups.
- **Parallel (fake host):**
  - a three-lane fan-out joins and then advances;
  - `failFast` stops sibling children;
  - a user-stopped lane lets its siblings finish, then stops the parent, and resume reattaches it;
  - each new preflight code;
  - the once-per-group dirty check;
  - the summaries of all lanes resolve through `$step:a-b`.
- **Worktrees (real git, temp repos):**
  - a managed child of a worktree parent branches from the parent's `HEAD` and merges into the
    parent's branch;
  - `merge: true` succeeds while the parent holds its lease;
  - merge conflict reported, not failed;
  - checkpoint commit on a managed parent;
  - concurrent managed starts with a setup longer than 5 s (prerequisite bug);
  - an agent-committed lane lands (prerequisite bug).
- **Executor (Mocha, fake `SubWorkflowHost`):** each row of the D9 table; cycle detection
  (including Windows case-insensitivity); runtime linkage persisted before `done`; D6 reattach
  for each branch (completed, continue, missing directory).
- **Propagation:**
  - parent stop → child stop (no 10 s wait);
  - child stop → parent stops;
  - parent pause → child paused while the parent stays PAUSING;
  - cancel pause → forwarded;
  - pausing the child directly leaves the parent RUNNING;
  - a three-level chain for recursion.
- **Lease:**
  - a delegated request is compatible with every lease in its chain, and with siblings that
    share its delegator;
  - it is incompatible with unrelated leases;
  - a merge lease is incompatible with sibling delegates.
- **Append:** `appendMode: "subWorkflow"` on a RUNNING instance (in-memory, one step) and on a
  COMPLETED run (`appendAndContinueAtRun` with a one-element tail); inline mode unchanged.
- **CLI:** a nested run end to end with the JSON `subWorkflowRuns`.
- **UI (Vitest):** row variant, live badge lookup, the "Open run" link address, the editor mode
  toggle, and the context-menu item.

---

## Not In Scope (v1)

- **Variable passthrough** from parent to child (D11).
- **Full output piping** of a child's complete output into the parent. Only the D12 result
  summary, including the child's final response, is exposed.
- **Automatic merging at the join.** Merge-back is the child's own `merge: true` or an authored
  merge step. ctrlyoke does not add an implicit "merge all lanes" phase.
- **A global concurrency cap** across nested fan-outs (see Parallel, Width).
- **Worktree variables** (`{{worktree.branch}}`, `CTRLYOKE_WORKTREE_*`) for ordinary steps. D12
  covers the sub-workflow case; a general version is a separate plan.
- **`{{var}}` in the `workflow` path** (D11).
- **Sub-workflows as `endCondition`/`preCondition`.**
- **Cross-workspace workflow files** beyond what trusted roots already allow (D5).
- **Expanding child steps inline** in the parent view or the execution preview.
- **Depth limits.** Cycle detection is the only guard (D10).

---

## Rough Effort Estimate

| Work                                                                                                           | Days  |
| -------------------------------------------------------------------------------------------------------------- | ----- |
| Phase 0: exhaustive step-kind branching across ~50 files                                                       | 1.5–2 |
| Schema (lifecycle extraction, new defs, wiring) + types + parser                                               | 1     |
| `SubWorkflowLauncher` + executor arm + outcome mapping + cycle check                                           | 2     |
| Stop/pause forwarding (D2/D3)                                                                                  | 1     |
| Prerequisite bugs: setup outside the mutation lock; agent-commit landing                                       | 1–1.5 |
| Worktree rules D4a–e: source-checkout override, dirty check, lease chains, delegated merge                     | 2–2.5 |
| D12 result summary as step output                                                                              | 0.5–1 |
| Parallel: member acceptance, preflight branch and codes, user-cancelled lane at join, ad-hoc "alongside" entry | 2     |
| Resume reattach (D6) + manifest parent link (D7)                                                               | 1     |
| Queue-after-running: `appendMode` plumbing + entry points                                                      | 1     |
| Dashboard row, "Started by" label, editor mode, preview                                                        | 1.5–2 |
| CLI integration + completions                                                                                  | 1     |
| Tests (including real-git worktree fan-out tests)                                                              | 3–4   |

**Total: about 20–23 days.** That is up from 13–15 for the sequential-only version: parallel
members, the worktree rules that make fan-out and merge-back correct, the two prerequisite
worktree bugs, and the result summary the merge step needs.

**Suggested landing order** (each step after Phase 0 ships on its own):

1. **Phase 0**, plus the **two prerequisite worktree bugs**. These are independent of each
   other and fix real problems today, so they can run in parallel worktrees.
2. **Sequential core:** schema, types, parser, executor arm, launcher, stop/pause, cycle
   detection, D12 summary. Usable from authored YAML.
3. **Worktree rules D4a–e.** Lease chains, source-checkout override, dirty check, delegated
   merge.
4. **Parallel members:** preflight, join semantics, recovery. This is the staging-plan pattern
   end to end.
5. **D6/D7** reattach and parent link.
6. **Entry points:** queue next, run alongside.
7. **Editor and completions polish.**
