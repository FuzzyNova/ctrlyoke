import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveSteerTarget } from "@hooks/useActiveSteerTarget";
import { useTerminalStore } from "@store/terminalStore";
import {
  HEADLESS_STEER_DELIVERIES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";

beforeEach(() => {
  useTerminalStore.setState({
    sessions: {},
    activeSessionIds: {},
    headlessControlTargets: {},
  });
});

describe("useActiveSteerTarget", () => {
  it("prefers the live rail-selected PTY session over a headless target", () => {
    useTerminalStore.setState({
      sessions: {
        "workflow-1": [
          {
            id: "pty-1",
            workflowId: "workflow-1",
            stepName: "Step 2",
            stepIndex: 1,
            kind: SESSION_KINDS.AI_CLI,
            harnessId: HARNESS_IDS.CODEX_CLI,
            status: TERMINAL_SESSION_STATUS.RUNNING,
            isController: true,
          },
        ],
      },
      activeSessionIds: { "workflow-1": "pty-1" },
    });
    useTerminalStore.getState().updateHeadlessControlTarget({
      type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
      workflowId: "workflow-1",
      controlSessionId: "headless-1",
      stepIndex: 0,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
      isOpen: true,
    });

    const { result } = renderHook(() => useActiveSteerTarget("workflow-1"));

    expect(result.current).toEqual({
      sessionId: "pty-1",
      stepIndex: 1,
      harnessId: HARNESS_IDS.CODEX_CLI,
    });
  });

  it("selects the earliest open headless target for the requested workflow", () => {
    useTerminalStore.getState().updateHeadlessControlTarget({
      type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
      workflowId: "workflow-1",
      controlSessionId: "later",
      stepIndex: 4,
      harnessId: HARNESS_IDS.QWEN_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.QUEUE,
      isOpen: true,
    });
    useTerminalStore.getState().updateHeadlessControlTarget({
      type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
      workflowId: "workflow-1",
      controlSessionId: "earlier",
      stepIndex: 2,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
      isOpen: true,
    });
    useTerminalStore.getState().updateHeadlessControlTarget({
      type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
      workflowId: "workflow-2",
      controlSessionId: "other-workflow",
      stepIndex: 0,
      harnessId: HARNESS_IDS.QWEN_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.QUEUE,
      isOpen: true,
    });

    const { result } = renderHook(() => useActiveSteerTarget("workflow-1"));

    expect(result.current).toEqual({
      sessionId: "earlier",
      stepIndex: 2,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
    });
  });

  it("returns no target when the workflow has no active session", () => {
    const { result } = renderHook(() => useActiveSteerTarget("workflow-1"));

    expect(result.current).toBeUndefined();
  });
});
