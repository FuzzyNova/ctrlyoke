import { beforeEach, describe, expect, it } from "vitest";
import { useWorkflowStore } from "@store/workflowStore";
import { HARNESS_IDS, MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { HeadlessApprovalRequestMessage } from "@root/types/WebviewMessageTypes";

function makeApproval(
  workflowId: string,
  stepIndex: number,
  approvalId: string
): HeadlessApprovalRequestMessage {
  return {
    type: MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED,
    approvalId,
    requestId: `request-${approvalId}`,
    workflowId,
    controlSessionId: `control-${workflowId}`,
    stepIndex,
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    toolName: "shell",
    inputSummary: "npm test",
    deadline: 120_000,
    isPending: true,
  };
}

beforeEach(() => {
  useWorkflowStore.getState().clearHeadlessApprovals();
  useWorkflowStore.getState().resetWorkflow();
});

describe("workflowStore headless approvals", () => {
  it("stores approvals by workflow and signed step, and deduplicates replay", () => {
    const first = makeApproval("workflow-a", 2, "approval-1");
    const second = makeApproval("workflow-a", 2, "approval-2");
    const finalPass = makeApproval("workflow-a", -1, "approval-final");
    const otherWorkflow = makeApproval("workflow-b", 2, "approval-other");
    const store = useWorkflowStore.getState();

    store.updateHeadlessApprovalRequest(first);
    store.updateHeadlessApprovalRequest(first);
    store.updateHeadlessApprovalRequest(second);
    store.updateHeadlessApprovalRequest(finalPass);
    store.updateHeadlessApprovalRequest(otherWorkflow);

    expect(useWorkflowStore.getState().headlessApprovalsByWorkflow).toEqual({
      "workflow-a": {
        2: [first, second],
        "-1": [finalPass],
      },
      "workflow-b": {
        2: [otherWorkflow],
      },
    });
  });

  it("removes answered requests and their disabled state", () => {
    const approval = makeApproval("workflow-a", -2, "approval-final");
    const store = useWorkflowStore.getState();
    store.updateHeadlessApprovalRequest(approval);
    store.markHeadlessApprovalAnswered(
      approval.workflowId,
      approval.stepIndex,
      approval.approvalId
    );

    expect(
      useWorkflowStore.getState().answeredHeadlessApprovalIds[
        approval.approvalId
      ]
    ).toBe(true);

    store.updateHeadlessApprovalRequest({ ...approval, isPending: false });

    expect(
      useWorkflowStore.getState().headlessApprovalsByWorkflow["workflow-a"]
    ).toBeUndefined();
    expect(
      useWorkflowStore.getState().answeredHeadlessApprovalIds[
        approval.approvalId
      ]
    ).toBeUndefined();
  });

  it("clears one step or workflow without affecting other pending approvals", () => {
    const queueStep = makeApproval("workflow-a", 0, "approval-queue");
    const finalStep = makeApproval("workflow-a", -1, "approval-final");
    const otherWorkflow = makeApproval("workflow-b", 0, "approval-other");
    const store = useWorkflowStore.getState();
    store.updateHeadlessApprovalRequest(queueStep);
    store.updateHeadlessApprovalRequest(finalStep);
    store.updateHeadlessApprovalRequest(otherWorkflow);

    store.clearHeadlessApprovalsForStep("workflow-a", 0);

    expect(
      useWorkflowStore.getState().headlessApprovalsByWorkflow["workflow-a"]
    ).toEqual({ "-1": [finalStep] });
    expect(
      useWorkflowStore.getState().headlessApprovalsByWorkflow["workflow-b"]
    ).toEqual({ 0: [otherWorkflow] });

    store.clearHeadlessApprovalsForWorkflow("workflow-a");
    expect(
      useWorkflowStore.getState().headlessApprovalsByWorkflow["workflow-a"]
    ).toBeUndefined();
    expect(
      useWorkflowStore.getState().headlessApprovalsByWorkflow["workflow-b"]
    ).toEqual({ 0: [otherWorkflow] });
  });
});
