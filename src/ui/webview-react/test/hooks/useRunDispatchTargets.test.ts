import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRunDispatchTargets } from "@hooks/useRunDispatchTargets";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  EDITOR_TARGET_KINDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HEADLESS_STEER_DELIVERIES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  SESSION_KINDS,
  STEP_TYPES,
  TERMINAL_SESSION_STATUS,
} from "@root/types/DashboardConstants";

beforeEach(() => {
  useEditorStore.getState().resetEditor();
  useWorkflowStore.setState({
    executionState: EXECUTION_STATES.IDLE,
    currentStep: 0,
    activeStepIndices: [],
    finalStepPhase: null,
    parallelGroups: [],
  });
  useSettingsStore.setState((state) => ({
    globalSettings: {
      ...state.globalSettings,
      effectiveParallelGroupWidth: 6,
    },
  }));
  useUiStore.setState({ activeWorkflowId: "workflow-1", loadedWorkflows: [] });
  useTerminalStore.setState({
    sessions: {},
    activeSessionIds: {},
    headlessControlTargets: {},
  });
  useEditorStore.setState({
    selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
    promptText: "draft",
    stepType: STEP_TYPES.PROMPT,
  });
});

function setRunningState(
  activeStepIndices: readonly number[],
  overrides: Partial<{
    executionState: typeof EXECUTION_STATES.RUNNING;
    finalStepPhase: null | typeof FINAL_STEP_PHASES.FINAL_STEP;
    parallelGroups: Array<{
      id: string;
      startIndex: number;
      endIndex: number;
      failFast: boolean;
    }>;
  }> = {}
) {
  useWorkflowStore.setState({
    executionState: EXECUTION_STATES.RUNNING,
    activeStepIndices: [...activeStepIndices],
    ...overrides,
  });
}

function setActiveAiCliSession(
  overrides: Partial<{
    kind: typeof SESSION_KINDS.AI_CLI | typeof SESSION_KINDS.SHELL;
    status: typeof TERMINAL_SESSION_STATUS.RUNNING;
    stepIndex: number;
  }> = {}
) {
  useTerminalStore.setState({
    sessions: {
      "workflow-1": [
        {
          id: "session-1",
          workflowId: "workflow-1",
          stepName: "Step 3",
          stepIndex: 2,
          kind: SESSION_KINDS.AI_CLI,
          harnessId: HARNESS_IDS.CODEX_CLI,
          status: TERMINAL_SESSION_STATUS.RUNNING,
          isController: true,
          ...overrides,
        },
      ],
    },
    activeSessionIds: { "workflow-1": "session-1" },
  });
}

describe("useRunDispatchTargets", () => {
  it("enables both destinations for a running queue step", () => {
    setRunningState([2]);

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel).toEqual({
      enabled: true,
      title: "Runs beside step 3; prior context resolves from before step 3",
    });
    expect(result.current.newWorkflow).toEqual({
      enabled: true,
      title: "Starts a separate workflow with default settings and this prompt",
    });
  });

  it.each([
    ["no step is running", [], {}, "No step is running"],
    [
      "the final step is running",
      [2],
      { finalStepPhase: FINAL_STEP_PHASES.FINAL_STEP },
      "The final step can't run in parallel",
    ],
    [
      "the width is one",
      [2],
      {},
      "Parallel width is 1 — raise `queue.maxParallelSteps`",
    ],
  ] as const)(
    "disables parallel when %s",
    (_label, indices, overrides, reason) => {
      if (reason.startsWith("Parallel width")) {
        useSettingsStore.setState((state) => ({
          globalSettings: {
            ...state.globalSettings,
            effectiveParallelGroupWidth: 1,
          },
        }));
      }
      setRunningState(indices, overrides);

      const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

      expect(result.current.parallel).toMatchObject({
        enabled: false,
        disabledReason: reason,
        title: reason,
      });
    }
  );

  it("reports pausing before other running-state reasons", () => {
    useWorkflowStore.setState({
      executionState: EXECUTION_STATES.PAUSING,
      activeStepIndices: [2],
    });

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel).toMatchObject({
      enabled: false,
      disabledReason: "Workflow is pausing",
    });
  });

  it("does not gate a join on a saturated parallel group", () => {
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        effectiveParallelGroupWidth: 2,
      },
    }));
    setRunningState([2, 3], {
      parallelGroups: [
        { id: "group-1", startIndex: 2, endIndex: 3, failFast: false },
      ],
    });

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel.enabled).toBe(true);
  });

  it("disables only parallel outside new-prompt mode", () => {
    useEditorStore.setState({
      selectionTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP },
    });
    setRunningState([2]);

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel.disabledReason).toBe(
      "Only available for a new prompt"
    );
    expect(result.current.newWorkflow.enabled).toBe(true);
  });

  it("offers one Send Steer Message for a single live PTY", () => {
    setActiveAiCliSession();

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.steer).toEqual([
      {
        label: "Send Steer Message",
        sessionId: "session-1",
        enabled: true,
        title:
          "Sends to the live Codex session (step 3). Prompt overrides are ignored.",
      },
    ]);
  });

  it.each([
    [
      HARNESS_IDS.CODEX_CLI,
      HEADLESS_STEER_DELIVERIES.INJECT,
      "Sends to the live Codex session (step 3). Prompt overrides are ignored.",
    ],
    [
      HARNESS_IDS.CLAUDE_CLI,
      HEADLESS_STEER_DELIVERIES.INJECT,
      "Sends to the live Claude Code session (step 3). Prompt overrides are ignored.",
    ],
    [
      HARNESS_IDS.QWEN_CLI,
      HEADLESS_STEER_DELIVERIES.QUEUE,
      "Queues for the live Qwen Code session after its current turn (step 3). Prompt overrides are ignored.",
    ],
    [
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HEADLESS_STEER_DELIVERIES.QUEUE,
      "Queues for the live Antigravity CLI session after its current turn (step 3). Prompt overrides are ignored.",
    ],
  ] as const)(
    "enables headless steer with the %s delivery tooltip",
    (harnessId, steerDelivery, title) => {
      setRunningState([2]);
      useTerminalStore.getState().updateHeadlessControlTarget({
        type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
        workflowId: "workflow-1",
        controlSessionId: "control-1",
        stepIndex: 2,
        harnessId,
        steerDelivery,
        isOpen: true,
      });

      const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

      expect(result.current.steer).toEqual([
        {
          label: "Send Steer Message",
          sessionId: "control-1",
          enabled: true,
          title,
        },
      ]);
    }
  );

  it("lists every destination, executing steps first, regardless of rail selection", () => {
    setRunningState([1, 2]);
    // A retained interactive terminal from finished step 1, selected in the rail.
    setActiveAiCliSession({ stepIndex: 0 });
    for (const [controlSessionId, stepIndex, harnessId, steerDelivery] of [
      ["control-3", 2, HARNESS_IDS.QWEN_CLI, HEADLESS_STEER_DELIVERIES.QUEUE],
      [
        "control-2",
        1,
        HARNESS_IDS.CLAUDE_CLI,
        HEADLESS_STEER_DELIVERIES.INJECT,
      ],
    ] as const) {
      useTerminalStore.getState().updateHeadlessControlTarget({
        type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
        workflowId: "workflow-1",
        controlSessionId,
        stepIndex,
        harnessId,
        steerDelivery,
        isOpen: true,
      });
    }

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(
      result.current.steer.map(({ label, sessionId }) => ({ label, sessionId }))
    ).toEqual([
      { label: "Steer Step 2 · Claude Code", sessionId: "control-2" },
      {
        label: "Steer Step 3 · Qwen Code (after turn)",
        sessionId: "control-3",
      },
      { label: "Steer Step 1 · Codex (finished)", sessionId: "session-1" },
    ]);
    expect(result.current.steer.every((target) => target.enabled)).toBe(true);
  });

  it.each([
    ["without a live session", undefined],
    ["with a shell session", { kind: SESSION_KINDS.SHELL }],
    [
      "with a non-running session",
      { status: TERMINAL_SESSION_STATUS.COMPLETED as never },
    ],
  ] as const)("disables steer %s", (_label, session) => {
    if (session) {
      setActiveAiCliSession(session);
    }

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.steer).toEqual([
      {
        label: "Send Steer Message",
        enabled: false,
        disabledReason: "No live harness session for this workflow",
        title: "No live harness session for this workflow",
      },
    ]);
  });

  it.each([
    [
      "outside new-prompt mode",
      { selectionTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP } },
      "Only available for a new prompt",
    ],
    [
      "for a script step",
      { stepType: STEP_TYPES.SCRIPT },
      "Steering is only available for prompt steps",
    ],
    ["without draft content", { promptText: "" }, "Enter a prompt first"],
  ] as const)("disables steer %s", (_label, state, reason) => {
    setActiveAiCliSession();
    useEditorStore.setState(state);

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.steer).toEqual([
      {
        label: "Send Steer Message",
        sessionId: "session-1",
        enabled: false,
        disabledReason: reason,
        title: reason,
      },
    ]);
  });

  it("disables steer for external runs", () => {
    setActiveAiCliSession();
    useUiStore.setState({
      loadedWorkflows: [{ id: "workflow-1", externalOwner: {} } as never],
    });

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.steer[0]).toMatchObject({
      enabled: false,
      disabledReason: "Read-only — external run",
      title: "Read-only — external run",
    });
  });
});
