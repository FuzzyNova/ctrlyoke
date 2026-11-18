import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSteerTargets } from "@hooks/useSteerTargets";
import { useTerminalStore } from "@store/terminalStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  formatSteerTargetLabel,
  formatSteerTargetTitle,
} from "@utils/steerTargets";
import {
  HEADLESS_STEER_DELIVERIES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";

function openHeadlessTarget(
  workflowId: string,
  controlSessionId: string,
  stepIndex: number,
  overrides: Partial<{
    harnessId: (typeof HARNESS_IDS)[keyof typeof HARNESS_IDS];
    steerDelivery: (typeof HEADLESS_STEER_DELIVERIES)[keyof typeof HEADLESS_STEER_DELIVERIES];
    canInterruptTurn: boolean;
  }> = {}
) {
  useTerminalStore.getState().updateHeadlessControlTarget({
    type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
    workflowId,
    controlSessionId,
    stepIndex,
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
    isOpen: true,
    ...overrides,
  });
}

beforeEach(() => {
  useTerminalStore.setState({
    sessions: {},
    activeSessionIds: {},
    headlessControlTargets: {},
  });
  useWorkflowStore.setState({ activeStepIndices: [] });
});

describe("useSteerTargets", () => {
  it("returns every headless target and running AI PTY, executing steps first", () => {
    useWorkflowStore.setState({ activeStepIndices: [1, 3] });
    useTerminalStore.setState({
      sessions: {
        "workflow-1": [
          {
            id: "retained-pty",
            workflowId: "workflow-1",
            stepName: "Step 1",
            stepIndex: 0,
            kind: SESSION_KINDS.AI_CLI,
            harnessId: HARNESS_IDS.CODEX_CLI,
            status: TERMINAL_SESSION_STATUS.RUNNING,
            isController: true,
          },
          {
            id: "running-pty",
            workflowId: "workflow-1",
            stepName: "Step 4",
            stepIndex: 3,
            kind: SESSION_KINDS.AI_CLI,
            harnessId: HARNESS_IDS.CODEX_CLI,
            status: TERMINAL_SESSION_STATUS.RUNNING,
            isController: true,
          },
          {
            id: "shell",
            workflowId: "workflow-1",
            stepName: "Shell",
            stepIndex: -1,
            kind: SESSION_KINDS.SHELL,
            status: TERMINAL_SESSION_STATUS.RUNNING,
            isController: true,
          },
        ],
      },
      // Rail selection must not change the order or hide anything.
      activeSessionIds: { "workflow-1": "retained-pty" },
    });
    openHeadlessTarget("workflow-1", "headless-2", 1, {
      canInterruptTurn: true,
    });
    openHeadlessTarget("workflow-2", "other-workflow", 0);

    const { result } = renderHook(() => useSteerTargets("workflow-1"));

    expect(result.current).toEqual([
      {
        sessionId: "headless-2",
        stepIndex: 1,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
        canInterruptTurn: true,
        isExecuting: true,
      },
      {
        sessionId: "running-pty",
        stepIndex: 3,
        harnessId: HARNESS_IDS.CODEX_CLI,
        isExecuting: true,
      },
      {
        sessionId: "retained-pty",
        stepIndex: 0,
        harnessId: HARNESS_IDS.CODEX_CLI,
        isExecuting: false,
      },
    ]);
  });

  it("returns no targets when the workflow has no live session", () => {
    const { result } = renderHook(() => useSteerTargets("workflow-1"));

    expect(result.current).toEqual([]);
  });
});

describe("steer target labels", () => {
  it.each([
    [
      {
        sessionId: "a",
        stepIndex: 1,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
        isExecuting: true,
      },
      "Steer Step 2 · Claude Code",
    ],
    [
      {
        sessionId: "b",
        stepIndex: 2,
        harnessId: HARNESS_IDS.QWEN_CLI,
        steerDelivery: HEADLESS_STEER_DELIVERIES.QUEUE,
        isExecuting: true,
      },
      "Steer Step 3 · Qwen Code (after turn)",
    ],
    [
      {
        sessionId: "c",
        stepIndex: 0,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        isExecuting: false,
      },
      "Steer Step 1 · Claude Code (finished)",
    ],
  ])("labels %o as %s", (target, label) => {
    expect(formatSteerTargetLabel(target)).toBe(label);
  });

  it("names the final-step pass and sorts it after queue steps", () => {
    useWorkflowStore.setState({ activeStepIndices: [-2, 3] });
    openHeadlessTarget("workflow-1", "final-pass-2", -2);
    openHeadlessTarget("workflow-1", "step-4", 3);

    const { result } = renderHook(() => useSteerTargets("workflow-1"));

    expect(result.current.map(formatSteerTargetLabel)).toEqual([
      "Steer Step 4 · Claude Code",
      "Steer Final Step Pass 2 · Claude Code",
    ]);
    expect(formatSteerTargetTitle(result.current[1])).toBe(
      "Sends to the live Claude Code session (final step pass 2). Prompt overrides are ignored."
    );
  });

  it("keeps the per-delivery tooltip wording", () => {
    expect(
      formatSteerTargetTitle({
        sessionId: "b",
        stepIndex: 2,
        harnessId: HARNESS_IDS.QWEN_CLI,
        steerDelivery: HEADLESS_STEER_DELIVERIES.QUEUE,
        isExecuting: true,
      })
    ).toBe(
      "Queues for the live Qwen Code session after its current turn (step 3). Prompt overrides are ignored."
    );
  });
});
