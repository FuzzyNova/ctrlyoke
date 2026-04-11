# Parallel Step Execution Within a Single Workflow

> **Last Updated:** April 10, 2026  
> **Status:** Not yet implemented — this plan has been updated to reflect the current codebase state.

## Changes Since Plan Was Written

This plan was drafted when the codebase was in an earlier state. The following changes have
been made to align with the current architecture:

- **`PromptItem` → `PromptStep`**: The type was renamed; all references updated
- **`WorkflowStep`**: Now a discriminated union of `PromptStep | ScriptStep` (uses `STEP_TYPES`)
- **`STEP_TYPES`**: Added to `DashboardConstants.ts` (`PROMPT`, `SCRIPT`) — no `PARALLEL` yet
- **`ExecutionProperties`**: Extracted shared interface for all execution properties
- **`WorkflowStateMachine`**: Extracted from `PromptQueue` — owns runtime state transitions
- **`WorkflowExecutor.execute()`**: Two-phase outer loop (queue → finalStep → repeat)
- **`IntegrationFactory.createForExecution()`**: Creates per-run isolated integrations
- **`DashboardBroadcastHub`**: Fan-out hub for output (not direct webview messaging)
- **`OutputHistoryManager`**: Handles output persistence and replay
- **`CliOutputFormatter`**: Structures CLI output for dashboard display
- **`VarSubstitutor`**: Handles `{{var}}` substitution in prompt text
- **`WorkspaceSnapshotService`**: Captures workspace state before/after steps
- **`priorContext`**: Replaced ad-hoc context injection with typed field (`"all"`, `"previous"`, `number[]`)
- **`_runtime.responseText`**: Stores AI responses for `priorContext` injection
- **Schema**: Uses `workflowStep` oneOf union (not `prompts` array)
- **No `ParallelGroup` types yet**: Not implemented — this plan describes the future state
- **Interactive terminal fully implemented**: `PtyProcessManager` + `TerminalView` +
  `TerminalInstance` support multi-tab sessions with a session rail, controller arbitration,
  and per-prompt AI CLI terminals — interactive mode for parallel steps is in scope

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

| Feature                                          | Existing                                | This Plan                    |
| ------------------------------------------------ | --------------------------------------- | ---------------------------- |
| Multiple workflows running at once               | Yes — separate `.flightpath.yaml` files | —                            |
| Multiple prompts running at once within one file | No                                      | Yes                          |
| Shared workflow context (vars, harness, model)   | No — each file is independent           | Yes                          |
| Synthesis step after parallel group completes    | Manual external orchestration           | Native                       |
| Dashboard view                                   | One tab per workflow                    | One workflow, grouped output |

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

1. **`resumeSession: true`** — parallel steps cannot share a session. Each step must be a
   fresh AI CLI invocation. Validate at parse time; emit a clear error.
2. **`sessionId` referencing another step in the same group** — same reason.
3. **Dynamic queue extension (`mcpServers: ["flightpath"]`)** — if a parallel step tries to
   append more steps to the queue mid-execution, the ordering semantics are undefined.
   Disallow at parse time.
4. **Nested `parallel` groups** — do not allow `parallel` inside `parallel`. Flat groups
   only for Phase 1.
5. **`priorContext` referencing steps within the same parallel group** — those steps haven't
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
  identified by sub-step label (e.g., "2a", "2b", "2c").
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

Currently `WorkflowOrchestrator` holds a small pool of harness instances shared across
sequential prompts. For parallel execution, each parallel step must own its own harness
instance for the duration of the group — otherwise their sessions and processes collide.

`IntegrationFactory.createForExecution()` already creates fresh, isolated harness instances
per-run (not per-workflow). The parallel group executor requests N fresh instances, uses them,
then releases them when the group completes. This is a change to how harness instances are
managed but does not change the harness classes themselves.

### PromptQueue State

`PromptQueue` currently models steps as a flat indexed array with `WorkflowStep` items
(`PromptStep | ScriptStep`). The parallel group needs representation in the state machine:

```typescript
// Flat steps array at parse time (after expansion)
// ParallelGroup is a discriminated union alongside WorkflowStep
type StepItem = WorkflowStep | ParallelGroup;

interface ParallelGroup {
  kind: "parallel";
  steps: WorkflowStep[]; // PromptStep | ScriptStep
  failFast?: boolean;    // default: true
  status: "pending" | "running" | "completed" | "failed";
  stepStatuses: Map<number, StepStatus>; // stepIndex → status
}
```

For step numbering in the dashboard (e.g., "Prompt 3/7"), the parallel group counts as a
single numbered step with sub-steps labeled "3a", "3b", "3c".

### Current Architecture Context (as of April 2026)

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
    failFast: true   # default: true — cancel remaining steps if one fails
    steps:
      - name: research-auth
        ...
```

- `failFast: true` (default): when any step fails and exhausts its retries, cancel the
  remaining running steps and fail the parallel group (fail the workflow)
- `failFast: false`: let all steps run to completion regardless, then fail the group
  (and workflow) if any failed — useful for "best effort" research where partial results
  are still useful

---

## Dashboard Display

The output section needs to show concurrent output from multiple steps without confusion.

### During execution

Parallel steps show in the output section as labeled subsections within the group:

```
▼ Parallel Group — 3 steps running...
  ┌─ research-auth ────────────────── ● running
  │  [streaming output...]
  ├─ research-db ──────────────────── ● running
  │  [streaming output...]
  └─ research-perf ────────────────── ✓ complete
     [output summary]
```

Alternatively (simpler first pass): each parallel step gets its own output slot in the
existing flat output list, separated by a group header divider. The existing output
components handle each step's output independently via `DashboardBroadcastHub`.

### In the prompts panel (PromptsPanel)

Parallel group shows as an indented cluster:

```
✓  1. setup
   ⊞ Parallel Group
   ├─ ●  2a. research-auth
   ├─ ✓  2b. research-db
   └─ ✓  2c. research-perf
✓  3. synthesize
```

### Output streaming architecture

Each parallel step's output is captured via the existing `captureOutputInit`,
`captureChunk`, `captureEvents`, and `captureCompletedOutput` callbacks in
`WorkflowExecutionContext`. The `DashboardBroadcastHub` broadcasts output tagged with
the parent group index and sub-step identifier, allowing the webview to route output to
the correct visual slot.

### Interactive terminal mode for parallel steps

The terminal infrastructure is already built and supports parallel steps out of the box:

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
`PtyProcessManager.spawnPty()`, tagged with the group index and sub-step label
(e.g., `stepName: "2a. research-auth"`, `promptNumber: 2`). The session rail displays
all parallel step terminals as tabs, and the user can switch between them to monitor
progress or interact with any step. This works identically in headless mode (no terminal
shown) and interactive mode (terminal tabs in the rail).

---

## Schema Changes

### `schemas/prompt-schema.json`

Add `ParallelGroup` as a valid item in the `steps` array alongside `WorkflowStep`:

```json
{
  "workflowStep": {
    "oneOf": [
      { "$ref": "#/$defs/promptStep" },
      { "$ref": "#/$defs/scriptStep" },
      { "$ref": "#/$defs/parallelGroup" }
    ]
  },
  "$defs": {
    "parallelGroup": {
      "type": "object",
      "required": ["parallel"],
      "additionalProperties": false,
      "properties": {
        "parallel": {
          "type": "array",
          "items": { "$ref": "#/$defs/workflowStep" },
          "minItems": 2
        },
        "failFast": {
          "type": "boolean",
          "default": true,
          "description": "Cancel remaining steps if one fails (default: true)"
        }
      }
    }
  }
}
```

**Note:** The current schema uses `workflowStep` as a `oneOf` union of `promptStep` and
`scriptStep`. Adding `parallelGroup` extends this union. The schema's `executionProperties`
definition already includes all the fields used by `PromptStep` (harness, model, agent,
skills, resumeSession, sessionId, mcpServers, hooks, endCondition, preCondition,
priorContext, additionalArgs, toolPermissions).

---

## Files Changed

| File                                                       | Change                                             |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `schemas/prompt-schema.json`                               | Add `parallelGroup` to `workflowStep` oneOf union  |
| `src/types/FlightPathTypes.ts`                             | Add `ParallelGroup` type, update `WorkflowStep` union |
| `src/types/DashboardConstants.ts`                          | Add `STEP_TYPES.PARALLEL` constant                 |
| `src/flightpath/PromptFileParser.ts`                       | Parse `parallel:` groups with validation           |
| `src/flightpath/PromptQueue.ts`                            | State machine handles `ParallelGroup` as a unit    |
| `src/flightpath/WorkflowExecutor.ts`                       | Fan-out logic for parallel groups                  |
| `src/flightpath/IntegrationFactory.ts`                     | Support creating N harness instances for a group   |
| `src/flightpath/harness/PtyProcessManager.ts`              | Tag parallel step sessions with group/sub-step IDs |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Group header dividers, parallel output routing   |
| `src/ui/webview-react/components/output/TerminalView.tsx`  | Already supports multi-tab — no changes needed   |
| `src/ui/webview-react/components/output/TerminalInstance.tsx` | Already supports multi-session — no changes needed |
| `src/ui/DashboardBroadcastHub.ts`                          | Multi-step output tagging and fan-out              |
| `src/ui/webview-react/components/prompts/PromptsPanel.tsx` | Indented cluster in prompt list                    |
| `src/ui/webview-react/store/terminalStore.ts`              | Already supports multi-session — no changes needed |
| `src/test/promptFileParser.test.ts`                        | Parallel group parsing tests                       |
| `src/test/workflowExecutor.test.ts`                        | Parallel execution + failure handling tests        |

---

## Implementation Order

### Phase 1 — Schema + Parsing + Sequential Fallback

1. **Add `ParallelGroup` to JSON schema and `FlightPathTypes.ts`**
   - Add `parallelGroup` definition to `schemas/prompt-schema.json`
   - Add `ParallelGroup` interface to `FlightPathTypes.ts`
   - Update `WorkflowStep` union to include `ParallelGroup`
   - Add `STEP_TYPES.PARALLEL` constant to `DashboardConstants.ts`

2. **Update `PromptFileParser` to parse `parallel:` groups**
   - Parse `parallel:` key in steps array into `ParallelGroup` objects
   - Validate constraints at parse time:
     - Reject `resumeSession: true` within parallel steps
     - Reject `sessionId` referencing sibling parallel steps
     - Reject nested parallel groups
     - Reject `mcpServers` containing `"flightpath"` (dynamic queue extension)
     - Reject `priorContext` referencing steps within the same group
   - Provide clear error messages for each validation failure

3. **`WorkflowExecutor` runs parallel group steps sequentially (fallback)**
   - Detect `ParallelGroup` in execution loop
   - Iterate through group steps sequentially (correct behavior, not parallel yet)
   - Track group state (all steps must complete before continuing)
   - Unblocks schema and UI work without concurrent execution complexity

4. **UI: Group display in dashboard**
   - Add group header dividers in `OutputSection.tsx`
   - Add indented cluster display in `PromptsPanel.tsx`
   - Update step numbering logic (e.g., "2a", "2b", "2c" for parallel sub-steps)
   - `DashboardBroadcastHub` tags output with group + sub-step identifiers

### Phase 2 — True Concurrent Execution

5. **`WorkflowExecutor` fans out with `Promise.allSettled`**
   - Create parallel group execution context
   - Spawn N harness instances via `IntegrationFactory.createForExecution()`
   - Each step runs on its own harness instance independently
   - Capture output via existing callback infrastructure
   - Merge results back into parent queue state when all complete

6. **`failFast` cancellation logic**
   - Monitor step failures during parallel execution
   - When `failFast: true` and a step fails: cancel remaining running steps
   - When `failFast: false`: let all steps run to completion
   - Update group status and propagate to dashboard

7. **Concurrent output display + streaming**
   - Route parallel step output to correct visual slots via `DashboardBroadcastHub`
   - Update `OutputSection.tsx` to show concurrent output clearly
   - Handle streaming chunks from multiple sources simultaneously

8. **Tests for concurrent execution**
   - Parallel group parsing and validation
   - Concurrent execution with multiple harness instances
   - Cancellation and failure handling (`failFast` modes)
   - Output routing and display
   - Edge cases: mixed prompt/script steps, all steps fail, partial completion

### Phase 3 — Polish (Optional)

9. **Context passing between parallel steps and synthesis**
   - Design `priorContext` references for parallel group results
   - e.g., `priorContext: [2, 3, 4]` to reference specific parallel step outputs
   - Or context file references: `@.flightpath/temp/parallel-results.md`

---

## Open Questions

1. **Context passing between parallel steps and the synthesis step:** How does the
   synthesis prompt reference what the parallel steps found? Today this is done via
   `priorContext` (with values like `"all"`, `"previous"`, or `[1, 3]` for specific
   prompt indices) or via `responseText` stored in `_runtime`. For parallel groups, each
   step has its own session. The synthesis step could use `priorContext: [2, 3, 4]` to
   reference specific parallel step outputs by index — worth designing when we get there.
   Alternative: write results to a temp file and reference via `@.flightpath/temp/output.md`.

2. **Headless vs interactive mode for parallel steps:** Both modes are supported. The
   terminal infrastructure (`PtyProcessManager` + `TerminalView` + `TerminalInstance`)
   already handles multiple concurrent PTY sessions with a session rail, so parallel
   steps each get their own terminal tab identified by sub-step label. No additional
   terminal work is needed for interactive mode — the existing infrastructure handles it.

3. **End condition interaction:** If all parallel steps share an end condition script
   (defined at workflow level), does it run once per step or once after the group? Answer:
   per step, matching the existing `endCondition` semantics. Each step evaluates its own
   end condition independently via `EndConditionEvaluator` in an isolated child process.

4. **Session resume after a parallel group:** Can a step after the group use
   `resumeSession: true`? No — there are N completed sessions from the group, not one.
   The step after a parallel group always starts a fresh session unless `sessionId`
   explicitly references one of the group's step IDs (e.g., `sessionId: 2` to resume
   the session from step 2 in the parallel group).

5. **Working file persistence during parallel execution:** The working file is updated
   sequentially as steps complete. If the workflow is interrupted mid-parallel-group,
   the working file records which sub-steps completed (via `_runtime.completedAt`).
   On resume, uncompleted parallel steps re-run; completed steps are skipped. This matches
   the existing per-prompt completion tracking via `markPromptCompleted()`.

6. **Resource limits for parallel execution:** Should we cap the maximum number of
   parallel steps? N parallel CLI processes consume N× the memory/CPU. A reasonable
   default limit (e.g., 10) with a warning for larger groups could prevent system
   overload. This can be a VS Code setting (`flightpath.maxParallelSteps`).

7. **`finalStep` interaction with parallel groups:** Can a parallel group appear inside
   a `finalStep` loop? No — the `finalStep` phase runs after the queue is empty and has
   special loop-back semantics if the queue is extended. **Decision:** Parallel groups
   are only allowed in the queue phase. The `finalStep` must be a single `PromptStep`
   or `ScriptStep`.
