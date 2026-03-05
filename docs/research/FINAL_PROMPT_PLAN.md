# Final Prompt (Orchestrator Gate) Plan

**Date**: March 4, 2026  
**Status**: Planning Phase  
**Related**: [QUEUE_APPEND_FEATURE.md](../QUEUE_APPEND_FEATURE.md), [prompt-schema.json](../../schemas/prompt-schema.json), [WorkflowExecutor.ts](../../src/flightpath/WorkflowExecutor.ts), [PromptsPanel.tsx](../../src/ui/webview-react/components/layout/PromptsPanel.tsx)

---

## Problem Statement

There is no first-class way to run a "cleanup and gate" prompt that always executes after the main queue completes. Users who want this today have two imperfect options:

1. **Put the cleanup at the end of the static queue.** Breaks for dynamic workflows — if earlier prompts extend the queue, new prompts append after the cleanup prompt, so it no longer runs last.

2. **Use `allowDynamicExtension` on every prompt to build a self-extending loop.** Each prompt becomes responsible for two things: doing its task _and_ deciding whether to add more work. This violates single responsibility, bloats prompts, and makes convergence harder to reason about.

The missing primitive is a prompt that is _structurally guaranteed to be last_ — it runs after every other prompt is done, always.

---

## Background: The Ralph Loop Pattern

The "Ralph Loop" (named for the Ralph Wiggum technique from Claude Code's stop hooks) is a pattern for long-running agentic work:

1. Hand the agent a goal and a persistent progress reference (e.g., a plan doc).
2. The agent does work and calls "done."
3. A stop hook intercepts the exit and asks: "Are you _actually_ done?"
4. If not, re-inject the agent with remaining context and restart.

FlightPath can implement this pattern cleanly using `finalPrompt` as the outer orchestrator. The key insight from the pattern is **separation of concerns**: inner prompts implement tasks; the outer gate evaluates completeness. Neither needs to know about the other's logic.

---

## Proposed Solution: `finalPrompt` Workflow Property

Add a `finalPrompt` property at the workflow level. It is a full `PromptItem` — every execution property available on normal prompts (`harness`, `model`, `agent`, `skills`, `resumeSession`, `sessionId`, `endCondition`, `allowDynamicExtension`) is available on `finalPrompt`.

### Use Cases

| Pattern                       | `allowDynamicExtension` | Description                                                                                                                        |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Ralph Loop / Orchestrator** | `true`                  | Reads a plan doc, decides if work is complete; if not, appends more prompts to the queue and the loop continues                    |
| **PR / Review Gate**          | `false`                 | After all implementation prompts complete, reviews changes, writes PR description, commits — no looping needed                     |
| **Cleanup & Commit**          | `false`                 | Template workflows (e.g., "Refactor Endpoints") always end with a cleanup prompt regardless of how many implementation prompts ran |
| **Notification / Reporting**  | `false`                 | Sends a Slack message, writes a summary file, or updates a tracking doc — always exactly once, at the end                          |

---

## Execution Model

### Loop Semantics

```
outer loop (bounded by existing maxQueueSize / unlimitedMode guards):
  ├── inner: while (queue.hasNext()) → execute normal prompts sequentially
  └── if finalPrompt defined:
        ├── snapshot = queue.prompts.length
        ├── execute finalPrompt (like any other prompt, all props honored)
        └── if allowDynamicExtension && queue.prompts.length > snapshot:
              → queue grew → continue outer loop
            else:
              → queue did not grow (or allowDynamicExtension=false) → COMPLETED
```

Loop termination relies on the same guards already in place for dynamic queues: `maxQueueSize` (default: 100) caps total queue growth, and `unlimitedMode` disables that cap for users who intentionally want unbounded execution. No additional loop counter is needed.

### Key Invariants

- `finalPrompt` always runs **after** all currently-queued prompts complete.
- If `allowDynamicExtension` is `false` (or not set), the queue cannot grow during `finalPrompt` and the workflow ends immediately after `finalPrompt` completes (same as if it were a normal last prompt).
- If `allowDynamicExtension` is `true` and `finalPrompt` appends prompts, the inner queue loop runs those new prompts, then `finalPrompt` runs again.
- `finalPrompt` participates in pause/stop checks the same way any prompt does.
- `finalPrompt` is NOT included in `queue.hasNext()` count — it lives outside the queue index cursor.

### Loop Index Representation

`finalPrompt` runs at a virtual step index: `prompts.length` (one past the last queue item). This sentinel index is used for:

- Dashboard output grouping (`output-step-final`)
- History storage
- Status message tracking

On subsequent loops the index stays at `prompts.length` (which may grow), always pointing "after the last real prompt."

---

## Schema Changes (`schemas/prompt-schema.json`)

Add one property to the `"Multiple Prompts"` `allOf` block (alongside `prompts`, `originalFile`, etc.):

```json
"finalPrompt": {
  "$ref": "#/definitions/promptItem",
  "description": "A prompt that always runs after all queued prompts complete. Useful for orchestrator gates (Ralph Loop pattern), cleanup-and-commit workflows, or PR review steps. If allowDynamicExtension is true and finalPrompt appends new prompts, those run first and then finalPrompt executes again. Loop termination is governed by the existing maxQueueSize setting. All normal PromptItem properties are supported."
}
```

### YAML Example — Ralph Loop Orchestrator

```yaml
harness: claude-cli
model: claude-sonnet-4.5

prompts:
  - id: analyze
    name: Analyze Codebase
    prompt: "Read docs/plan.md and implement the next incomplete task. Mark it done in the plan doc when finished."

finalPrompt:
  name: Orchestrator Gate
  prompt: |
    Read docs/plan.md. If all tasks are marked complete, output "done".
    If any tasks remain, call flightpath_append_queue with one prompt for the next task.
  allowDynamicExtension: true
  resumeSession: false
```

### YAML Example — Cleanup & Commit (No Loop)

```yaml
harness: copilot-cli

prompts:
  - prompt: "Refactor the authentication module per the spec in docs/auth-spec.md"
  - prompt: "Write unit tests for the refactored auth module"

finalPrompt:
  name: PR Prep
  prompt: |
    Review all changes with @workspace. Write a PR description to .flightpath/pr-description.md.
    Stage all changes and commit with message: "refactor: authentication module".
  allowDynamicExtension: false
```

---

## Type Changes (`src/types/FlightPathTypes.ts`)

Add one optional field to `PromptFile`:

```typescript
export interface PromptFile extends ExecutionProperties {
  prompt?: string;
  prompts?: PromptItem[];
  /** Prompt that always runs after all queued prompts complete. See FINAL_PROMPT_PLAN.md. */
  finalPrompt?: PromptItem;
}
```

No changes to `PromptItem`, `ExecutionProperties`, or `WorkingFile` — `WorkingFile extends PromptFile` so it inherits `finalPrompt` automatically and it persists in the working file.

---

## `WorkflowExecutor.ts` Changes

### `execute()` Method Restructuring

The existing `while (this.promptQueue.hasNext())` loop becomes the **inner loop**. Wrap it in an outer `do...while`:

```typescript
async execute(defaultIntegration, context): Promise<void> {
  // ... existing setup (clearPendingState, stepStatusMessages.clear, start, etc.) ...

  const finalPrompt = context.workflowFile?.finalPrompt ?? null;

  do {
    // === INNER LOOP (unchanged) ===
    while (this.promptQueue.hasNext()) {
      // ... existing prompt execution body, untouched ...
    }

    // Check if aborted/paused/stopped — don't run finalPrompt
    const statusAfterInner = this.promptQueue.getState().status;
    if (statusAfterInner !== EXECUTION_STATES.RUNNING) break;

    // No finalPrompt → normal completion
    if (!finalPrompt) break;

    // Execute finalPrompt at virtual index
    const sizeBeforeFinal = this.promptQueue.getState().prompts.length;
    const finalIndex = sizeBeforeFinal;
    await this.executeSinglePrompt(finalPrompt, finalIndex, defaultIntegration, context);

    const sizeAfterFinal = this.promptQueue.getState().prompts.length;
    if (sizeAfterFinal <= sizeBeforeFinal) break; // finalPrompt didn't extend queue → done

    // Queue grew → loop. Inner loop will execute the new prompts next.
    // Termination is governed by existing maxQueueSize / unlimitedMode guards.
    Log.info(`🔄 finalPrompt extended queue (+${sizeAfterFinal - sizeBeforeFinal} prompts).`);

  } while (true);

  // ... existing completion handling ...
}
```

### New `WorkflowContext` Field

Add to `WorkflowContext` interface:

```typescript
/** The loaded workflow file, for reading finalPrompt */
workflowFile?: PromptFile;
```

`WorkflowInstance` / `FlightPathManager` already has the parsed workflow file. Pass it through when building `WorkflowContext`.

### Extracting `executeSinglePrompt()`

The inner loop body (currently ~150 lines) should be extracted to a private `executeSinglePrompt(prompt, index, defaultIntegration, context)` method so both the inner loop and `finalPrompt` execution share the same code path without duplication. This is a beneficial refactor regardless — it makes the loop body readable.

---

## `PromptQueue` Changes

`finalPrompt` lives **outside** the queue's `prompts` array. The queue itself needs no changes — `hasNext()`, `currentIndex`, append/extend all operate on the normal prompt array as before. `finalPrompt` is purely an executor-level concept.

The virtual `finalIndex` (`prompts.length`) is only used for:

- Dashboard UI grouping (webview message payload: `stepIndex: finalIndex`)
- History storage

No `PromptQueue` API changes needed.

---

## Dashboard / Webview Changes

### Webview State (`workflowStore`)

Add to the workflow store state:

```typescript
finalPrompt: PromptItem | null; // null = no final prompt
finalPromptStatus: StepStatus | null; // null when not yet run
finalPromptLoopCount: number; // how many times the loop has triggered so far
```

These are populated via the existing `WORKFLOW_STATE_UPDATE` message (add the fields to the payload type in `WebviewMessageTypes.ts`). The loop count is informational only — it is not used as a termination condition.

### `PromptsPanel.tsx` Footer

Add a footer section below the prompt list in `PromptsPanel`. The footer is always visible (not collapsible independently — it's part of the panel). It shows the `finalPrompt` state.

#### States

**No final prompt (default):**

```
┌─ Orchestrator ─────────────────────────────────┐
│  ☐  No orchestrator prompt                      │
└─────────────────────────────────────────────────┘
```

**Final prompt set, collapsed (default when set):**

```
┌─ Orchestrator ─────────────────────────── [∨] ─┐
│  ☑  "Read docs/plan.md. If all tasks are…"      │
└─────────────────────────────────────────────────┘
```

Status icon renders same as a normal `PromptItem` status (PENDING / RUNNING / COMPLETED).

**Final prompt set, expanded:**

```
┌─ Orchestrator ─────────────────────────── [∧] ─┐
│  ☑  Orchestrator Gate             [Loop 2]       │
│  ┌─────────────────────────────────────────────┐ │
│  │ Read docs/plan.md. If all tasks are…        │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**During execution (running):**

- Status chip matches `STEP_STATUS.RUNNING` (spinner)
- Loop counter `[Loop N]` visible if `loopCount > 0` (no denominator — there is no max)

#### Interaction

- **Checkbox click**: Toggles `finalPrompt` enabled/disabled. When disabled, stores the prompt text in `editorStore` so it can be re-enabled without re-typing. Posts `MESSAGE_TYPES.UPDATE_FINAL_PROMPT` with `null` (disable) or the saved prompt object (re-enable). **Hidden in CLI watch mode (read-only).**
- **Text click**: Selects `finalPrompt` in the editor panel, same as clicking a normal prompt. Uses a sentinel `selectedPromptIndex` value (e.g., `-1`) to distinguish from queue prompts.
- **Expand/collapse toggle**: Controlled by new `uiStore.finalPromptExpanded` flag (persists across re-renders, does not persist to disk).

#### Component Structure

Create `src/ui/webview-react/components/prompts/FinalPromptFooter.tsx`:

```tsx
interface FinalPromptFooterProps {
  finalPrompt: PromptItem | null;
  status: StepStatus | null;
  loopCount: number;
  isRunning: boolean;
  isCLIManaged: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleEnabled: () => void;
  onToggleExpanded: () => void;
  onClick: () => void;
}
```

Used by `PromptsPanel` at the bottom of the flex column, above nothing (it's the last thing in the panel).

---

## Message Types (`src/types/DashboardConstants.ts`)

Add:

```typescript
// Webview → Extension
UPDATE_FINAL_PROMPT: "updateFinalPrompt",
// Payload: { finalPrompt: PromptItem | null }

// Extension → Webview (added to WORKFLOW_STATE_UPDATE payload)
// No new message type needed — piggybacks on existing state update
```

Add to `WorkflowStateUpdate` payload type in `src/types/WebviewMessageTypes.ts`:

```typescript
finalPrompt?: PromptItem | null;
finalPromptStatus?: StepStatus | null;
finalPromptLoopCount?: number;
```

---

## Editor Integration (`editorStore`)

The editor already handles normal prompt selection. Extend `editorStore` with:

```typescript
// Sentinel value: -1 means finalPrompt is selected (not a queue index)
// Existing selectedPromptIndex: number stays as-is
```

`selectPrompt(-1, finalPrompt)` opens `finalPrompt` in the editor. The editor panel detects `selectedPromptIndex === -1` and:

- Sets the title to `finalPrompt.name ?? "Orchestrator Prompt"`.
- Saves changes back to `finalPrompt` (not the prompts array) via `UPDATE_FINAL_PROMPT`.
- Shows all the same property fields as a normal prompt (harness, model, agent, end condition, `allowDynamicExtension` checkbox).

No new sentinel constant needed — `-1` is unambiguous since valid indices are always `>= 0`.

---

## Schema Validation Updates

AJV validates `finalPrompt` via the existing `promptItem` `$ref` — no extra runtime code needed.

---

## History Storage

`OutputHistoryManager` stores per-step outputs. Extend the history step format:

```typescript
interface HistoryStep {
  index: number;
  // ... existing fields ...
}

interface HistoryRun {
  steps: HistoryStep[];
  /** Output from finalPrompt executions, one entry per loop */
  finalPromptSteps?: HistoryStep[];
}
```

Each `finalPrompt` execution appends to `finalPromptSteps`. The `index` field in each is the loop count (0, 1, 2…) for display purposes.

---

## Settings (No New Settings Required)

`finalPrompt` loop termination is governed by the existing `maxQueueSize` setting (default: 100) and the `unlimitedMode` flag — no new settings needed. Users who want unbounded looping simply enable `unlimitedMode`.

---

## Implementation Order

1. **Schema + Types** — Add `finalPrompt` to `prompt-schema.json` and `FlightPathTypes.ts`. Run `npm run generate-schema` to regenerate YAML schema. Low risk.

2. **`WorkflowContext` + `WorkflowInstance`** — Add `workflowFile` to `WorkflowContext` and thread the parsed `PromptFile` through when building context. Mechanical change.

3. **`WorkflowExecutor` refactor** — Extract `executeSinglePrompt()`, then wrap inner loop in outer `do...while` with `finalPrompt` logic. This is the highest-risk step — needs careful testing with pause/stop/cancel to ensure state machine isn't confused by the virtual final index.

4. **Webview state + messages** — Extend `WorkflowStateUpdate`, `workflowStore`, and `uiStore` with the new fields.

5. **`FinalPromptFooter` component** — New component in `PromptsPanel`. Wire up checkbox toggle, expand/collapse, and editor selection.

6. **Editor panel support** — Handle `selectedPromptIndex === -1` to open `finalPrompt` in the editor, including save-back path.

7. **History integration** — Extend `OutputHistoryManager` to store `finalPromptSteps`.

8. **Tests** — Unit tests for:
   - No-loop path (`allowDynamicExtension: false` or queue doesn't grow)
   - Loop path (queue grows, outer loop re-triggers)
   - `maxQueueSize` guard prevents infinite growth as normal
   - Pause/stop during `finalPrompt` execution
   - Schema validation (valid `finalPrompt`, missing `prompt` field, etc.)
   - `WorkflowStateUpdate` includes `finalPromptStatus`

---

## Out of Scope (Future)

- **`finalPrompt` in working file resume**: On VS Code restart mid-execution, the `finalPrompt` loop count (`finalPromptLoopCount`) resets to 0 — it's informational only and doesn't affect termination.
- **Multiple final prompts**: One gate is enough. A chain of cleanup steps should be expressed as a final prompt that uses `sessionId` to resume a multi-turn conversation, or simply as static last prompts in the queue.
- **Conditional `finalPrompt`**: Users who want a conditional gate can check conditions inside the prompt itself (e.g., "if all tests pass, output 'done' and do nothing; otherwise append a fix prompt").
