# Parallel Step Execution Within a Single Workflow

## Is This Worth Building?

**Yes, with scope constraints.** The use case is real and distinct from the existing
parallel *workflows* feature. A user who has 5 independent research prompts followed by a
synthesis step should not have to split them into 6 separate workflow files and orchestrate
them externally just to get parallelism. The schema design is clean, the architecture
reuses existing infrastructure, and the complexity is manageable if we start with simple
parallel groups (not a full DAG).

---

## Distinction from Existing Parallel Workflows

| Feature | Existing | This Plan |
|---------|----------|-----------|
| Multiple workflows running at once | Yes — separate `.flightpath.yaml` files | — |
| Multiple prompts running at once within one file | No | Yes |
| Shared workflow context (vars, harness, model) | No — each file is independent | Yes |
| Synthesis step after parallel group completes | Manual external orchestration | Native |
| Dashboard view | One tab per workflow | One workflow, grouped output |

---

## Schema Design

### Option A: Nested `parallel` array (recommended)

```yaml
harness: claude-cli
model: sonnet

prompts:
  # Sequential step first
  - id: setup
    prompt: Read the codebase and summarize the architecture.

  # Parallel group: all run concurrently, next step waits for all
  - parallel:
    - id: research-auth
      prompt: Research best practices for authentication in this codebase.
    - id: research-db
      prompt: Research the database schema and suggest normalizations.
    - id: research-perf
      prompt: Profile the hot paths and identify performance bottlenecks.

  # Resumes after ALL three parallel steps complete
  - id: synthesize
    prompt: |
      Based on the research in prior steps, produce an implementation plan.
```

**Why this syntax:**
- `parallel:` is a sibling key to `id:` — clearly not a regular step
- Array under `parallel:` contains normal `PromptItem` objects — no new step-level fields
- The position in the `prompts:` array defines the execution order: everything before
  runs first, then all parallel steps run concurrently, then everything after waits
- Clean and readable — the structure of the YAML mirrors the structure of execution

### Option B: `dependsOn` / DAG (future extension)

```yaml
prompts:
  - id: research-auth
    prompt: ...
  - id: research-db
    prompt: ...
  - id: synthesize
    dependsOn: [research-auth, research-db]
    prompt: ...
```

This is more powerful (arbitrary DAG, not just flat groups) but significantly more complex
to implement and validate. Reserve for a future phase if users ask for it.

### Option C: `group` + `parallel: true` on each step

```yaml
prompts:
  - id: research-auth
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
3. **`allowDynamicExtension: true`** — if a parallel step tries to append more steps to
   the queue mid-execution, the ordering semantics are undefined. Disallow.
4. **Nested `parallel` groups** — do not allow `parallel` inside `parallel`. Flat groups
   only for Phase 1.

### What IS allowed

- Per-step harness/model overrides (each step gets its own harness instance)
- Per-step `endCondition` (each step's end condition is evaluated independently)
- Per-step `agent` and `context` references
- The step after a parallel group can use `resumeSession: false` (default) for a clean
  synthesis, or the group results can be referenced via context file references in the
  prompt text

---

## Architecture

### Execution Model

`WorkflowExecutor` currently runs a sequential loop over `PromptQueue.prompts`. With
parallel groups, the loop encounters a `ParallelGroup` and fans out:

```
WorkflowExecutor.run()
    ↓
for each item in prompts:
    if item is PromptItem → execute sequentially (existing path)
    if item is ParallelGroup:
        spawn N concurrent WorkflowExecutor sub-instances, one per step
        await Promise.all(subExecutors)
        merge results back into parent queue state
    continue with next item
```

Each sub-executor in the parallel group:
- Gets its own harness integration instance (via `IntegrationFactory`)
- Runs as a completely independent execution — its own session, its own temp files
- Reports output back to the parent workflow's output state (tagged with step ID)
- Has its own end condition evaluation

### Harness Instances

Currently `WorkflowOrchestrator` holds a small pool of harness instances shared across
sequential prompts. For parallel execution, each parallel step must own its own harness
instance for the duration of the group — otherwise their sessions and processes collide.

`IntegrationFactory` already creates harness instances on demand. The parallel group
executor requests N fresh instances, uses them, then releases them when the group completes.
This is a change to how harness instances are managed but does not change the harness
classes themselves.

### PromptQueue State

`PromptQueue` currently models steps as a flat indexed array. The parallel group needs
representation in the state machine:

```typescript
// Flat prompts array at parse time (after expansion)
// ParallelGroup is a discriminated union alongside PromptItem
type QueueItem = PromptItem | ParallelGroup;

interface ParallelGroup {
  kind: "parallel";
  steps: PromptItem[];
  status: "pending" | "running" | "completed" | "failed";
  stepStatuses: Map<string, StepStatus>;  // stepId → status
}
```

For step numbering in the dashboard (e.g., "Prompt 3/7"), the parallel group counts as a
single numbered step with sub-steps labeled "3a", "3b", "3c".

### Failure Handling

Two modes, configurable at the group level:

```yaml
- parallel:
    failFast: true   # default: true — cancel remaining steps if one fails
    steps:
      - id: research-auth
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
existing flat output list, separated by a group header divider. The existing `CliOutput`
component handles each step's output independently.

### In the minimap

The `OutputMinimap` rail shows parallel steps as a compact cluster at their position in
the scroll timeline — same height as a single step but subdivided vertically into N bands,
one per parallel step. Undo/redo actions are per-step within the group.

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

---

## Schema Changes

### `schemas/prompt-schema.json`

Add `ParallelGroup` as a valid item in the `prompts` array alongside `PromptItem`:

```json
{
  "prompts": {
    "type": "array",
    "items": {
      "oneOf": [
        { "$ref": "#/$defs/PromptItem" },
        { "$ref": "#/$defs/ParallelGroup" }
      ]
    }
  },
  "$defs": {
    "ParallelGroup": {
      "type": "object",
      "required": ["parallel"],
      "additionalProperties": false,
      "properties": {
        "parallel": {
          "type": "array",
          "items": { "$ref": "#/$defs/PromptItem" },
          "minItems": 2
        },
        "failFast": {
          "type": "boolean",
          "default": true
        }
      }
    }
  }
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `schemas/prompt-schema.json` | Add `ParallelGroup` to `prompts` items |
| `src/types/FlightPathTypes.ts` | Add `ParallelGroup` type, update `QueueItem` union |
| `src/flightpath/PromptFileParser.ts` | Parse `parallel:` array into `ParallelGroup` |
| `src/flightpath/PromptQueue.ts` | State machine handles `ParallelGroup` as a unit |
| `src/flightpath/WorkflowExecutor.ts` | Fan-out logic for parallel groups |
| `src/flightpath/IntegrationFactory.ts` | Support creating N harness instances for a group |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Group header dividers |
| `src/ui/webview-react/components/output/OutputMinimap.tsx` | Parallel group cluster display |
| `src/ui/webview-react/components/prompts/PromptsPanel.tsx` | Indented cluster in prompt list |
| `src/test/promptFileParser.test.ts` | Parallel group parsing tests |
| `src/test/workflowExecutor.test.ts` | Parallel execution + failure handling tests |

---

## Implementation Order

### Phase 1 — Schema + Parsing + Sequential Fallback

1. Add `ParallelGroup` to JSON schema and `FlightPathTypes`
2. Update `PromptFileParser` to parse `parallel:` groups with validation
   (reject `resumeSession`, `allowDynamicExtension`, nested parallel)
3. `WorkflowExecutor` runs parallel group steps **sequentially** as a fallback
   (correct behavior, just not parallel yet) — unblocks schema and UI work
4. UI: group header in output list, indented cluster in prompts panel

### Phase 2 — True Concurrent Execution

5. `WorkflowExecutor` fans out with `Promise.all`, each step on its own harness instance
6. `failFast` cancellation logic
7. Output interleaving + minimap cluster display
8. Tests for concurrent execution, cancellation, partial failure

---

## Open Questions

1. **Context passing between parallel steps and the synthesis step:** How does the
   synthesis prompt reference what the parallel steps found? Today this is done via
   `resumeSession` (same conversation) or via context file references
   (`@.flightpath/temp/output.md`). For parallel groups, each step has its own session.
   The synthesis step could use something like `@step:research-auth` as a context
   reference — worth designing when we get there.

2. **Headless vs interactive mode for parallel steps:** Headless mode is straightforward
   (N background processes). Interactive mode (xterm.js terminal) would need N terminal
   panels — the embedded terminal plan would need extending for this. Phase 1 can
   restrict parallel groups to headless-only.

3. **End condition interaction:** If all parallel steps share an end condition script
   (defined at workflow level), does it run once per step or once after the group? Answer:
   per step, matching the existing `endCondition` semantics.

4. **Session resume after a parallel group:** Can a step after the group use
   `resumeSession: true`? No — there are N completed sessions from the group, not one.
   The step after a parallel group always starts a fresh session unless `sessionId`
   explicitly references one of the group's step IDs.
