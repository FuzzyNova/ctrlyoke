# Parallel Step Execution Within a Single Workflow

> **Last Updated:** May 22, 2026
> **Status:** Not yet implemented — re-audited against the current codebase. Phase 1 is ready to implement. Phase 2 is ready with explicit prerequisite refactors for indexed queue completion, per-step integration ownership, and parallel-safe response parking.

## Changes Since Plan Was Written

This plan was drafted when the codebase was in an earlier state. The following changes have
been made to align with the current architecture:

- **`PromptItem` → `PromptStep`**: The type was renamed; all references updated
- **`WorkflowStep`**: Now a discriminated union of `PromptStep | ScriptStep` (uses `STEP_TYPES`)
- **`STEP_TYPES`**: Added to `DashboardConstants.ts` (`PROMPT`, `SCRIPT`) — no `PARALLEL` yet
- **`ExecutionProperties`**: Extracted shared interface for all execution properties
- **`WorkflowStateMachine`**: Extracted from `PromptQueue` — owns runtime state transitions
- **`WorkflowExecutor.execute()`**: Two-phase outer loop (queue → finalStep → repeat)
- **`IntegrationFactory.createForExecution()`**: Creates an isolated execution integration when called, but `WorkflowInstance` currently caches execution integrations by harness within a run. True same-harness parallelism must bypass or extend that cache for parallel steps.
- **`DashboardBroadcastHub`**: Fan-out hub for output (not direct webview messaging)
- **`OutputHistoryManager`**: Handles output persistence and replay
- **`CliOutputFormatter`**: Structures CLI output for dashboard display
- **`VarSubstitutor`**: Handles `{{var}}` substitution in prompt text
- **`WorkspaceSnapshotService`**: Captures workspace state before/after steps
- **`priorContext`**: Replaced ad-hoc context injection with typed field (`"all"`, `"previous"`, `number[]`)
- **`_runtime.responseText`**: Stores AI responses for `priorContext` injection
- **Schema**: Uses `workflowStep` oneOf union (not `prompts` array)
- **No `ParallelGroup` types yet**: Not implemented — this plan describes the future state
- **No `groups` metadata yet**: `PromptFile`, `WorkingFile`, `QueueState`, webview messages, and Zustand state currently carry only flat `steps` / `finalStep`.
- **Executor is current-index oriented**: `executeSinglePrompt()` accepts an explicit target index, but queue completion still calls `completeCurrentAndMoveNext()` / `skipCurrentAndMoveNext()`. True concurrency requires index-specific completion APIs so sibling steps do not race on `currentIndex`.
- **Response parking is singleton state**: `WorkflowExecutor` currently has one `pendingResponseResolver`, `pendingResponseText`, and `isWaitingForResponse`. Parallel prompts need response parking keyed by `WorkflowAttemptTarget`.
- **Interactive terminal fully implemented**: `PtyProcessManager` + `TerminalView` +
  `TerminalInstance` support multi-tab sessions with a session rail, controller arbitration,
  and per-prompt AI CLI terminals — interactive mode for parallel steps is in scope
- **Sequential kept-alive terminal policy clarified**: the webview now keeps multiple
  kept-alive AI terminals accessible when a workflow switches harnesses, while same-harness
  restart/resume replacement still reuses the harness tab. **Parallel execution must not use
  harness ID as the terminal identity**: two same-harness parallel steps are valid concurrent
  PTY sessions and must appear as separate rail tabs keyed by session/step identity.

---

## Is This Worth Building?

**Yes, with scope constraints.** The use case is real and distinct from the existing
parallel _workflows_ feature. A user who has 5 independent research prompts followed by a
synthesis step should not have to split them into 6 separate workflow files and orchestrate
them externally just to get parallelism. The schema design is clean, the architecture
reuses existing infrastructure, and the complexity is manageable if we start with simple
parallel groups (not a full DAG).

---

## Distinction from Existing Parallel Workflows

| Feature                                          | Existing                              | This Plan                    |
| ------------------------------------------------ | ------------------------------------- | ---------------------------- |
| Multiple workflows running at once               | Yes — separate `.ctrlyoke.yaml` files | —                            |
| Multiple prompts running at once within one file | No                                    | Yes                          |
| Shared workflow context (vars, harness, model)   | No — each file is independent         | Yes                          |
| Synthesis step after parallel group completes    | Manual external orchestration         | Native                       |
| Dashboard view                                   | One tab per workflow                  | One workflow, grouped output |

---

## Schema Design

### Option A: Nested `parallel` array (recommended)

```yaml
harness: claude-cli
model: sonnet

steps:
  # Sequential step first
  - name: setup
    prompt: Read the codebase and summarize the architecture.

  # Parallel group: all run concurrently, next step waits for all
  - parallel:
      - name: research-auth
        prompt: Research best practices for authentication in this codebase.
      - name: research-db
        prompt: Research the database schema and suggest normalizations.
      - name: research-perf
        prompt: Profile the hot paths and identify performance bottlenecks.

  # Resumes after ALL three parallel steps complete
  - name: synthesize
    prompt: |
      Based on the research in prior steps, produce an implementation plan.
```

**Why this syntax:**

- `parallel:` is a sibling key to `name:` — clearly not a regular step
- Array under `parallel:` contains normal `WorkflowStep` objects — no new step-level fields
- The position in the `steps:` array defines the execution order: everything before
  runs first, then all parallel steps run concurrently, then everything after waits
- Clean and readable — the structure of the YAML mirrors the structure of execution

### Option B: `dependsOn` / DAG (future extension)

```yaml
steps:
  - name: research-auth
    prompt: ...
  - name: research-db
    prompt: ...
  - name: synthesize
    dependsOn: [research-auth, research-db]
    prompt: ...
```

This is more powerful (arbitrary DAG, not just flat groups) but significantly more complex
to implement and validate. Reserve for a future phase if users ask for it.

### Option C: `group` + `parallel: true` on each step

```yaml
steps:
  - name: research-auth
    group: research
    parallel: true
    prompt: ...
```

Worse than Option A: verbose (must repeat `group` and `parallel` on each step), error-prone
(group name typos), and doesn't visually communicate the structure.

**Recommendation: Option A for Phase 1, Option B as optional Phase 2.**

---

## Constraints and Validation Rules

### What is NOT allowed within a parallel group

1. **Two or more steps resolving to the same session simultaneously.** This is the core
   constraint — harnesses either throw or produce split-brain output when two processes
   attach to the same session at once. The collision cases, validated at parse time:
   - **Multiple steps with `resumeSession: true` and no `sessionId`** — all would target the
     "most recent" session of the harness type, which is the same session. Emit a clear error
     naming the conflicting steps.
   - **Multiple steps with the same explicit `sessionId`** — same collision. Emit a clear error.
2. **Dynamic queue extension (`mcpServers: ["ctrlyoke"]`)** — if a parallel step tries to
   append more steps to the queue mid-execution, the ordering semantics are undefined.
   Disallow at parse time.
3. **Nested `parallel` groups** — do not allow `parallel` inside `parallel`. Flat groups
   only for Phase 1.
4. **`priorContext` referencing steps within the same parallel group** — those steps haven't
   completed yet, so their output is unavailable. Validate at parse time.

### What IS allowed

- Per-step harness/model overrides (each step gets its own harness instance)
- Per-step `endCondition` (each step's end condition is evaluated independently)
- Per-step `agent`, `skills`, and `context` references
- **`type: script` steps** (`STEP_TYPES.SCRIPT`) — script steps compose cleanly in parallel
  groups. They require no harness instance, so the "allocate N harness instances" logic
  simply skips them (`steps.filter(s => s.type !== STEP_TYPES.SCRIPT).length`). The
  interactive-mode terminal concern (N panels) does not apply to script steps — they output
  to the Output tab regardless. The forbidden constraints (`resumeSession`, dynamic queue)
  don't need script-specific handling since those fields don't exist on `ScriptStep`.
- Per-step `preCondition` gates (each step evaluates independently)
- Per-step `toolPermissions` overrides
- Per-step `additionalArgs` CLI flags
- **Both interactive and headless execution modes** — the terminal infrastructure
  (`PtyProcessManager`, `TerminalView`, `TerminalInstance`) already supports multiple
  concurrent PTY sessions with a session rail, controller arbitration, and per-prompt
  terminal tabs. Parallel steps each get their own terminal tab in the session rail,
  identified by their sequential step number (e.g., "2. research-auth", "3. research-db").
  This includes same-harness parallel steps: two `claude-cli` steps in the same group are
  two distinct PTY/xterm sessions, not one replaceable harness tab.
- **`resumeSession: true` with a unique `sessionId` per step** — the canonical pattern for
  continuing work from a prior parallel group:
  ```yaml
  - parallel:
      - name: research-A # → completes as step 1, session saved
      - name: research-B # → completes as step 2, session saved
  - parallel:
      - name: implement-A
        resumeSession: true
        sessionId: 1 # resumes research-A session ✅
      - name: implement-B
        resumeSession: true
        sessionId: 2 # resumes research-B session ✅ (different session)
  ```
  Each `sessionId` must be unique within the group (otherwise both steps target the same
  session simultaneously — a hard error). If a referenced session is not found at runtime,
  the existing best-effort fallback applies: start a fresh session and log a warning (same
  as sequential steps with a missing session).
- **`resumeSession: true` with no `sessionId` on a single step in a group** — allowed as
  best-effort. The step resumes the most recent session of its harness type. A parse-time
  warning is emitted if more than one step in the group does this (they'd collide). A single
  step using this pattern is unambiguous and works identically to the sequential behavior.
- The step after a parallel group can use `resumeSession: false` (default) for a clean
  synthesis, or can reference group results via `priorContext` pointing to specific step
  indices (once those steps have completed)

---

## Architecture

### Execution Model

`WorkflowExecutor` currently runs a sequential loop over `PromptQueue.steps` with a two-phase
execution model (queue phase → finalStep phase). With parallel groups, the loop encounters a
`ParallelGroup` and fans out:

```
WorkflowExecutor.execute()
    ↓
for each step in steps:
    if step is PromptStep → execute sequentially (existing path)
    if step is ScriptStep → execute sequentially (existing path)
    if step is ParallelGroup:
        spawn N concurrent sub-executions, one per step in the group
        await Promise.allSettled(sub-executions)
        merge results back into parent queue state
    continue with next step
```

Each sub-execution in the parallel group:

- Gets its own harness integration instance (via `IntegrationFactory.createForExecution()`)
- Runs as a completely independent execution — its own session, its own temp files
- Reports output back to the parent workflow's output state (tagged with step ID)
- Has its own end condition evaluation
- Uses the existing `executeSinglePrompt()` logic with minimal modification

### Harness Instances

Detector integrations are still long-lived singletons owned by `WorkflowOrchestrator`, but
execution integrations are created through `IntegrationFactory.createForExecution(harness)`.
That factory method already returns a fresh isolated integration when called. The current
`WorkflowInstance.createIntegrationForMode()` layer then caches those execution integrations
by harness ID for reuse across sequential prompts in the same run.

For true parallel execution, each parallel prompt step must own a distinct execution
integration for the duration of the group. This is especially important for same-harness
siblings: two `claude-cli` siblings cannot share the same cached `CliIntegration`, active
session, response listeners, temp files, or PTY process.

Implementation decision:

1. Keep the existing harness-keyed cache for normal sequential execution and inject-mode
   reuse.
2. Add a parallel-only acquisition path that creates a fresh integration per prompt step
   even when the harness ID matches another running sibling.
3. Track those step-owned integrations separately, keyed by execution target
   (`queue:<stepIndex>`), and dispose or preserve them at group completion using the same
   cleanup rules as the existing `executionIntegrations` map.
4. Do not change the harness classes themselves unless cancellation requires a small common
   method on `HarnessIntegration`.

### Internal Storage Model (Critical Decision)

**`steps` is flat everywhere — one representation, no translation layer.**

The `parallel:` key in YAML is syntactic sugar. The parser expands it immediately — parallel
sub-steps go directly into the flat `steps` array alongside sequential steps. Group membership
is tracked in a companion `groups` array at both the file and runtime layers.

```typescript
interface ParallelGroupRange {
  /** Inclusive flat indices of the steps in this group */
  startIndex: number;
  endIndex: number;
  failFast: boolean;
  status: ParallelGroupStatus;
}
```

Both `PromptFile` and `QueueState` gain `groups?: ParallelGroupRange[]`. No new step-level
union type is introduced — `WorkflowStep` stays `PromptStep | ScriptStep`, and `PromptFile.steps`
stays `WorkflowStep[]`.

Do **not** add `STEP_TYPES.PARALLEL`: `STEP_TYPES` is the discriminant source for persisted
`WorkflowStep` values, and `parallel` is never persisted as a step. If the string needs to be
single-sourced for parsing/schema/UI messages, add it under a property-key constant such as
`PROMPT_PROPERTIES.PARALLEL`, plus a dedicated `PARALLEL_GROUP_STATUS` constant for
`pending | running | completed | failed`.

**Why flat everywhere (and why not a two-layer nested model):**

A nested model (`PromptFile.steps: Array<WorkflowStep | ParallelGroupItem>` at the file layer,
flattened at the runtime layer) was considered and rejected because:

1. **Extra type complexity for no benefit.** `WorkflowFileStep` vs `WorkflowStep` is a
   distinction that exists only to represent nesting that we don't want at runtime anyway.
   The parser is the only place that sees the `parallel:` key — it can immediately flatten.

2. **`PromptFile` IS the working file.** Working files (`.ctrlyoke/.queue/*.json`) are
   persisted `PromptFile` instances. If `PromptFile.steps` was nested, working files would
   store nested groups, requiring an expand step on every reload. With flat + `groups`,
   the working file is already in execution-ready form.

3. **Pre-release freedom.** We're not locked in to any existing `PromptFile.steps` consumers.
   Adding `groups?` to `PromptFile` is a clean additive change.

**What changes vs what stays the same:**

| Item                                | Change                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `PromptFile`                        | Gains `groups?: ParallelGroupRange[]` — flat `steps` unchanged |
| `QueueState`                        | Gains `groups: ParallelGroupRange[]`                           |
| `WorkflowStep` union                | **No change** — stays `PromptStep \| ScriptStep`               |
| `PromptFile.steps` type             | **No change** — stays `WorkflowStep[]`                         |
| `priorContext` resolution           | **No change** — `allPrompts[i]` still returns the right step   |
| `getProgress().total`               | **No change** — step count is correct                          |
| `WorkflowAttemptTarget.stepIndex`   | **No change** — flat indices work as-is                        |
| `captureOutputInit(stepIndex, ...)` | **No change** — each step has its own flat index               |
| `PromptFileParser`                  | Flattens `parallel:` groups into `steps` + populates `groups`  |
| `PromptQueue.loadFromFile()`        | Reads `groups` from file — no expand/translate step needed     |
| `mergeDiskSteps()`                  | Operates on flat `WorkflowStep[]` — already compatible         |
| `WorkflowExecutor`                  | Detects group membership via `groups`; fans out grouped steps  |

**`PromptQueue` helpers:**

```typescript
/** Returns the ParallelGroupRange this step belongs to, or undefined if sequential */
getGroupForStep(stepIndex: number): ParallelGroupRange | undefined

/** Returns true if stepIndex is the FIRST step of a parallel group */
isGroupStart(stepIndex: number): boolean
```

---

### PromptQueue State

`PromptQueue.state` gains `groups: ParallelGroupRange[]` alongside the existing flat `steps`
array. All other `QueueState` fields (`currentIndex`, `completedIndices`, `results`, etc.)
are unchanged — they operate on flat step indices as they always have.

For step numbering (e.g., "Prompt 3/7"), each step in a parallel group gets its own sequential
integer — the same scheme as sequential steps. A workflow with 1 setup step, a 3-step parallel
group, and 1 synthesis step has steps numbered 1–5. The group boundary is communicated by
`groups` metadata and visual grouping in the UI, not the step numbers themselves.

### Current Architecture Context (as of May 2026)

The codebase has evolved significantly since this plan was first drafted:

- **`WorkflowStep`** is now a discriminated union of `PromptStep | ScriptStep` (not `PromptItem`)
- **`ScriptStep`** uses `STEP_TYPES.SCRIPT` (not `type: "script"` string literal)
- **`PromptStep`** uses `STEP_TYPES.PROMPT` (optional, defaults to "prompt")
- **`ExecutionProperties`** is the shared interface for all execution properties
- **`WorkflowRuntimeState`** is owned by `WorkflowStateMachine` (extracted from `PromptQueue`)
- **`PromptQueue`** projects `QueueState` by combining its topology fields with
  `WorkflowStateMachine.getSnapshot()`
- **`WorkflowExecutor`** has a two-phase outer loop (queue → finalStep → repeat if queue extended)
- **`DashboardBroadcastHub`** is the fan-out hub (not direct webview messaging)
- **`OutputHistoryManager`** handles output persistence and replay
- **`IntegrationFactory.createForExecution()`** creates per-run isolated integrations
- **`PropertyResolver`** handles three-tier precedence (prompt > workflow > settings)
- **`VarSubstitutor`** handles `{{var}}` substitution in prompt text
- **`EndConditionEvaluator`** runs in isolated child processes
- **`CliOutputFormatter`** structures CLI output for dashboard display
- **`WorkspaceSnapshotService`** captures workspace state before/after steps
- **`PtyProcessManager`** manages multiple concurrent PTY sessions (AI CLI + shell) with
  controller arbitration, ring buffer for reconnection, and per-session status tracking
- **`TerminalView`** renders per-workflow terminal with resizable session rail (multi-tab)
- **`TerminalInstance`** manages xterm.js terminals with controller/viewer model and frozen overlays
- **`terminalRegistry`** module-level registry keeps xterm instances alive across React unmounts
- **`terminalStore`** Zustand store tracks session list, active session, and controller state

### Failure Handling

Two modes, configurable at the group level:

```yaml
- parallel:
    - name: research-auth
      prompt: ...
    - name: research-db
      prompt: ...
  failFast: true # default: true — cancel remaining steps if one fails
```

- `failFast: true` (default): when any step fails and exhausts its retries, cancel the
  remaining running steps and fail the parallel group (fail the workflow)
- `failFast: false`: let all steps run to completion regardless, then fail the group
  (and workflow) if any failed — useful for "best effort" research where partial results
  are still useful

---

## Dashboard Display

### Prompts Panel (WorkflowStepsPanel)

The prompts panel displays parallel groups as visually distinct wrappers around their
contained steps, with a header bar showing the group label and shared properties.

#### Visual Design

```
┌─────────────────────────────────────────────────┐
│  1. setup                              ✓        │
│     Analyze the architecture...                 │
├─────────────────────────────────────────────────┤
│  ╭─ Parallel Group (3 steps) ────────────────╮  │
│  │ ⊞ failFast: on                            │  │
│  ├───────────────────────────────────────────┤  │
│  │  2. research-auth             ● running   │  │
│  │     Research authentication...            │  │
│  ├───────────────────────────────────────────┤  │
│  │  3. research-db               ✓ complete  │  │
│  │     Research database schema...           │  │
│  ├───────────────────────────────────────────┤  │
│  │  4. research-perf             pending     │  │
│  │     Profile hot paths...                  │  │
│  ╰───────────────────────────────────────────╯  │
├─────────────────────────────────────────────────┤
│  5. synthesize                       pending    │
│     Based on the research...                    │
└─────────────────────────────────────────────────┘
```

**Group wrapper design:**

- **Header bar**: Shows `⊞ Parallel Group (N steps)` on the left, with a compact `failFast`
  toggle (pill badge: "failFast: on/off") on the right
- **Rounded border container**: Subtle background color (`bg-parallel-group-bg`) with a
  left border accent (`border-l-4 border-parallel-group-accent`) to visually group steps
- **Indented sub-steps**: Each parallel step is rendered with left padding (`pl-4`) inside
  the group container, using the existing `WorkflowStepItem` component
- **Step numbering**: Sub-steps use sequential integers from the global step sequence (e.g.,
  if the group starts at step 2 and has 3 steps, they are numbered 2, 3, 4). This is fully
  compatible with the existing `priorContext` integer index system — `priorContext: [2, 3, 4]`
  on the synthesis step works with no schema or runtime changes.
- **Status icons**: Each sub-step shows its own status icon (pending, running, completed,
  failed) independently

**Drag and drop behavior:**

- **Dragging steps into/out of a parallel group**: Supported when the workflow is not
  running. Steps can be dragged:
  - **Into** a parallel group: dropped between existing sub-steps (group expands)
  - **Out of** a parallel group: dropped above/below the group (step becomes sequential)
  - **Between** parallel groups: moved from one group to another
- **Dragging the group itself**: The entire group can be dragged as a single unit to
  reorder it relative to sequential steps
- **Disabled during execution**: Drag and drop is disabled when the workflow is running
  (matching existing behavior)

**Editing the `failFast` property:**

- **Inline header toggle**: The group header shows a small clickable pill
  (`failFast: on` / `failFast: off`) that toggles the property via
  `sendMessage(MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY, ...)`
- **Tooltip**: Hovering the pill shows a tooltip explaining the behavior:
  - "failFast: on" → "Cancel remaining steps if one fails"
  - "failFast: off" → "Run all steps to completion regardless of failures"

### During execution (Output Section)

Parallel steps show in the output section as labeled subsections within the group:

```
▼ Parallel Group — 3 steps running...
  ┌─ research-auth ────────────────── ● running
  │  [streaming output...]
  ├─ research-db ──────────────────── ✓ complete
  │  [output summary]
  └─ research-perf ────────────────── ● running
     [streaming output...]
```

Alternatively (simpler first pass): each parallel step gets its own output slot in the
existing flat output list, separated by a group header divider. The existing output
components handle each step's output independently via `DashboardBroadcastHub`.

### Terminal View (TerminalView)

Parallel steps work seamlessly with the existing terminal infrastructure:

- Each parallel step spawns its own PTY session via `PtyProcessManager.spawnPty()`
- Sessions are tagged with `promptNumber` (the step's own sequential integer, e.g., 2, 3, 4)
  and `stepName` (e.g., "2. research-auth")
- The session rail shows all parallel step terminals as separate tabs
- Users can click between tabs to monitor or interact with any parallel step
- Controller arbitration works independently per session

#### Terminal identity and replacement rules

Terminal/xterm identity is **session-first**, not harness-first:

- `workflowId + sessionId` remains the hard identity for `terminalRegistry` entries and
  xterm lifetime.
- `promptNumber` / flat `stepIndex` is the user-facing identity for workflow execution
  tabs. It answers "which step does this terminal belong to?"
- `harnessId` is display metadata and a sequential cleanup hint only. It is not unique
  enough for parallel execution because multiple same-harness steps can run at once.

The webview terminal reconciliation rules should therefore be:

1. **Inject-mode reuse of the same PTY**: same `sessionId` updates metadata in place
   (`stepName`, `promptNumber`, status) and keeps the same xterm.
2. **Sequential restart for the same harness**: a new `sessionId` for the same `harnessId`
   outside a parallel group replaces the old same-harness AI tab. This preserves the
   current restart/resume behavior when inject cannot be used because the model, args,
   permissions, hooks, MCP servers, or session target changed.
3. **Sequential harness switch with kept-alive PTYs**: a new `sessionId` for a different
   `harnessId` keeps the old harness terminal accessible and adds a new rail tab.
4. **Parallel group execution**: every parallel prompt step gets its own tab keyed by
   `sessionId` and labeled by `promptNumber`/`stepName`, even if several tabs share the
   same `harnessId`. No same-harness replacement happens while the steps are part of the
   same parallel group.
5. **Script PTYs**: scripts may continue to reuse a single script terminal tab unless we
   later decide script parallelism needs per-step interactive terminals.

Implementation note: today the webview receives `TERMINAL_STARTED` with `sessionId`,
`stepName`, `kind`, `promptNumber`, and `harnessId`. To distinguish "same-harness
sequential restart" from "same-harness parallel sibling", the terminal start payload should
gain explicit execution identity such as `stepIndex` and either `parallelGroupId` or
`parallelGroupRange`. The terminal handler can then skip same-harness replacement when
`parallelGroupId` is present. If adding a group ID feels too heavy, a boolean
`isParallelStep` is sufficient for Phase 2, but `parallelGroupId` is more useful for
debugging and future UI grouping.

### Output streaming architecture

Each parallel step's output is captured via the existing `captureOutputInit`,
`captureChunk`, `captureEvents`, and `captureCompletedOutput` callbacks in
`WorkflowExecutionContext`. Output should continue to be keyed by the flat step index; the
webview can use `groups` metadata to draw group dividers and visually cluster the output.
No new output transport shape is needed unless the UI wants group-specific headings in the
message payload for convenience.

### Interactive terminal mode for parallel steps

The terminal infrastructure is already built for multiple concurrent sessions, but the
webview reconciliation rule must be updated before same-harness parallel siblings are safe:

- **`PtyProcessManager`** manages multiple concurrent PTY sessions, each with a unique ID,
  workflow ID, step name, prompt number, and harness ID. Sessions are tracked with status
  (running, completed, failed) and have a ring buffer for webview reconnection.

- **`TerminalView`** renders a per-workflow horizontal resizable panel group:
  - Left: terminal canvas (all `TerminalInstance` components mounted, only active visible)
  - Right: session rail (resizable, collapsible) showing all terminal tabs
  - AI CLI sessions shown with prompt numbers and harness icons
  - Shell sessions shown separately with restart/close controls
  - Compact mode when rail is collapsed (numbered entries)

- **`TerminalInstance`** manages a single xterm.js terminal with:
  - Controller/viewer model ("Take Control" button for multi-client arbitration)
  - Input routing only for the controller client
  - ResizeObserver syncing with PTY dimensions
  - Frozen overlay for ended sessions ("Process exited")

**For parallel steps:** Each step in a parallel group gets its own PTY session via
`PtyProcessManager.spawnPty()`, tagged with the step's sequential integer and name
(e.g., `stepName: "2. research-auth"`, `promptNumber: 2`). The session rail displays
all parallel step terminals as tabs, and the user can switch between them to monitor
progress or interact with any step. Same-harness siblings are preserved as separate tabs
only after `TERMINAL_STARTED` carries parallel-step metadata and
`terminalMessageHandlers.ts` skips the current same-harness replacement behavior for those
sessions. This works identically in headless mode (no terminal shown) and interactive mode
(terminal tabs in the rail) once that reconciliation change is in place.

---

## Schema Changes

### `schemas/workflow-schema.json`

Add a queue-only `workflowStepsItem` definition that accepts either a normal
`workflowStep` or a schema-only `parallelGroup`. Keep `finalStep` referencing
`workflowStep` so parallel groups cannot appear in final-step loops.

```json
{
  "workflowStepsItem": {
    "oneOf": [
      { "$ref": "#/definitions/workflowStep" },
      { "$ref": "#/definitions/parallelGroup" }
    ]
  },
  "parallelGroup": {
    "type": "object",
    "description": "A group of queue steps that run concurrently. The parser flattens this object into normal steps plus groups metadata.",
    "required": ["parallel"],
    "additionalProperties": false,
    "properties": {
      "parallel": {
        "type": "array",
        "description": "Steps to execute concurrently. Each item must be a prompt or script step; nested parallel groups are rejected.",
        "items": { "$ref": "#/definitions/workflowStep" },
        "minItems": 2
      },
      "failFast": {
        "type": "boolean",
        "default": true,
        "description": "When true (default), cancel remaining steps in the group if any step fails after exhausting retries. When false, run all steps to completion regardless of failures."
      }
    }
  }
}
```

**Shared properties:** The `ParallelGroup` has exactly **one** shared property: `failFast`.
All other configuration is per-step — each step in the parallel group has its own harness,
model, agent, skills, endCondition, preCondition, toolPermissions, etc. The group wrapper
is purely a concurrency control mechanism, not a shared configuration container.

**Note:** The current schema uses `definitions` (not `$defs`) and `workflowStep` as a
`oneOf` union of `promptStep` and `scriptStep`. `parallelGroup` must not be added to
`workflowStep`, because that would also allow it in `finalStep` and would imply a persisted
runtime step type that the TypeScript model deliberately does not have. Update only the
`steps[].items` reference to use `workflowStepsItem`.

---

## Files Changed

| File                                                                                       | Change                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemas/workflow-schema.json`                                                             | Add `parallelGroup` to new `workflowStepsItem` definition used in `steps` array only (not `finalStep`)                                                                                     |
| `src/types/CtrlYokeTypes.ts`                                                               | Add `ParallelGroupRange` interface; add `groups?` to `PromptFile` and `QueueState`; `WorkflowStep` and `PromptFile.steps` type **unchanged**                                               |
| `src/types/DashboardConstants.ts`                                                          | Add `PARALLEL_GROUP_STATUS` and, if needed, a property-key constant for `parallel`; do **not** add `STEP_TYPES.PARALLEL`                                                                   |
| `src/types/WebviewMessageTypes.ts`                                                         | Add `groups` to file/session/steps messages and optional terminal metadata (`stepIndex`, `parallelGroupId` or `isParallelStep`)                                                            |
| `src/core/PromptFileParser.ts`                                                             | Parse `parallel:` groups directly into flat `steps` + `groups`; validate inherited/effective constraint collisions                                                                         |
| `src/core/PromptQueue.ts`                                                                  | Store and persist `groups`; add `getGroupForStep()` / `isGroupStart()` helpers; add index-specific completion/skip/send APIs for concurrent group execution                                |
| `src/core/WorkflowExecutor.ts`                                                             | Phase 1 sequential group drain, then Phase 2 fan-out after indexed queue APIs and response parking are parallel-safe                                                                       |
| `src/core/WorkflowInstance.ts`                                                             | Add parallel-only integration acquisition/cleanup keyed by execution target instead of harness ID                                                                                          |
| `src/core/IntegrationFactory.ts`                                                           | No factory interface changes expected — `createForExecution(harness)` already creates isolated instances when called                                                                       |
| `src/core/harness/PtyProcessManager.ts`                                                    | Tag parallel step sessions with their flat step index as `promptNumber` and expose enough metadata for replay/debugging (`stepIndex`, group ID if added)                                   |
| `src/types/IDashboardSink.ts` / `src/ui/PostMessageDashboardSink.ts`                       | Thread `groups` through file selected, session restored, steps extended, reset, start-position, and reorder messages                                                                       |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx`                            | Use `groups` from `QueueState` to render parallel group wrappers                                                                                                                           |
| `src/ui/webview-react/components/prompts/ParallelGroupPanel.tsx`                           | **New component**: parallel group wrapper with header, failFast toggle, drag-and-drop                                                                                                      |
| `src/ui/webview-react/components/layout/OutputSection.tsx`                                 | Group header dividers, parallel output routing                                                                                                                                             |
| `src/ui/webview-react/hooks/terminalMessageHandlers.ts`                                    | Update `TERMINAL_STARTED` reconciliation so same-harness parallel siblings are preserved as distinct session tabs; keep same-harness replacement only for non-parallel sequential restarts |
| `src/ui/webview-react/components/output/TerminalView.tsx`                                  | Already supports multi-tab — no structural changes expected; may display group-aware labels if added                                                                                       |
| `src/ui/webview-react/components/output/TerminalInstance.tsx`                              | Already supports multi-session — no changes needed                                                                                                                                         |
| `src/ui/DashboardBroadcastHub.ts`                                                          | Broadcast output tagged with flat step index (already works — no structural changes)                                                                                                       |
| `src/ui/webview-react/components/prompts/PromptsPanel.tsx`                                 | Indented cluster in prompt list (if used separately)                                                                                                                                       |
| `src/ui/webview-react/store/workflowStore.ts`                                              | Store `groups` alongside flat `steps`; include it in undo/redo snapshots; handle step reordering across group boundaries                                                                   |
| `src/ui/webview-react/store/terminalStore.ts`                                              | Already supports multi-session; add optional `stepIndex` / `parallelGroupId` fields if terminal messages expose them                                                                       |
| `src/test/unit/PromptFileParser.test.ts`                                                   | Parallel group parsing and validation tests                                                                                                                                                |
| `src/test/unit/WorkflowExecutor.test.ts`                                                   | Sequential fallback, parallel execution, and failure handling tests                                                                                                                        |
| `src/ui/webview-react/test/components/layout/WorkflowStepsPanel.test.tsx`                  | Group rendering and drag/drop boundaries                                                                                                                                                   |
| `src/ui/webview-react/test/store/workflowStore.test.ts` / `workflowStore.temporal.test.ts` | `groups` state updates and undo/redo snapshot behavior                                                                                                                                     |

---

## Implementation Order

### Phase 1 — Schema + Parsing + Sequential Fallback

1. **Add `ParallelGroupRange` to `CtrlYokeTypes.ts` and update schema**
   - Add `ParallelGroupRange` interface to `CtrlYokeTypes.ts`:
     ```typescript
     interface ParallelGroupRange {
       startIndex: number; // inclusive flat index of first step in group
       endIndex: number; // inclusive flat index of last step in group
       failFast: boolean; // default: true
       status: ParallelGroupStatus;
     }
     ```
   - Add `groups?: ParallelGroupRange[]` to `PromptFile` and `QueueState`
   - `WorkflowStep` stays `PromptStep | ScriptStep` — **no changes to this union**
   - `PromptFile.steps` stays `WorkflowStep[]` — **no type change**
   - Add `PARALLEL_GROUP_STATUS` to `DashboardConstants.ts`; do **not** add
     `STEP_TYPES.PARALLEL` because `parallel` is not a persisted workflow-step
     discriminant
   - **Schema**: Add a `workflowStepsItem` definition (used only in the `steps` array) that
     extends `workflowStep` with `parallelGroup` as an additional oneOf option. `finalStep`
     continues referencing `workflowStep` (no parallel groups allowed there). The `parallel:`
     key is schema-only — the parser expands it; it does NOT appear in the type system.

2. **Update `PromptFileParser` to parse and flatten `parallel:` groups**
   - When `parallel:` key is encountered in the `steps` array, flatten the sub-steps directly
     into the output `steps` array and record the range in `groups`
   - Output is `PromptFile` with flat `steps: WorkflowStep[]` + populated `groups` — no
     intermediate nested type, no translate step needed at load time
   - Validate constraints at parse time:
     - Resolve effective execution properties with the same inheritance/null-disable rules
       as `PropertyResolver` where parse-time data is available (`step ?? workflow`; global
       defaults are not consulted by the parser)
     - Reject multiple prompt steps in the same group whose effective
       `resumeSession: true` and absent effective `sessionId` would all target the same
       "most recent" session
     - Reject duplicate effective `sessionId` values within the same group when
       `resumeSession` is effective true (two steps cannot resume the same session
       simultaneously)
     - Reject nested parallel groups
     - Reject effective `mcpServers` containing `"ctrlyoke"` (dynamic queue extension),
       including workflow-level inheritance unless the step explicitly sets `mcpServers: null`
     - Reject `priorContext` number arrays referencing steps within the same group
       (numbers are 1-based prompt numbers; group ranges are 0-based)
   - Provide clear error messages for each validation failure
   - `PromptQueue.loadFromFile()`: reads `groups` from the parsed `PromptFile` — no expand step
     needed. Add `getGroupForStep(i)` and `isGroupStart(i)` helpers.
   - `mergeDiskSteps()` operates on flat `WorkflowStep[]` as before — no changes needed

3. **`WorkflowExecutor` runs parallel group steps sequentially (fallback)**
   - Detect `isGroupStart(state.currentIndex)` in the execution loop
   - Get the group range via `getGroupForStep(state.currentIndex)`
   - Run all steps in `startIndex..endIndex` sequentially (correct result, not parallel yet)
   - After all group steps complete, execution continues normally at `endIndex + 1`
   - Unblocks schema and UI work without concurrent execution complexity

4. **UI: `ParallelGroupPanel` component**
   - Create new component: `src/ui/webview-react/components/prompts/ParallelGroupPanel.tsx`
   - Renders group wrapper with:
     - Header bar: `⊞ Parallel Group (N steps)` + `failFast` toggle pill
     - Rounded border container with left accent border
     - Indented sub-steps using existing `WorkflowStepItem` component
     - Sub-step numbering: sequential integers from the global step sequence (2, 3, 4…)
   - Integrate into `WorkflowStepsPanel.tsx`:
     - Detect group boundaries from `groups` metadata while rendering the flat `steps` array
     - Render `ParallelGroupPanel` wrapper for parallel groups, `SortableWorkflowStepWrapper` for sequential steps
   - Update `workflowStore.ts`:
     - Store `groups` alongside the flat `steps` array
     - Support step reordering across group boundaries
     - Update `failFast` property via message handler

5. **UI: Drag and drop for parallel groups**
   - Enable dragging steps into/out of/between parallel groups
   - Enable dragging the entire group as a unit
   - Update `dnd-kit` logic in `WorkflowStepsPanel.tsx`:
     - Group is a sortable container with nested sortable items
     - Drop zones: above/below group, between sub-steps
   - Disable drag-and-drop during workflow execution

6. **UI: Output section group display**
   - Add group header dividers in `OutputSection.tsx`
   - Continue routing output by flat step index through `DashboardBroadcastHub`
   - Use `groups` metadata in the webview to cluster sibling outputs under group dividers

### Phase 2 — True Concurrent Execution

7. **Make queue completion indexed, not current-index-only**
   - Add queue APIs for concurrent execution, for example:
     - `markStepAsSent(stepIndex)`
     - `completeStep(stepIndex, metadata?)`
     - `skipStep(stepIndex, terminalStatus?)`
     - `advanceCurrentIndexPastCompleted()` or `advanceToIndex(endIndex + 1)`
   - Keep existing `completeCurrentAndMoveNext()` and `skipCurrentAndMoveNext()` as
     sequential convenience wrappers around the indexed APIs where practical.
   - Parallel sub-steps must persist `_runtime.completedAt`, result status, retry count,
     and script output by their own flat `stepIndex`; they must not increment
     `currentIndex` individually.

8. **Make executor response parking parallel-safe**
   - Replace singleton `pendingResponseResolver`, `pendingResponseText`, and
     `isWaitingForResponse` with a map keyed by `WorkflowAttemptTarget`
     (`queue:<stepIndex>` / `final:<loopIndex>`).
   - `resumePendingResponse()` should resume all parked queue responses, or accept a target
     if the UI later needs per-step resume.
   - `isAwaitingResponse()` should return true when any target is awaiting a response.

9. **Add parallel-only integration ownership in `WorkflowInstance`**
   - Extend `WorkflowExecutionContext.getIntegrationForPrompt` with an optional execution
     identity such as `{ target, isolated: true }`, or add a separate
     `createIsolatedIntegrationForPrompt(prompt, harness, target)` callback.
   - For `isolated: true`, call `integrationFactory.createForExecution(harness)` even if
     another same-harness integration is already cached for the run.
   - Track isolated integrations by `queue:<stepIndex>` and dispose/preserve them after the
     group settles. Do not overwrite `activeIntegration` for parallel siblings.

10. **Add a parallelism limit guard**

- Add a global setting/config field for maximum parallel group size (default: 6 is a
  conservative starting point for AI CLI processes).
- Validate at parse/load time where possible and re-check at execution time so dynamically
  edited working files cannot bypass it.
- Error clearly when a group exceeds the limit, with the configured limit and group size
  in the message. Users can raise the setting if their machine and harnesses can handle it.

11. **`WorkflowExecutor` fans out with `Promise.allSettled`**

- When `isGroupStart(state.currentIndex)` is true, enter parallel fan-out mode
- Get the group range: all steps from `startIndex` to `endIndex`
- For each prompt step in the group: request an isolated integration using the new
  execution-identity path. Script steps need no harness instance.
- Run each step through an indexed execution path. Reuse `executeSinglePrompt()` only after
  it no longer mutates current-index queue state or singleton response state.
- Fan out with `Promise.allSettled(groupSteps.map(step => executeSinglePrompt(...)))`
- After settling: advance `currentIndex` past `endIndex`, merge results, persist group
  status, and update dashboard progress once
- Capture output via existing `captureOutputInit(stepIndex, ...)` callbacks — each step uses
  its own flat `stepIndex`, so the output infrastructure needs no changes

12. **`failFast` cancellation logic**

- Monitor step failures during parallel execution
- When `failFast: true` and a step fails: cancel remaining running steps through their
  owned integrations / script processes and mark them `cancelled`
- When `failFast: false`: let all steps run to completion
- Update group status and propagate to dashboard

13. **Concurrent output display + streaming**

- Route parallel step output by flat step index via `DashboardBroadcastHub`
- Update `OutputSection.tsx` to show concurrent output clearly
- Handle streaming chunks from multiple sources simultaneously

14. **Terminal integration for parallel steps**
    - Tag PTY sessions with each step's sequential integer (`promptNumber`) and name
    - Include explicit execution identity in terminal metadata (`stepIndex` plus
      `parallelGroupId`/`isParallelStep`) so webview reconciliation can tell a
      same-harness parallel sibling from a same-harness sequential restart
    - Keep xterm registry keyed by `workflowId + sessionId`; do not key by harness
    - Update `terminalMessageHandlers.ts` so same-harness replacement is disabled for
      parallel steps. Two `claude-cli` or two `copilot-cli` siblings in the same group
      must produce two rail tabs.
    - Session rail already handles multiple tabs — no structural UI changes needed

15. **Tests for concurrent execution**
    - Parallel group parsing and validation
    - Concurrent execution with multiple harness instances
    - Cancellation and failure handling (`failFast` modes)
    - Output routing and display
    - Drag-and-drop across group boundaries
    - Edge cases: mixed prompt/script steps, all steps fail, partial completion

### Phase 3 — Polish (Optional)

16. ~~**Context passing between parallel steps and synthesis**~~ — **No work needed.**
    Because steps are stored flat, `priorContext: [2, 3, 4]` on the synthesis step already
    works with zero changes to the `priorContext` resolution logic.

---

## Open Questions

1. ✅ **Context passing between parallel steps and the synthesis step:** Because parallel
   steps use sequential integers in the global step sequence (e.g., steps 2, 3, 4 for a
   3-step parallel group), the synthesis step can use `priorContext: [2, 3, 4]` with the
   existing integer-index system — no schema or runtime changes needed. The temp file
   alternative (`@.ctrlyoke/temp/output.md`) remains available if users prefer it, but
   `priorContext` integer arrays work out of the box.

2. **Headless vs interactive mode for parallel steps:** Both modes are supported. The
   terminal infrastructure (`PtyProcessManager` + `TerminalView` + `TerminalInstance`)
   already handles multiple concurrent PTY sessions with a session rail, so parallel
   steps each get their own terminal tab identified by sub-step label. No additional
   terminal layout work is needed for interactive mode. The terminal reconciliation
   logic does need a parallel-step signal so same-harness siblings are preserved instead
   of treated as sequential same-harness replacement.

3. **End condition interaction:** If all parallel steps share an end condition script
   (defined at workflow level), does it run once per step or once after the group? Answer:
   per step, matching the existing `endCondition` semantics. Each step evaluates its own
   end condition independently via `EndConditionEvaluator` in an isolated child process.

4. **Session resume within and after a parallel group:** `resumeSession: true` is allowed
   inside a parallel group as long as no two steps in the group resolve to the same session.
   The canonical safe pattern: `resumeSession: true` + a unique `sessionId` per step. A single
   step using `resumeSession: true` without a `sessionId` is best-effort (resumes most recent
   session). Multiple steps using `resumeSession: true` without `sessionId` is a parse-time
   error (they'd all target the same "most recent" session). After a parallel group,
   `resumeSession: true` without a `sessionId` resumes the last sub-step's session, which is
   deterministic but unusual — prefer explicit `sessionId`.

5. **Working file persistence during parallel execution:** The working file is updated
   sequentially as steps complete. If the workflow is interrupted mid-parallel-group,
   the working file records which sub-steps completed (via `_runtime.completedAt`).
   On resume, uncompleted parallel steps re-run; completed steps are skipped. This matches
   the existing per-prompt completion tracking model, but Phase 2 needs index-specific
   completion helpers instead of the current current-index-only `markPromptCompleted()` path.

6. ✅ **Resource limits for parallel execution:** Cap parallel prompt execution with a
   configurable maximum group size. Decision: add a global config/setting with a conservative
   default of 6 parallel steps. Validate before fan-out and fail clearly when a group exceeds
   the limit. Script-only groups are cheaper but should use the same limit in Phase 2 to keep
   behavior predictable.

7. **`finalStep` interaction with parallel groups:** Can a parallel group appear inside
   a `finalStep` loop? No — the `finalStep` phase runs after the queue is empty and has
   special loop-back semantics if the queue is extended. **Decision:** Parallel groups
   are only allowed in the queue phase. The `finalStep` must be a single `PromptStep`
   or `ScriptStep`.

---

## Readiness Assessment

### Is the plan ready to implement?

**Yes, with the following understanding (updated after implementation audit):** The internal
storage model is now decided (flat `state.steps` + companion `groups` array — see the
"Internal Storage Model" section above). Phase 1 can start immediately. Phase 2 requires the
explicit refactors listed in the implementation order: indexed queue completion, target-keyed
response parking, and isolated per-step integration acquisition for parallel prompt steps.

### Prerequisites already met

✅ / ⚠️ **Terminal infrastructure**: `PtyProcessManager` + `TerminalView` +
`TerminalInstance` support multiple concurrent PTY sessions with session rail, controller
arbitration, and per-prompt terminal tabs. The remaining work is webview reconciliation:
same-harness replacement must be disabled for sessions marked as parallel steps.

✅ **Output capture infrastructure**: `captureOutputInit`, `captureChunk`, `captureEvents`,
`captureCompletedOutput` callbacks already exist in `WorkflowExecutionContext`.
`DashboardBroadcastHub` already handles multi-source output fan-out.

✅ **State machine**: `WorkflowStateMachine` owns runtime state transitions, extracted from
`PromptQueue`. Clean separation makes adding parallel group state straightforward.

✅ / ⚠️ **Harness lifecycle**: `IntegrationFactory.createForExecution(harness)` creates an
isolated integration when called (verified in `src/core/IntegrationFactory.ts` and
`src/core/VsCodeIntegrationFactory.ts`). However, `WorkflowInstance` currently caches
execution integrations by harness ID within a run. Phase 2 must add a parallel-only path that
calls the factory once per parallel prompt step and tracks those integrations by execution
target, not by harness.

✅ **UI component patterns**: `WorkflowStepsPanel.tsx` already uses `dnd-kit` for drag-and-drop,
`SortableWorkflowStepWrapper` for sortable items, and `WorkflowStepItem` for step rendering.
The parallel group wrapper is a natural extension of these patterns.

### Features that need to be built first

**None outside this plan.** The feature can be implemented directly, but Phase 2 includes
required internal refactors before enabling real concurrent prompt execution. Phase 1 avoids
those risks by flattening and displaying groups while executing grouped steps sequentially.

### UI Design Summary

**Prompts Panel (`WorkflowStepsPanel.tsx`):**

- Parallel groups rendered as `ParallelGroupPanel` wrapper component
- Wrapper shows header bar with group label (`⊞ Parallel Group (N steps)`) and
  clickable `failFast` toggle pill
- Sub-steps indented inside wrapper, using existing `WorkflowStepItem` component
- Sub-step numbering: sequential integers from the global step sequence (not "2a/2b" suffixes
  or "2.1/2.2" notation — see step numbering decision below)
- Drag-and-drop: steps can be dragged into/out of/between groups; groups can be
  dragged as units
- Group wrapper uses `dnd-kit` nested sortable pattern (container + items)

**Output Section:**

- Parallel step output remains tagged by flat step index, matching today's output contracts
- `groups` metadata lets the webview render group header dividers and cluster sibling step output
- No transport-level group ID is required unless later UI work needs it for convenience

**Terminal View:**

- Each parallel step gets its own PTY session tagged with `promptNumber` (the step's own
  sequential integer) and `stepName` (e.g., "2. research-auth")
- Session rail shows all parallel step terminals as tabs, including multiple tabs with the
  same harness icon when a group runs same-harness siblings concurrently
- The terminal tab lifecycle is keyed by `sessionId` and labeled by step identity; `harnessId`
  is not the uniqueness key

### Key Design Decisions Made

1. **Flat-everywhere storage model.** `steps` is always a flat `WorkflowStep[]` at both the
   file and runtime layers. Group membership is a companion `groups: ParallelGroupRange[]`.
   No `WorkflowFileStep` union type, no two-layer translation. The `parallel:` key is YAML
   syntax only — the parser expands it immediately. This was chosen (over a nested model) because
   we're pre-release and can afford the cleanest design: one type, no translation, `PromptFile`
   interface barely changes, and `priorContext` / all other consumers are unaffected.

2. **ParallelGroup has exactly one shared property: `failFast`**. All other configuration
   is per-step (harness, model, agent, endCondition, etc.).

3. **Interactive mode is in scope and structurally supported**. Terminal infrastructure
   already handles multiple concurrent sessions with session rail. No layout restrictions
   needed; the terminal message/reconciliation layer must preserve same-harness parallel
   siblings before Phase 2 is enabled.

4. **Nested parallel groups are disallowed in Phase 1**. Flat groups only to keep
   complexity manageable.

5. **Dynamic queue extension (`mcpServers: ["ctrlyoke"]`) is disallowed** within
   parallel groups to avoid undefined ordering semantics.

6. **`priorContext` referencing steps within the same parallel group is disallowed**
   because those steps haven't completed yet.

7. **Parallel groups are only allowed in the queue phase**, not inside `finalStep` loops.
   The `finalStep` must be a single `PromptStep` or `ScriptStep`.

8. **Session resume in parallel groups is allowed with uniqueness enforcement.** `resumeSession: true`
   - unique `sessionId` per step is the canonical pattern. A single step with `resumeSession: true`
     and no `sessionId` is best-effort (resumes most recent harness session). The only parse-time
     error: multiple steps in the same group resolving to the same session (duplicate `sessionId`,
     or multiple steps with `resumeSession: true` and no `sessionId`).

9. **Parallel step numbering uses sequential integers, not letter suffixes or sub-indices.**
   Each step in a parallel group gets its own integer in the global step sequence (e.g.,
   a 3-step parallel group starting at position 2 produces steps 2, 3, 4). Rejected
   alternatives:
   - **"2a, 2b, 2c"**: would break `priorContext` (which expects integer indices); offers
     no benefit over visual UI grouping; unwieldy at scale (100 parallel steps → "2a"…"2cv")
   - **"2.1, 2.2, 2.3"**: same `priorContext` incompatibility; fractional indices add
     parsing complexity for no gain
     Sequential integers keep the existing `priorContext: [2, 3, 4]` syntax working on the
     synthesis step with zero changes to the schema or runtime.

10. **Terminal identity is session/step based, not harness based.** `harnessId` is useful
    for icon display and sequential restart cleanup, but it is not a unique key. Parallel
    groups can legitimately run multiple same-harness steps at the same time, so terminal
    preservation must key off `sessionId` and execution metadata (`promptNumber`/`stepIndex`,
    optionally `parallelGroupId`).

11. **Parallel execution cannot reuse current-index queue mutation.** Group siblings have
    fixed flat indices and can complete in any order. The executor must mark each target by
    index, then advance `currentIndex` past the group only after the group settles.

12. **Parallel execution cannot reuse the harness-keyed execution cache.** Sequential runs can
    keep reusing one integration per harness, but parallel prompt steps need isolated
    integrations keyed by execution target so same-harness siblings do not share process or
    listener state.

### Open Questions (resolved)

- ✅ Headless vs interactive: **Both supported** (terminal infrastructure handles it)
- ✅ Same-harness parallel terminals: **Separate tabs** keyed by session/step identity, not
  merged by harness ID, after `TERMINAL_STARTED` includes parallel-step metadata and the
  webview handler skips same-harness replacement for those sessions.
- ✅ End condition interaction: **Per step** (matches existing semantics)
- ✅ Session resume in/after group: `resumeSession: true` + unique `sessionId` per step is fully allowed (including cross-group resumption). Single step `resumeSession: true` + no sessionId is best-effort. Multiple steps without sessionId or with duplicate sessionId in same group → parse-time error. Runtime fallback (session not found → new session + warning) applies as for sequential steps.
- ✅ Working file persistence: **Per-step `_runtime.completedAt`** (matches existing tracking)
- ✅ Resource limits: **Configurable cap** with default 6 parallel steps
- ✅ `finalStep` interaction: **Groups only in queue phase** (finalStep is single step)
- ✅ Step numbering: **Sequential integers** — no letter suffixes (2a/2b) or sub-indices (2.1/2.2).
  Each parallel step occupies its own integer in the global sequence. `priorContext` arrays
  work unchanged. Visual grouping is communicated by the YAML structure and UI wrapper.

### Final Implementation Notes

1. ✅ **Context passing to synthesis step:** Because parallel steps use sequential integers
   (not "2a/2b" notation), `priorContext: [2, 3, 4]` on the synthesis step works with the
   existing system and no schema changes. Step indices in `priorContext` already match step
   numbers — no special handling needed for parallel steps.

2. ✅ **Undo/redo for parallel groups:** Store `groups` in `workflowStore` and include it in
   temporal snapshots. Undo/redo restores the flat `steps` array and `groups` metadata
   together. Individual step edits inside a group remain normal step edits; group boundary
   edits update the companion `groups` array in the same store transaction.

3. ✅ **CLI binary support:** The `ctrlyoke` CLI binary uses the same execution engine.
   Parallel groups work identically in CLI mode (headless only, no terminal). Output remains
   flat-step-index keyed; CLI text/log output should include the step number/name so concurrent
   output is attributable.

No unresolved design questions remain. The risk is implementation sequencing: do Phase 1
first, then complete the Phase 2 refactors before turning on real concurrent execution.
