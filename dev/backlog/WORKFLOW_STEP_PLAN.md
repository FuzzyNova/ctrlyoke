# Workflow Step Plan

## Overview

Add a first-class `type: "workflow"` step (schema definition name `subWorkflowStep`, to avoid
colliding with the existing `workflowStep` oneOf wrapper in `workflow-schema.json`) to ctrlyoke:
a queue item that runs another workflow file **to completion as its own independent
instance/lineage** — with that file's own workflow-level `harness`/`worktree`/`vars`/etc. fully
respected, not flattened into the parent's queue. The parent step blocks until the child reaches
a terminal state before the parent advances.

This directly solves a gap the original design (v1, superseded by this doc) didn't cover:
queuing a workflow to run after one that's _already running_ and wasn't authored with the
sub-workflow ahead of time. Because a `subWorkflowStep` is just a step, and ctrlyoke already
supports appending steps to a running instance's queue (`WorkflowOrchestrator.appendFromFileForClient`,
`ctrlyoke.queueFromContext`), "queue workflow B to start after workflow A finishes" is just
"append a single `type: workflow` step referencing B to A's already-running queue" — no separate
"workflow queue" concept needed. ctrlyoke's queue already _is_ the composition primitive; this
plan gives it one more step type.

This version deliberately does **not** introduce a webview navigation stack, breadcrumb bar, or
auto-navigation. The child runs as an ordinary second instance and gets an ordinary dropdown
entry in `WorkflowStatus.tsx` for free (the dropdown already lists every loaded instance). The
parent step's output area shows a simple "View live output →" link once the child starts; you
click through and click back the normal way (switch workflows in the dropdown), exactly like
switching between any two unrelated running workflows today. That single change is what makes
this version much cheaper than the original plan — see Complexity Assessment.

We are pre-release with no backward-compatibility constraints; nothing here needs a compat shim.

---

## Use Cases

- **Queue a workflow to run after one you already started** — the motivating case. You kick off
  a normal top-level workflow run, then decide you want another workflow to follow it. Right-click
  the running workflow in the `WorkflowStatus` dropdown → "Queue workflow to run next" → pick a
  file. It's appended as a single `subWorkflowStep` to the running instance's queue.
- **Reusable sub-workflows authored ahead of time** — extract common patterns (setup, test + fix
  loop, teardown) into separate files and reference them from a parent workflow's `steps`.
- **Conditional branching via composition** — chain specialized workflows: implement → test →
  report, each in its own file, each keeping its own harness/model/worktree choice.
- **Library of atomic workflows** — a team maintains a `.ctrlyoke/workflows/` directory of
  reusable building blocks any project workflow can reference.
- **Chained but independently-configured runs** — workflow A uses `claude-cli` on a managed
  worktree; workflow B (queued after it, or referenced as a step) uses `copilot-cli` on a
  different named worktree. Each keeps its own settings; nothing about B is coerced into A's
  execution context.

---

## Schema Design

### `subWorkflowStep` definition

```json
"subWorkflowStep": {
  "type": "object",
  "description": "A workflow step that runs another ctrlyoke workflow file to completion as its own independent instance — its workflow-level harness/worktree/vars/etc. are respected as authored, not merged into the parent's. The parent step blocks until the child reaches a terminal state.",
  "properties": {
    "type": {
      "type": "string",
      "const": "workflow",
      "description": "Marks this step as a sub-workflow execution step."
    },
    "name": {
      "type": "string",
      "description": "Optional display label for the step in the dashboard.",
      "maxLength": 100
    },
    "enabled": {
      "type": "boolean",
      "description": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution."
    },
    "workflow": {
      "type": "string",
      "description": "Path to the sub-workflow file to run. Resolved relative to the referencing file's directory, then workspace root, then .ctrlyoke/workflows/, then .ctrlyoke/ — same order as promptStep's file-path prompt resolution."
    },
    "onFail": {
      "type": "string",
      "enum": ["continue", "stopWorkflow"],
      "default": "stopWorkflow",
      "description": "What to do when the sub-workflow ends in a failed/error terminal state. 'continue': log a warning and advance the parent queue. 'stopWorkflow': halt the parent (default). Does not apply when the child was explicitly stopped by the user — a stop always stops the parent too (see Pause/Stop Propagation)."
    },
    "_runtime": {
      "$ref": "#/definitions/subWorkflowRuntimeMetadata"
    }
  },
  "required": ["type", "workflow"],
  "additionalProperties": false
}
```

`onFail` deliberately mirrors `scriptStep.onFail` (string enum, not a boolean
`continueOnFailure`) for consistency with the rest of the schema's step-outcome vocabulary. There
is no `onPass` — a completed child always just advances the parent; "retry the whole sub-workflow"
is not a v1 concept.

### `subWorkflowRuntimeMetadata` definition

Lean, not built on `executionProperties` (no harness/model/etc. — those belong to the child file
itself, not this step):

```json
"subWorkflowRuntimeMetadata": {
  "type": "object",
  "description": "Runtime linkage to the child instance this step spawned (added automatically during execution).",
  "properties": {
    "childWorkflowKey": {
      "type": "string",
      "description": "Lineage key of the child instance, for the dashboard's 'View live output' link and for locating its history after the run."
    },
    "childRunRef": {
      "type": "string",
      "description": "Stable run reference of the child's run, once known."
    },
    "startedAt": { "type": "number" },
    "completedAt": { "type": "number" },
    "terminalStatus": {
      "type": "string",
      "enum": ["completed", "cancelled", "failed", "skipped"]
    }
  },
  "required": ["startedAt"],
  "additionalProperties": false
}
```

### `workflowStep` gains a third oneOf arm

```json
"workflowStep": {
  "allOf": [
    {
      "oneOf": [
        { "$ref": "#/definitions/promptStep" },
        { "$ref": "#/definitions/scriptStep" },
        { "$ref": "#/definitions/subWorkflowStep" }
      ]
    },
    {
      "not": { "type": "object", "required": ["worktree"] }
    }
  ]
}
```

No other schema changes are needed — `steps` and `finalStep` already resolve through
`workflowStep`, so both immediately accept the new step type.

---

## Type System Changes (`src/types/CtrlYokeTypes.ts`)

> Verify exact current names (`WorkflowStepItem`/`PromptItem`/etc.) against the file before
> implementing — this section describes the shape, not confirmed identifiers.

```typescript
export interface SubWorkflowStep {
  type: "workflow";
  name?: string;
  enabled?: boolean;
  /** Path to the sub-workflow file. */
  workflow: string;
  onFail?: "continue" | "stopWorkflow";
  _runtime?: SubWorkflowRuntimeMetadata;
}

export interface SubWorkflowRuntimeMetadata {
  childWorkflowKey?: string;
  childRunRef?: string;
  startedAt: number;
  completedAt?: number;
  terminalStatus?: "completed" | "cancelled" | "failed" | "skipped";
}

export function isSubWorkflowStep(
  step: WorkflowStepItem
): step is SubWorkflowStep {
  return step.type === "workflow";
}
```

The queue-item union (whatever it's currently called) expands to include `SubWorkflowStep`
alongside the existing prompt/script variants.

---

## Execution Architecture

### `WorkflowExecutor` routing

```typescript
if (isSubWorkflowStep(step)) {
  return this.executeSubWorkflowStep(step, stepIndex, context);
} else if (isScriptStep(step)) {
  return this.executeScriptStep(step, stepIndex);
} else {
  return this.executeAiPrompt(step, stepIndex, context);
}
```

### `executeSubWorkflowStep(step, stepIndex, context)`

1. Emit `STEP_STATUS_CHANGED` → `"running"` for the parent step at `stepIndex`.
2. Resolve the sub-workflow file path (see resolution order above); resolve to an absolute path.
3. **Circular reference check** — `context.ancestorPaths` (absolute paths of every workflow file
   currently active in this run's chain, root to here) is checked for the resolved child path.
   A match fails the step immediately with an error naming the cycle (e.g. `a.yaml → b.yaml →
a.yaml`). **No depth limit.** A non-circular chain is just N independent instances, same as N
   steps in one file — nothing about depth alone is unsafe once cycles are ruled out.
4. Parse the sub-workflow file the same way ctrlyoke parses any workflow file being started (not
   just its `steps` — the whole file, so its workflow-level `harness`/`worktree`/`vars`/etc. are
   captured intact).
5. Ask `WorkflowOrchestrator` to start it as a **new, independent `WorkflowInstance`**, tagged
   with `parentInstanceId: context.instanceId`, `parentStepIndex: stepIndex`, and
   `ancestorPaths: [...context.ancestorPaths, resolvedChildPath]`.
6. Write `childWorkflowKey` (and `childRunRef` once assigned) into the parent step's `_runtime`
   immediately — this is what lights up the "View live output" link before the child finishes.
7. While the child runs, mirror its live execution state (running/paused) onto the parent
   instance's own `executionState` (see Pause/Stop/Resume Propagation) — the parent is genuinely
   idle-blocked, and the dashboard shouldn't show it as plain "running" while it's actually
   waiting on a paused child.
8. Await the child instance reaching a terminal state.
9. Map the child's terminal state to the parent step's outcome:
   - **completed** → `STEP_STATUS_CHANGED` → `"completed"`, advance parent.
   - **failed / error** → apply `onFail`: `"continue"` marks the step completed with a warning
     badge and advances; `"stopWorkflow"` (default) marks it failed and stops the parent.
   - **cancelled (stopped)** → always marks the parent step cancelled and stops the parent
     workflow, regardless of `onFail`. A stop is a stop, not a failure outcome to negotiate.

### Pause / Stop / Resume propagation

The parent-child relationship is a strict tree (no cycles, by construction), so propagation
always terminates. Two directions, and they're not symmetric in cost:

- **Child → parent (mostly free):** because the parent is synchronously awaiting the child's
  terminal state, a user stopping the child directly (e.g. from its own dropdown entry) resolves
  that await with `cancelled`, which — per the mapping above — always cancels the parent too. No
  new plumbing beyond the existing await. Pausing the child (not a terminal state) doesn't resolve
  the await, but the parent's live-state mirror (step 7 above) reflects the pause onto the parent
  instance's own `executionState` so the dashboard is accurate; resuming the child un-mirrors it
  the same way.
- **Parent → child (needs explicit forwarding):** stopping or pausing the _parent_ instance while
  it's blocked on a `subWorkflowStep` must actively forward the same action to the active child
  instance (recursively, if the child is itself waiting on its own child). `WorkflowOrchestrator`
  needs a parent↔child registry (`instanceId → parentInstanceId`, `instanceId → activeChildInstanceId`)
  and the pause/stop/resume handlers walk downward through it in addition to acting on the
  targeted instance.

Net effect: stopping or pausing anywhere in an active parent-child chain brings the whole chain to
the same state together, whichever end you triggered it from — matching "if I'm viewing a child
and stop it, the parent should also be marked as stopped."

---

## Dashboard / Dropdown — no new navigation concept

`WorkflowStatus.tsx`'s dropdown already lists every loaded `WorkflowInstance`
(`loadedWorkflows`/`recentWorkflows`) and already supports switching the active view between them
(`handleSwitchWorkflow`, `handleSelectWorkflow` → `navigateToWorkflowAddress`). A child instance
started by a `subWorkflowStep` is an ordinary instance, so **it needs no new dropdown code** — it
shows up, gets its own running-section row, own badges, own pause/stop controls, like any other
running workflow.

The only new UI is in the parent step's own row/output area (wherever step output currently
renders, e.g. `PromptItem.tsx`):

- Icon + "Sub-workflow" badge + the referenced filename as subtitle (no harness/model badge).
- A live status badge mirrored from the child instance's current `executionState`.
- Once `_runtime.childWorkflowKey` is set: a "View live output →" link that calls the same
  address-based navigation the dropdown rows already use (`navigateToWorkflowAddress` /
  `handleSelectWorkflow`'s underlying mechanism) — switches the active view to the child. After
  completion this becomes "View run" pointing at the child's specific `childRunRef`.

No breadcrumb bar, no navigation stack, no auto-switch on start/complete. You click through, and
click back the same way you'd switch to any other workflow: reopen the dropdown and pick the
parent.

---

## Queuing a workflow after one that's already running

This is the case that motivated the whole plan and needs no new execution concept — only a new
way to _append_ a `subWorkflowStep`.

`WorkflowOrchestrator.appendFromFileForClient` (and the `ctrlyoke.queueFromContext` command it
backs) already appends to a running instance's queue at a given `QueuePosition`. Today it splices
the target file's raw `steps` in — that's the _wrong_ behavior for this feature (it drops the
target file's workflow-level properties and merges it into the running instance, exactly what the
"I don't want encapsulation loss" requirement rules out). Both mechanisms stay as-is for their
existing use case (pulling in steps to run inline, sharing the current session/worktree).

New addition: a context-menu action on a running workflow row in `WorkflowStatus.tsx`'s dropdown
— "Queue workflow to run next" — opens a file picker and, on selection, appends **one**
`{ type: "workflow", workflow: <resolved path> }` step to that instance's queue at
`position: "end"`, via the same backend append plumbing (`appendAndContinueAtRun`-style call),
just constructing a single `subWorkflowStep` object instead of spreading `parsed.steps`. Repeating
the action queues another workflow after that one, and so on — "the queue is just another
workflow" falls out for free once this step type exists.

---

## `WorkflowExecutionContext` changes

```typescript
export interface WorkflowExecutionContext {
  // ... existing fields ...

  /** Absolute paths of every workflow file active in this run's chain, root to current. Used only for circular-reference detection — there is no depth limit. */
  ancestorPaths?: string[];
}
```

## `WorkflowInstance` changes

```typescript
// parentInstanceId: set when this instance was started by a subWorkflowStep.
// activeChildInstanceId: set on the parent while a child it started is still running —
// this is what pause/stop/resume forwarding walks.
parentInstanceId?: string;
activeChildInstanceId?: string;
```

---

## Dashboard Constants Additions

```typescript
// DashboardConstants.ts
export const STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
  WORKFLOW: "workflow",
} as const;

// PROMPT_PROPERTIES additions
WORKFLOW_PATH: "workflow", // the subWorkflowStep.workflow field
// onFail already exists as a shared property name (scriptStep/preCondition/endCondition) — reuse it.
```

---

## YAML Authoring UX

```yaml
# parent.ctrlyoke.yaml
harness: claude-cli

steps:
  - name: Implement feature
    prompt: |
      Implement the feature described in #file:spec.md

  - name: Run setup
    type: workflow
    workflow: .ctrlyoke/workflows/setup.ctrlyoke.yaml

  - name: Run test suite (own harness/worktree)
    type: workflow
    workflow: test-and-fix.ctrlyoke.yaml
    onFail: continue # test failures are non-blocking

  - name: Ship it
    prompt: |
      Create a PR for the completed changes.
    harness: claude-cli
```

Sub-workflow as `finalStep`:

```yaml
steps:
  - prompt: Implement the feature.

finalStep:
  type: workflow
  workflow: .ctrlyoke/workflows/post-build-checks.ctrlyoke.yaml
```

---

## Edge Cases

| Scenario                                                   | Handling                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Circular reference (A → B → A)                             | Detected via `ancestorPaths` before child starts; step fails immediately, naming the cycle                   |
| Very deep chain, no cycle (e.g. 1000 workflows deep)       | Allowed — no depth limit. No different from a 1000-step single workflow.                                     |
| Sub-workflow file not found                                | Step fails with error; `onFail` applies                                                                      |
| Sub-workflow schema validation error                       | Step fails with validation message; `onFail` applies                                                         |
| Sub-workflow ends failed/error                             | `onFail: stopWorkflow` (default) stops parent; `onFail: continue` warns and advances                         |
| Sub-workflow explicitly stopped (by user, either level)    | Always cancels the parent too, regardless of `onFail` — propagates through the whole active chain            |
| User pauses the parent while child is running              | Forwarded down to the active child (and its active child, recursively)                                       |
| User pauses/stops the child directly while viewing it      | Stop resolves the parent's await → parent cancels. Pause mirrors onto the parent's `executionState`.         |
| Workflow step as only queue item                           | Works; no special handling required                                                                          |
| Sub-workflow has its own `finalStep`                       | Executes normally as part of the child run                                                                   |
| Variable substitution (`{{vars}}`)                         | Parent's resolved vars are NOT passed to child. Child uses its own `vars` + CLI `--var` flags                |
| `worktree` on a `subWorkflowStep`                          | Schema error — `additionalProperties: false` rejects it (worktree is workflow-level only, on the child file) |
| Queue-after-running-workflow, target already the same file | Not blocked — only an actual cycle in the active ancestor chain is rejected                                  |

---

## File Change Summary

| File                                                          | Change                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/workflow-schema.json`                                | Add `subWorkflowStep` and `subWorkflowRuntimeMetadata` definitions; `workflowStep` oneOf gains a third arm                                     |
| `src/types/CtrlYokeTypes.ts`                                  | Add `SubWorkflowStep`, `SubWorkflowRuntimeMetadata`, expand queue-item union, add `isSubWorkflowStep()` guard                                  |
| `src/types/DashboardConstants.ts`                             | Add `WORKFLOW` to `STEP_TYPES`; add `WORKFLOW_PATH` to `PROMPT_PROPERTIES`                                                                     |
| `src/core/WorkflowExecutor.ts`                                | Route `isSubWorkflowStep` to `executeSubWorkflowStep()`; add `ancestorPaths` to context; circular-ref check                                    |
| `src/core/WorkflowOrchestrator.ts`                            | Start child instances tagged with parent metadata; parent↔child registry; pause/stop/resume forwarding; await-terminal-state plumbing          |
| `src/core/WorkflowInstance.ts`                                | Add `parentInstanceId?`, `activeChildInstanceId?` fields                                                                                       |
| `src/core/PromptFileParser.ts`                                | Validate `subWorkflowStep` via AJV; type narrowing after parse                                                                                 |
| `src/ui/webview-react/components/prompts/PromptItem.tsx`      | Render sub-workflow step variant (icon, badge, filename, live-mirrored status, "View live output" link)                                        |
| `src/ui/webview-react/components/prompts/PromptEditor.tsx`    | Add `type: workflow` to Step Type selector; workflow-file field (reuse existing file-picker pattern); `onFail` control; hide AI-only settings  |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx` | Add "Queue workflow to run next" context-menu action on running workflow rows → file picker → append `subWorkflowStep`                         |
| `src/ui/CtrlYokeWebviewProvider.ts`                           | Handle the new append-subworkflow-step message                                                                                                 |
| `src/completions/`                                            | Offer `workflow` step type; suppress AI completions when `type: workflow`; offer `workflow` path field with file picker; offer `onFail` values |

---

## Not In Scope (YAGNI)

- **Variable passthrough** — passing parent `vars` into child at runtime. Users can use CLI
  `--var` flags or set vars in the child workflow file directly.
- **Output piping** — injecting child workflow output into the next parent prompt via
  `priorContext`. Users can add an explicit AI step after the sub-workflow step to process results.
- **Parallel sub-workflow steps** — running multiple sub-workflows concurrently. Out of scope
  for v1.
- **Dynamic workflow path** — `workflow: "{{path}}"` with variable substitution. `varsConfig`'s
  substitution list doesn't currently cover this field; add it later if the need shows up — the
  mechanism already exists generically.
- **Sub-workflow in `endCondition`** — sub-workflows are steps, not end conditions.
- **Cross-workspace workflows** — sub-workflow files must live in the same workspace.
- **Depth limiting** — deliberately removed from this version. Only cycles are unsafe; a long
  non-circular chain is bounded by the same nothing that bounds a long single-file queue today.

---

## Complexity Assessment

### Why this version is cheaper than the original nested-navigation design

| Area                                      | Original plan (v1)                                               | This version                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Child execution                           | New child `WorkflowInstance`, same in both versions              | Same                                                                                                    |
| Dropdown entry                            | New — child had to be represented specially                      | **Free** — child is an ordinary instance, existing dropdown code already lists it                       |
| Navigating to the child                   | New navigation stack + breadcrumb bar + auto-navigate both ways  | One "View live output" link reusing existing address-based navigation                                   |
| Depth limiting                            | New setting + enforcement                                        | **Removed** — only cycle detection is needed                                                            |
| Pause/stop while child runs               | One-directional only (parent waits; no mention of child→parent)  | Bidirectional: child→parent mostly falls out of the existing await; parent→child needs a small registry |
| Queuing after an already-running workflow | Not really solvable — the plan assumed pre-authored nesting only | Directly solvable by reusing existing append-to-running-queue plumbing with a different payload         |

### Rough effort estimate

- Schema + types: **0.5 days**
- `executeSubWorkflowStep` + orchestrator child-instance creation + await-terminal-state: **1.5–2 days**
- Circular-ref detection (no depth logic needed): **0.5 days**
- Pause/stop/resume propagation (parent→child registry + forwarding; child→parent mostly free): **1 day**
- `PromptItem.tsx` sub-workflow rendering + "View live output" link: **0.5–1 day**
- `PromptEditor.tsx` sub-workflow step editor: **1 day**
- `WorkflowStatus.tsx` "Queue workflow to run next" context-menu action + file picker + append message: **1 day**
- Completions: **0.5 days**
- Tests (circular ref, onFail branches, propagation both directions, queue-after-running): **2 days**

**Total: ~8–9 days**, versus ~10–11 for the original plan — despite this version covering a real
use case (queue-after-running) the original didn't.

---

## Recommendation

**Implement this version.** Unlike v1, this design:

- Directly solves the motivating pain point (queue a workflow after one already running) instead
  of only covering pre-authored nesting.
- Reuses existing infrastructure at every turn — the multi-instance dropdown, address-based
  navigation, and the append-to-running-queue backend path all already exist; this plan adds one
  step type and one small forwarding registry rather than a parallel UI subsystem.
- Keeps full encapsulation (each workflow's own harness/worktree/vars respected, own dropdown
  entry, own history) without paying for a navigation stack to get there.

The remaining genuinely new work — circular-ref detection and pause/stop/resume propagation
across the parent-child chain — is bounded and well-understood, not open-ended design risk.
