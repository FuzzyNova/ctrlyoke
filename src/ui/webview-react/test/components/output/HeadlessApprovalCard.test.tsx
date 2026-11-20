import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HeadlessApprovalCard } from "@components/output/HeadlessApprovalCard";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkflowStore } from "@store/workflowStore";
import {
  APPROVAL_DECISIONS,
  HARNESS_IDS,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { HeadlessApprovalRequestMessage } from "@root/types/WebviewMessageTypes";

function makeApproval(
  overrides: Partial<HeadlessApprovalRequestMessage> = {}
): HeadlessApprovalRequestMessage {
  return {
    type: MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED,
    approvalId: "approval-1",
    requestId: "request-1",
    workflowId: "workflow-1",
    controlSessionId: "control-1",
    stepIndex: 0,
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    toolName: "shell",
    inputSummary: "npm test",
    deadline: Date.now() + 60_000,
    isPending: true,
    ...overrides,
  };
}

beforeEach(() => {
  useWorkflowStore.getState().clearHeadlessApprovals();
  useWorkflowStore.getState().resetWorkflow();
  vi.mocked(getVsCodeApi().postMessage).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HeadlessApprovalCard", () => {
  it("shows the request and sends an optional deny message", () => {
    const approval = makeApproval();
    useWorkflowStore.getState().updateHeadlessApprovalRequest(approval);
    render(
      <HeadlessApprovalCard
        approval={approval}
        stepLabel="Step 1"
        stepName="Run tests"
      />
    );

    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("Step 1 · Run tests")).toBeInTheDocument();
    expect(screen.getByText("Auto-denies in 1:00")).toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Optional denial message" }),
      {
        target: { value: "Use the approved test command instead." },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.RESPOND_TO_HEADLESS_APPROVAL,
      workflowId: approval.workflowId,
      controlSessionId: approval.controlSessionId,
      approvalId: approval.approvalId,
      decision: APPROVAL_DECISIONS.DENY,
      message: "Use the approved test command instead.",
    });
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  });

  it("allows once and disables the card after answering", () => {
    const approval = makeApproval({ approvalId: "approval-2" });
    useWorkflowStore.getState().updateHeadlessApprovalRequest(approval);
    render(<HeadlessApprovalCard approval={approval} stepLabel="Step 1" />);

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.RESPOND_TO_HEADLESS_APPROVAL,
      workflowId: approval.workflowId,
      controlSessionId: approval.controlSessionId,
      approvalId: approval.approvalId,
      decision: APPROVAL_DECISIONS.ALLOW_ONCE,
    });
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Optional denial message" })
    ).toBeDisabled();
  });

  it("disables responses when the deny deadline expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const approval = makeApproval({
      approvalId: "approval-3",
      deadline: 2_500,
    });
    useWorkflowStore.getState().updateHeadlessApprovalRequest(approval);
    render(<HeadlessApprovalCard approval={approval} stepLabel="Step 1" />);

    expect(screen.getByText("Auto-denies in 0:02")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(screen.getByText("Request expired.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  });
});
