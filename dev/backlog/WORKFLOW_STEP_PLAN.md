# Workflow Step Plan

## Overview

Add a first-class `type: "workflow"` step to FlightPath: a queue item that runs another
workflow file as a sub-workflow — no AI interaction of its own. The sub-workflow executes
fully (all its queue steps, its finalPrompt) before the parent workflow advances to the next
step. This is distinct from the planned `type: "script"` step: a workflow step orchestrates
an entire FlightPath workflow, not a shell command.

The webview shows only one workflow at a time. When a workflow step is active, the webview
switches to the child workflow, with a breadcrumb/back button so the user can navigate back to
the parent. Running a workflow step does not open a new panel — it replaces the current view.

---

## Use Cases

- **Reusable sub-workflows** — Extract common patterns (setup, test + fix loop, teardown)
  into separate workflow files and compose them from a parent workflow.
- **Conditional branching via composition** — Chain specialized workflows: implement → test
  → report, each in its own file.
- **Library of atomic workflows** — A team maintains a `.flightpath/workflows/` directory
  of reusable building blocks that any project workflow can reference.
- **Replacing deeply nested workarounds** — Currently a workflow can only flatten everything
  into one sequential list. Sub-workflows enable logical grouping without cramming everything
  into a single file.

---

## Schema Design

### `workflowStep` definition

```json
"workflowStep": {
  "type": "object",
  "description": "A workflow step that executes another FlightPath workflow file inline.",
  "properties": {
    "type": {
      "type": "string",
      "const": "workflow",
      "description": "Marks this step as a nested workflow execution step."
    },
    "name": {
      "type": "string",
      "description": "Optional display label for the step in the dashboard.",
      "maxLength": 100
    },
    "workflow": {
      "type": "string",
      "description": "Path to the workflow file to run. Resolved relative to workspace root or .flightpath/workflows/."
    },
    "continueOnFailure": {
      "type": "boolean",
      "description": "When true, a failed sub-workflow is shown as a warning but does NOT fail the parent workflow.",
      "default": false
    }
  },
  "required": ["type", "workflow"],
  "additionalProperties": false
}
```

### `promptItem` becomes a three-way `oneOf`

```json
"promptItem": {
  "oneOf": [
    { "$ref": "#/definitions/aiPromptItem" },
    { "$ref": "#/definitions/scriptStep" },
    { "$ref": "#/definitions/workflowStep" }
  ]
}
```

---

## Type System Changes (`src/types/FlightPathTypes.ts`)

```typescript
/** New workflow step */
export interface WorkflowStep {
  type: "workflow";
  name?: string;
  /** Path to the sub-workflow file */
  workflow: string;
  /** When true, a failed sub-workflow is a warning — parent continues regardless. */
  continueOnFailure?: boolean;
  _runtime?: PromptRuntimeMetadata; // startedAt / completedAt / status
}

/** Expanded union (alongside ScriptStep from SCRIPT_STEP_PLAN) */
export type WorkflowStepItem = PromptItem | ScriptStep | WorkflowStep;

export function isWorkflowStep(step: WorkflowStepItem): step is WorkflowStep {
  return step.type === "workflow";
}
```

`PromptFile.prompts`, `PromptFile.finalPrompt`, and `QueueState.prompts` become
`WorkflowStepItem[]` / `WorkflowStepItem` (same union expansion as `ScriptStep`).

---

## Execution Architecture

### `WorkflowExecutor` routing

```typescript
if (isWorkflowStep(step)) {
  return this.executeWorkflowStep(step, stepIndex, context);
} else if (isScriptStep(step)) {
  return this.executeScriptStep(step, stepIndex);
} else {
  return this.executeAiPrompt(step, stepIndex, context);
}
```

### `executeWorkflowStep(step, stepIndex, context)`

1. Emit `STEP_STATUS_CHANGED` → `"running"` for the parent step at `stepIndex`.
2. Resolve the sub-workflow file path (workspace-relative → `.flightpath/workflows/`-relative).
3. **Circular reference check** — traverse the parent chain (tracked in `WorkflowExecutionContext`)
   and fail immediately if the target path already appears (prevents infinite loops).
4. Parse the sub-workflow file via `PromptFileParser`.
5. Create a **child `WorkflowInstance`** via `WorkflowOrchestrator`, tagging it with:
   - `parentInstanceId: context.instanceId`
   - `parentStepIndex: stepIndex`
   - `depth: (context.depth ?? 0) + 1`
6. Notify the webview: `CHILD_WORKFLOW_STARTED` → switches the active workflow view to the child.
7. Await the child instance's execution to completion (it runs fully: queue + finalPrompt).
8. Capture child output summary into the parent step's `_runtime.childOutput` (for display in
   the parent's output panel when the user navigates back up).
9. On child success (all steps completed) → `STEP_STATUS_CHANGED` → `"completed"`, advance parent.
10. On child failure:
    - `continueOnFailure: true` → `STEP_STATUS_CHANGED` → `"completed"` with warning badge, advance.
    - `continueOnFailure: false` (default) → `STEP_STATUS_CHANGED` → `"failed"`, parent stops.
11. Notify the webview: `CHILD_WORKFLOW_COMPLETED` → webview auto-navigates back to parent.

### Depth limit

To prevent accidental infinite nesting (e.g., A → B → C → … → Z), enforce a hard depth
limit of **5 levels** (configurable via `flightpath.maxWorkflowDepth`). Attempting to exceed
it fails the step immediately with a clear error message.

### No `PropertyResolver` bypass — not applicable

Workflow steps have no AI execution properties (no harness, model, agent, etc.) and no
`endCondition`. Like script steps, `PropertyResolver.resolve()` is not called for them.
The sub-workflow file is an independent, self-contained workflow with its own execution
properties.

---

## Parent-Child Navigation in the Webview

This is the most significant new UI concept introduced by this feature.

### Navigation stack concept

The webview needs a notion of a **navigation stack** — an ordered list of workflow instance
IDs from outermost parent to currently-active child. Currently the webview tracks a single
`activeWorkflowId`. This would expand to:

```typescript
// uiStore addition
navigationStack: string[]; // [parentId, childId, grandchildId, ...]
activeWorkflowId: string;  // = navigationStack[navigationStack.length - 1]
```

When a workflow step starts, the extension pushes the child ID onto the stack. When it
completes, it pops back. The user can also manually navigate back (read-only view of parent).

### Breadcrumb bar

A breadcrumb bar renders at the top of the workflow panel when `navigationStack.length > 1`:

```
parent-workflow.flightpath.yaml  >  setup.flightpath.yaml  >  test-loop.flightpath.yaml
         ↑ clickable                       ↑ clickable               (current)
```

Clicking a parent in the breadcrumb navigates to that ancestor's view (read-only while child
is running). The user cannot edit or interact with ancestor prompts while the child is
executing.

### Auto-navigation behavior

- **Workflow step starts** → webview automatically navigates to the child workflow (same as if
  the user had manually selected it).
- **Workflow step completes** → webview automatically navigates back to the parent (to the
  step that just finished), showing a summary of the child run.
- If the user manually navigated away during child execution, auto-navigation still fires when
  the child completes (mirroring how the current dashboard handles step completion updates).

### Parent step in the list

In the parent's prompt list, the workflow step renders as:

```
[workflow icon]  Run setup workflow               Workflow
                 setup.flightpath.yaml
```

- No harness/model badge
- A "Workflow" type badge (purple or distinct color)
- Sub-workflow filename as subtitle
- While running: status spinner, "Running sub-workflow (step 2/5)" subtitle

---

## `WorkflowExecutionContext` Changes

```typescript
export interface WorkflowExecutionContext {
  // ... existing fields ...

  /** Depth of this execution context (0 = top-level, 1 = first-level child, ...) */
  depth?: number;

  /** Ordered list of workflow file paths from root to current (for circular ref detection) */
  ancestorPaths?: string[];
}
```

The orchestrator injects these when creating a child instance.

---

## Dashboard Constants Additions

```typescript
// DashboardConstants.ts
export const STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
  WORKFLOW: "workflow",
} as const;

// MESSAGE_TYPES additions
CHILD_WORKFLOW_STARTED: "CHILD_WORKFLOW_STARTED",
CHILD_WORKFLOW_COMPLETED: "CHILD_WORKFLOW_COMPLETED",

// PROMPT_PROPERTIES additions
WORKFLOW_PATH: "workflow",
CONTINUE_ON_FAILURE: "continueOnFailure", // shared with scriptStep
```

---

## YAML Authoring UX

```yaml
# parent.flightpath.yaml
harness: claude-cli

prompts:
  - name: Implement feature
    prompt: |
      Implement the feature described in #file:spec.md

  - name: Run setup
    type: workflow
    workflow: .flightpath/workflows/setup.flightpath.yaml

  - name: Run test suite
    type: workflow
    workflow: test-and-fix.flightpath.yaml
    continueOnFailure: true  # test failures are non-blocking

  - name: Ship it
    prompt: |
      Create a PR for the completed changes.
    harness: claude-cli
```

Sub-workflow as `finalPrompt`:

```yaml
prompts:
  - prompt: Implement the feature.

finalPrompt:
  type: workflow
  workflow: .flightpath/workflows/post-build-checks.flightpath.yaml
```

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Circular reference (A → B → A) | Detected via `ancestorPaths` before child runs; step fails immediately |
| Depth > limit (default 5) | Step fails with error: "Maximum workflow depth exceeded" |
| Sub-workflow file not found | Step fails with error; `continueOnFailure` applies |
| Sub-workflow schema validation error | Step fails with validation message; `continueOnFailure` applies |
| Sub-workflow step fails, `continueOnFailure: false` | Child failure → parent step fails → parent workflow stops |
| Sub-workflow step fails, `continueOnFailure: true` | Child failure → parent step shows warning badge → parent continues |
| User pauses while child is running | Child pauses (it's the active executor); parent is waiting |
| User stops while child is running | Child stops; parent marks workflow step as failed/stopped |
| Workflow step as only queue item | Works; no special handling required |
| Sub-workflow has its own `finalPrompt` | Executes normally as part of the child run |
| Variable substitution (`{{vars}}`) | Parent's resolved vars are NOT passed to child by default; child uses its own vars + CLI `--var` flags |
| `postScript` on a workflow step | Schema error — `additionalProperties: false` rejects it |

---

## File Change Summary

| File | Change |
|---|---|
| `schemas/prompt-schema.json` | Add `workflowStep` definition; `promptItem` becomes `oneOf` with three variants |
| `src/types/FlightPathTypes.ts` | Add `WorkflowStep`, expand `WorkflowStepItem` union, add `isWorkflowStep()` guard |
| `src/types/DashboardConstants.ts` | Add `WORKFLOW` to `STEP_TYPES`; add `CHILD_WORKFLOW_STARTED`, `CHILD_WORKFLOW_COMPLETED` message types |
| `src/flightpath/WorkflowExecutor.ts` | Route `isWorkflowStep` to `executeWorkflowStep()`; add `depth` and `ancestorPaths` to context |
| `src/flightpath/WorkflowOrchestrator.ts` | Add `createChildInstance()` — creates a WorkflowInstance tagged with parent metadata |
| `src/flightpath/WorkflowInstance.ts` | Add `parentInstanceId?`, `parentStepIndex?`, `depth` fields |
| `src/flightpath/PromptFileParser.ts` | Validate `workflowStep` via AJV; type narrowing after parse |
| `src/ui/webview-react/store/uiStore.ts` | Add `navigationStack: string[]`; push/pop on child workflow events |
| `src/ui/webview-react/store/workflowStore.ts` | Handle `CHILD_WORKFLOW_STARTED` / `CHILD_WORKFLOW_COMPLETED`; register child workflow state |
| `src/ui/webview-react/components/prompts/PromptItem.tsx` | Render workflow step variant (workflow icon, Workflow badge, file preview); show "Running sub-workflow (N/M)" |
| `src/ui/webview-react/components/workflow/WorkflowBreadcrumb.tsx` | New component: breadcrumb bar shown when `navigationStack.length > 1` |
| `src/ui/webview-react/components/prompts/PromptEditor.tsx` | Add `type: workflow` to Step Type selector; show workflow path field; hide all AI settings |
| `src/ui/FlightPathWebviewProvider.ts` | Handle `CHILD_WORKFLOW_STARTED` / `CHILD_WORKFLOW_COMPLETED`; pass child workflow state to webview |
| `src/completions/` | Offer `workflow` step type; suppress AI completions when `type: workflow`; offer `workflow` path field with file picker |

---

## Not In Scope (YAGNI)

- **Variable passthrough** — passing parent `vars` into child at runtime. Users can use CLI `--var` flags or set vars in the child workflow file directly.
- **Output piping** — injecting child workflow output into the next parent prompt via `priorContext`. Complex to implement; users can add an explicit AI step after the workflow step to process results.
- **Parallel workflow steps** — running multiple sub-workflows concurrently. Out of scope for v1.
- **Dynamic workflow path** — `workflow: "{{path}}"` with variable substitution. Add later when use cases emerge.
- **Workflow step in `endCondition`** — workflows are not end conditions; they are steps.
- **Cross-workspace workflows** — sub-workflow files must live in the same workspace.

---

## Complexity Assessment

### What makes this harder than `type: script`

| Area | Script Step | Workflow Step |
|---|---|---|
| Execution engine | Calls `EndConditionEvaluator` directly | Must spin up a full `WorkflowInstance` |
| State | Stateless shell command | Full queue state machine, history, output buffer |
| UI | Badge change only | Navigation stack, breadcrumb bar, new message types |
| Lifecycle | Atomic (runs once, done) | Multi-step, pauseable, resumeable |
| Orchestration | Self-contained in executor | Requires orchestrator involvement |
| Testing | Straightforward unit tests | Integration tests across parent-child boundaries |
| Edge cases | Exit code, `continueOnFailure` | Circular refs, depth limits, pause/resume inheritance, variable scoping |

The webview navigation stack is the most novel piece — it's a new UI concept that touches the
uiStore, workflowStore, the breadcrumb component, and the message protocol. The execution side
is manageable because `WorkflowInstance` and `WorkflowOrchestrator` already support multiple
independent instances.

### Rough effort estimate

- Schema + types: **0.5 days**
- `executeWorkflowStep` + orchestrator child instance creation: **2–3 days**
- Circular ref detection + depth limiting + edge case handling: **1 day**
- Webview navigation stack + breadcrumb component: **2–3 days**
- `PromptItem.tsx` workflow step rendering: **0.5 days**
- `PromptEditor.tsx` workflow step editor: **1 day**
- Completions: **0.5 days**
- Tests: **2 days**

**Total: ~10–11 days of focused work**

---

## Recommendation

**Capture the idea — but don't implement it yet.**

The concept is sound and fits naturally into the schema/type model. However, the cost/benefit
is skewed compared to `type: script`:

- **Script step solves 90% of the composition problem.** The most common use case for
  "running another workflow" is actually just running a shell gate (test, format, build) — which
  `type: script` handles cleanly.
- **The webview navigation stack is disproportionately complex.** Breadcrumb nav, auto-navigation
  on child start/complete, and read-only ancestor views are non-trivial UI work that touches
  multiple stores and the message protocol — all for a feature most users won't use initially.
- **The execution complexity is real.** Pause/resume across parent-child boundaries, variable
  scoping, and especially circular reference detection all require careful design and testing.
- **YAGNI applies.** Until users hit a concrete pain point that script steps + multi-file
  workflow loading don't solve, the overhead isn't justified.

**Implement `type: script` first.** Once that's shipped and users can compose shell commands
as steps, revisit whether workflow steps are still needed. If users start asking "can I run
another workflow as a step?", this plan is ready to go.
