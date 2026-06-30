/**
 * Tests for the undo/redo (temporal) behaviour of workflowStore.
 *
 * These cover the three bugs fixed in the STEPS_EXTENDED / PROMPT_DELETED /
 * STEP_STATUS_CHANGED handlers and verify the baseline store invariants that
 * those fixes depend on.
 *
 * Each test simulates what the message handler does — calling the same store
 * actions in the same order, with or without pause/resume — rather than
 * invoking the handler itself (which is a React hook and needs a full render
 * tree to run).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "@store/workflowStore";
import {
  clearUndoRedoRuntimeCacheForTests,
  mergeRuntimeForUndoRedo,
  rememberUndoRedoRuntime,
} from "@hooks/useUndoRedoKeyHandler";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "@root/types/DashboardConstants";
import type { PromptStep } from "@root/types/WebviewMessageTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function temporal() {
  return useWorkflowStore.temporal.getState();
}

function store() {
  return useWorkflowStore.getState();
}

function makePrompt(overrides: Partial<PromptStep> = {}): PromptStep {
  return { prompt: "hello world", ...overrides };
}

function loadWorkflow(steps: PromptStep[]) {
  store().loadWorkflow({
    fileName: "test.ctrlyoke.yaml",
    workflowName: "Test",
    steps,
  });
}

// ---------------------------------------------------------------------------
// Reset store state between every test — Zustand stores are module singletons.
// ---------------------------------------------------------------------------
beforeEach(() => {
  store().resetWorkflow();
  // resetWorkflow calls t.clear() internally, but be explicit.
  temporal().clear();
  clearUndoRedoRuntimeCacheForTests();
});

// ---------------------------------------------------------------------------
// Baseline: loadWorkflow clears history
// ---------------------------------------------------------------------------
describe("loadWorkflow", () => {
  it("clears undo history when a workflow is loaded", () => {
    // Create some history first
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { prompt: "edited" });
    expect(temporal().pastStates).toHaveLength(1);

    // Loading a new workflow must wipe the slate
    loadWorkflow([makePrompt({ prompt: "fresh" })]);
    expect(temporal().pastStates).toHaveLength(0);
    expect(temporal().futureStates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tracked actions — should create undo entries
// ---------------------------------------------------------------------------
describe("tracked store actions (should record undo entries)", () => {
  it("updatePrompt records an undo entry", () => {
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { prompt: "edited text" });
    expect(temporal().pastStates).toHaveLength(1);
  });

  it("setWorkflowName records an undo entry", () => {
    loadWorkflow([makePrompt()]);
    store().setWorkflowName("New Name");
    expect(temporal().pastStates).toHaveLength(1);
  });

  it("setFinalStep records an undo entry (direct call — not via STEPS_EXTENDED)", () => {
    loadWorkflow([makePrompt()]);
    store().setFinalStep(makePrompt({ prompt: "final step" }));
    expect(temporal().pastStates).toHaveLength(1);
  });

  it("setPrompts records an undo entry when called without pausing", () => {
    loadWorkflow([makePrompt()]);
    store().setPrompts([makePrompt(), makePrompt({ prompt: "second" })]);
    expect(temporal().pastStates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Untracked actions — must NOT pollute the undo stack
// ---------------------------------------------------------------------------
describe("untracked store actions (must not record undo entries)", () => {
  it("setExecutionState does not record", () => {
    loadWorkflow([makePrompt()]);
    store().setExecutionState(EXECUTION_STATES.RUNNING);
    expect(temporal().pastStates).toHaveLength(0);
  });

  it("setCurrentStep does not record", () => {
    loadWorkflow([makePrompt()]);
    store().setCurrentStep(1);
    expect(temporal().pastStates).toHaveLength(0);
  });

  it("setTotalSteps does not record", () => {
    loadWorkflow([makePrompt()]);
    store().setTotalSteps(5);
    expect(temporal().pastStates).toHaveLength(0);
  });

  it("setStepStatus does not record", () => {
    loadWorkflow([makePrompt()]);
    store().setStepStatus(0, STEP_STATUS.RUNNING);
    expect(temporal().pastStates).toHaveLength(0);
  });

  it("appendLiveEntry does not record", () => {
    loadWorkflow([makePrompt()]);
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: {
        prompt: "p",
        response: "r",
        elapsed: 0,
        timestampMs: Date.now(),
        isStreaming: false,
      },
      timestampMs: Date.now(),
      sequence: 1,
    });
    expect(temporal().pastStates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// STEP_STATUS_CHANGED handler simulation
// Bug: updatePrompt was called without pause, polluting the undo stack during
// workflow execution.
// Fix: handler now wraps updatePrompt with pause/resume.
// ---------------------------------------------------------------------------
describe("STEP_STATUS_CHANGED handler simulation", () => {
  it("does not add undo entries when updatePrompt is paused (as fixed handler does)", () => {
    loadWorkflow([makePrompt(), makePrompt({ prompt: "second" })]);

    // Simulate EXECUTION_STARTED pause pattern
    temporal().pause();
    store().setPrompts(
      store().steps.map((p) => ({ ...p, status: STEP_STATUS.PENDING }))
    );
    temporal().resume();

    // Simulate STEP_STATUS_CHANGED with pause/resume (the fix)
    temporal().pause();
    store().updatePrompt(0, { status: STEP_STATUS.RUNNING });
    temporal().resume();

    temporal().pause();
    store().updatePrompt(0, { status: STEP_STATUS.COMPLETED });
    temporal().resume();

    expect(temporal().pastStates).toHaveLength(0);
  });

  it("equality guard: runtime-only changes do not pollute the stack even without pause", () => {
    loadWorkflow([makePrompt(), makePrompt({ prompt: "second" })]);

    // Without pause — previously this would add 2 spurious undo entries.
    // The zundo equality guard now considers states equal when only _runtime/status
    // differ, so no snapshots are created regardless of pause.
    store().updatePrompt(0, { status: STEP_STATUS.RUNNING });
    store().updatePrompt(0, { status: STEP_STATUS.COMPLETED });

    expect(temporal().pastStates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// STEPS_EXTENDED handler simulation
// Bug: double-fired notification + setFinalStep both created undo entries,
// resulting in 4 entries for a single user add action.
// Fix: pause around re-syncs and setFinalStep calls.
// ---------------------------------------------------------------------------
describe("STEPS_EXTENDED handler simulation", () => {
  it("add prompt: records exactly 1 entry for a count increase", () => {
    loadWorkflow([makePrompt()]);

    // Simulate STEPS_EXTENDED count increase (shouldRecord = true → no pause)
    store().setPrompts([makePrompt(), makePrompt({ prompt: "new prompt" })]);

    // setFinalStep is always paused in the handler
    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    expect(temporal().pastStates).toHaveLength(1);
  });

  it("re-sync: records 0 entries when count and content are identical", () => {
    const steps = [makePrompt(), makePrompt({ prompt: "second" })];
    loadWorkflow(steps);

    // Simulate second STEPS_EXTENDED with same prompts (shouldRecord = false)
    temporal().pause();
    store().setPrompts([...steps]);
    temporal().resume();

    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    expect(temporal().pastStates).toHaveLength(0);
  });

  it("edit prompt text: records 1 entry when count is same but text differs", () => {
    loadWorkflow([makePrompt()]);

    // Simulate STEPS_EXTENDED from UPDATE_PROMPT response (shouldRecord = true)
    store().setPrompts([makePrompt({ prompt: "edited text" })]);

    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    expect(temporal().pastStates).toHaveLength(1);
    expect((temporal().pastStates[0]?.steps?.[0] as any)?.prompt).toBe(
      "hello world"
    );
  });

  it("four-undo bug is gone: adding one prompt leaves exactly 1 past state", () => {
    loadWorkflow([makePrompt()]);

    // First STEPS_EXTENDED — count increased (recorded)
    store().setPrompts([makePrompt(), makePrompt({ prompt: "added" })]);
    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    // Second STEPS_EXTENDED — same content re-sync (suppressed)
    temporal().pause();
    store().setPrompts([makePrompt(), makePrompt({ prompt: "added" })]);
    temporal().resume();
    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    expect(temporal().pastStates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PROMPT_DELETED handler simulation
// Bug: setPrompts + setFinalStep both unpaused → 2 undo entries per delete.
// Fix: setFinalStep paused in handler.
// ---------------------------------------------------------------------------
describe("PROMPT_DELETED handler simulation", () => {
  it("records exactly 1 entry when a prompt is deleted", () => {
    loadWorkflow([makePrompt(), makePrompt({ prompt: "second" })]);

    // setPrompts (unpaused — this IS the undo entry for the delete)
    store().setPrompts([makePrompt()]);

    // setFinalStep (paused — fix: not a second undo entry)
    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    expect(temporal().pastStates).toHaveLength(1);
  });

  it("undo after delete restores the deleted prompt", () => {
    loadWorkflow([makePrompt(), makePrompt({ prompt: "second" })]);

    store().setPrompts([makePrompt()]);
    temporal().pause();
    store().setFinalStep(null);
    temporal().resume();

    temporal().undo();

    expect(store().steps).toHaveLength(2);
    expect((store().steps[1] as any).prompt).toBe("second");
  });

  it("undo after deleting a completed prompt restores its runtime", () => {
    loadWorkflow([
      makePrompt({ _runtime: { sessionId: "s1", completedAt: 100 } as any }),
      makePrompt({
        prompt: "second",
        status: STEP_STATUS.COMPLETED,
        _runtime: { sessionId: "s2", startedAt: 100, completedAt: 200 } as any,
      }),
    ]);

    rememberUndoRedoRuntime(store().steps);
    store().setPrompts([store().steps[0]]);

    const beforeUndo = store().steps;
    temporal().undo();
    const undoMerged = mergeRuntimeForUndoRedo(store().steps, beforeUndo);
    temporal().pause();
    store().setPrompts(undoMerged);
    temporal().resume();

    expect(store().steps).toHaveLength(2);
    expect((store().steps[1] as any)._runtime?.sessionId).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// Undo/redo round-trips
// ---------------------------------------------------------------------------
describe("undo/redo round-trips", () => {
  it("undo restores previous prompts state", () => {
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { prompt: "edited" });

    temporal().undo();

    expect((store().steps[0] as any).prompt).toBe("hello world");
    expect(temporal().futureStates).toHaveLength(1);
  });

  it("redo re-applies the undone change", () => {
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { prompt: "edited" });
    temporal().undo();
    temporal().redo();

    expect((store().steps[0] as any).prompt).toBe("edited");
    expect(temporal().futureStates).toHaveLength(0);
  });

  it("new change after undo clears the redo stack", () => {
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { prompt: "v2" });
    store().updatePrompt(0, { prompt: "v3" });

    temporal().undo(); // back to v2
    expect(temporal().futureStates).toHaveLength(1);

    store().updatePrompt(0, { prompt: "branch" }); // new change
    expect(temporal().futureStates).toHaveLength(0);
  });

  it("partial undo tracks correct prompt text at each step", () => {
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { prompt: "v2" });
    store().updatePrompt(0, { prompt: "v3" });

    temporal().undo();
    expect((store().steps[0] as any).prompt).toBe("v2");

    temporal().undo();
    expect((store().steps[0] as any).prompt).toBe("hello world");
  });

  it("workflowName changes are tracked and undoable", () => {
    loadWorkflow([makePrompt()]);
    store().setWorkflowName("Draft");
    store().setWorkflowName("Final");

    temporal().undo();
    expect(store().workflowName).toBe("Draft");

    temporal().undo();
    expect(store().workflowName).toBe("Test"); // name set by loadWorkflow
  });

  it("execution state changes are not undone (not in partialize)", () => {
    loadWorkflow([makePrompt()]);
    store().setExecutionState(EXECUTION_STATES.RUNNING);
    store().updatePrompt(0, { prompt: "edited" });

    temporal().undo();

    // executionState is not in the partialized snapshot — it stays as-is
    expect(store().executionState).toBe(EXECUTION_STATES.RUNNING);
    expect((store().steps[0] as any).prompt).toBe("hello world");
  });

  it("set start position records an undo entry and restores cleared runtime", () => {
    loadWorkflow([
      makePrompt({
        status: STEP_STATUS.COMPLETED,
        _runtime: { sessionId: "s1", startedAt: 100, completedAt: 200 } as any,
      }),
      makePrompt({
        prompt: "second",
        status: STEP_STATUS.COMPLETED,
        _runtime: { sessionId: "s2", startedAt: 300, completedAt: 400 } as any,
      }),
    ]);

    rememberUndoRedoRuntime(store().steps);
    store().applyStartPositionChange(
      [
        store().steps[0],
        { prompt: "second", status: STEP_STATUS.PENDING } as any,
      ],
      1
    );

    expect(temporal().pastStates).toHaveLength(1);
    expect((store().steps[1] as any)._runtime).toBeUndefined();

    const beforeUndo = store().steps;
    temporal().undo();
    const undoMerged = mergeRuntimeForUndoRedo(store().steps, beforeUndo);
    temporal().pause();
    store().setPrompts(undoMerged);
    temporal().resume();

    expect((store().steps[1] as any)._runtime?.sessionId).toBe("s2");
    expect((store().steps[1] as any).status).toBe(STEP_STATUS.COMPLETED);
  });
});

// ---------------------------------------------------------------------------
// Equality guard — running a workflow must not pollute the undo stack
// The zundo equality function treats states as equal when only runtime fields
// (_runtime, status, details) differ, even if setPrompts is called unpaused.
// ---------------------------------------------------------------------------
describe("equality guard: workflow execution must not create undo entries", () => {
  it("_runtime change alone does not create a snapshot", () => {
    loadWorkflow([makePrompt()]);

    // Simulate a run completing: _runtime is set (unpaused, as a safeguard test)
    store().updatePrompt(0, {
      _runtime: { sessionId: "abc", elapsed: 1000 } as any,
    });

    expect(temporal().pastStates).toHaveLength(0);
  });

  it("status change alone does not create a snapshot", () => {
    loadWorkflow([makePrompt()]);
    store().updatePrompt(0, { status: STEP_STATUS.COMPLETED });
    expect(temporal().pastStates).toHaveLength(0);
  });

  it("content change still records a snapshot alongside runtime changes", () => {
    loadWorkflow([makePrompt()]);

    // Prompt text changes — this IS a content change, must be undoable
    store().updatePrompt(0, {
      prompt: "edited",
      status: STEP_STATUS.RUNNING,
    });

    expect(temporal().pastStates).toHaveLength(1);
  });

  it("adding a step records 1 snapshot even when existing steps have _runtime", () => {
    loadWorkflow([
      makePrompt({ _runtime: { sessionId: "s1", elapsed: 500 } as any }),
    ]);

    // User adds a second step after the first has already run
    store().setPrompts([
      makePrompt({ _runtime: { sessionId: "s1", elapsed: 500 } as any }),
      makePrompt({ prompt: "step 2" }),
    ]);

    // Count changed → 1 snapshot (not 0 due to equality guard ignoring count)
    expect(temporal().pastStates).toHaveLength(1);
  });

  it("undo after adding a step preserves existing _runtime in the snapshot", () => {
    loadWorkflow([
      makePrompt({ _runtime: { sessionId: "s1", elapsed: 500 } as any }),
    ]);

    store().setPrompts([
      makePrompt({ _runtime: { sessionId: "s1", elapsed: 500 } as any }),
      makePrompt({ prompt: "step 2" }),
    ]);
    expect(temporal().pastStates).toHaveLength(1);

    temporal().undo();

    // Back to 1 step — _runtime preserved in snapshot as it was
    expect(store().steps).toHaveLength(1);
    expect((store().steps[0] as any)._runtime?.sessionId).toBe("s1");
  });

  it("redo after undoing a completed added step restores that step's runtime", () => {
    loadWorkflow([makePrompt()]);

    store().setPrompts([makePrompt(), makePrompt({ prompt: "step 2" })]);
    store().updatePrompt(1, {
      status: STEP_STATUS.COMPLETED,
      _runtime: {
        sessionId: "s2",
        startedAt: 100,
        completedAt: 200,
      } as any,
    });

    const beforeUndo = store().steps;
    rememberUndoRedoRuntime(beforeUndo);
    temporal().undo();
    const undoMerged = mergeRuntimeForUndoRedo(store().steps, beforeUndo);
    temporal().pause();
    store().setPrompts(undoMerged);
    temporal().resume();

    expect(store().steps).toHaveLength(1);

    const beforeRedo = store().steps;
    temporal().redo();
    const redoMerged = mergeRuntimeForUndoRedo(store().steps, beforeRedo);
    temporal().pause();
    store().setPrompts(redoMerged);
    temporal().resume();

    expect(store().steps).toHaveLength(2);
    expect((store().steps[1] as any)._runtime?.sessionId).toBe("s2");
    expect((store().steps[1] as any).status).toBe(STEP_STATUS.COMPLETED);
  });
});
