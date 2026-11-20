import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "@store/terminalStore";
import {
  HEADLESS_STEER_DELIVERIES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  type HeadlessControlTargetMessage,
} from "@/types/messages";

function makeTarget(
  overrides: Partial<HeadlessControlTargetMessage> = {}
): HeadlessControlTargetMessage {
  return {
    type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
    workflowId: "workflow-1",
    controlSessionId: "control-1",
    stepIndex: 0,
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
    isOpen: true,
    ...overrides,
  };
}

describe("terminalStore headless control targets", () => {
  beforeEach(() => {
    useTerminalStore.setState({ headlessControlTargets: {} });
  });

  it("stores open targets by workflow and removes only the matching closed session", () => {
    const first = makeTarget();
    const second = makeTarget({
      controlSessionId: "control-2",
      stepIndex: 1,
      harnessId: HARNESS_IDS.QWEN_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.QUEUE,
    });
    const otherWorkflow = makeTarget({
      workflowId: "workflow-2",
      controlSessionId: "control-3",
    });
    const store = useTerminalStore.getState();

    store.updateHeadlessControlTarget(second);
    store.updateHeadlessControlTarget(first);
    store.updateHeadlessControlTarget(otherWorkflow);
    store.updateHeadlessControlTarget({ ...first, isOpen: false });

    expect(
      useTerminalStore.getState().headlessControlTargets["workflow-1"]
    ).toEqual([second]);
    expect(
      useTerminalStore.getState().headlessControlTargets["workflow-2"]
    ).toEqual([otherWorkflow]);
  });

  it("replaces a target with the same control session id", () => {
    const store = useTerminalStore.getState();
    store.updateHeadlessControlTarget(makeTarget());
    const updated = makeTarget({
      stepIndex: 2,
      steerDelivery: HEADLESS_STEER_DELIVERIES.QUEUE,
      harnessId: HARNESS_IDS.QWEN_CLI,
    });

    store.updateHeadlessControlTarget(updated);

    expect(
      useTerminalStore.getState().headlessControlTargets["workflow-1"]
    ).toEqual([updated]);
  });

  it("clears targets for one workflow or all workflows", () => {
    const store = useTerminalStore.getState();
    store.updateHeadlessControlTarget(makeTarget());
    store.updateHeadlessControlTarget(
      makeTarget({ workflowId: "workflow-2", controlSessionId: "other" })
    );

    store.clearHeadlessControlTargets("workflow-1");

    expect(useTerminalStore.getState().headlessControlTargets).toEqual({
      "workflow-2": [
        makeTarget({ workflowId: "workflow-2", controlSessionId: "other" }),
      ],
    });

    store.clearHeadlessControlTargets();

    expect(useTerminalStore.getState().headlessControlTargets).toEqual({});
  });
});
