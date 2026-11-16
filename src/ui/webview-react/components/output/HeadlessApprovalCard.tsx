import React, { useCallback, useEffect, useState } from "react";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkflowStore } from "@store/workflowStore";
import {
  APPROVAL_DECISIONS,
  MESSAGE_TYPES,
  type ApprovalDecision,
} from "@root/types/DashboardConstants";
import type {
  HeadlessApprovalRequestMessage,
  HeadlessApprovalResponseMessage,
} from "@root/types/WebviewMessageTypes";

export interface HeadlessApprovalCardProps {
  approval: HeadlessApprovalRequestMessage;
  stepLabel: string;
  stepName?: string;
}

function formatCountdown(remainingSeconds: number): string {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export const HeadlessApprovalCard: React.FC<HeadlessApprovalCardProps> = ({
  approval,
  stepLabel,
  stepName,
}) => {
  const [now, setNow] = useState(() => Date.now());
  const [denyMessage, setDenyMessage] = useState("");
  const isAnswered = useWorkflowStore(
    (state) => state.answeredHeadlessApprovalIds[approval.approvalId] === true
  );
  const remainingSeconds = Math.max(
    0,
    Math.ceil((approval.deadline - now) / 1000)
  );
  const isDisabled = isAnswered || remainingSeconds === 0;

  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timerId);
  }, [approval.deadline]);

  const respond = useCallback(
    (decision: ApprovalDecision) => {
      if (isDisabled || Date.now() >= approval.deadline) {
        setNow(Date.now());
        return;
      }
      const response: HeadlessApprovalResponseMessage = {
        type: MESSAGE_TYPES.RESPOND_TO_HEADLESS_APPROVAL,
        workflowId: approval.workflowId,
        controlSessionId: approval.controlSessionId,
        approvalId: approval.approvalId,
        decision,
        ...(decision === APPROVAL_DECISIONS.DENY && denyMessage.trim()
          ? { message: denyMessage.trim() }
          : {}),
      };
      getVsCodeApi().postMessage(response);
      useWorkflowStore
        .getState()
        .markHeadlessApprovalAnswered(
          approval.workflowId,
          approval.stepIndex,
          approval.approvalId
        );
    },
    [approval, denyMessage, isDisabled]
  );

  const statusText = isAnswered
    ? "Answer sent."
    : remainingSeconds === 0
      ? "Request expired."
      : `Auto-denies in ${formatCountdown(remainingSeconds)}`;

  return (
    <section
      className="mx-2 my-2 rounded-sm border border-panel-border bg-sidebar-bg px-3 py-2 text-sm"
      aria-label={`Tool approval requested for ${stepLabel}${stepName ? ` · ${stepName}` : ""}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="font-semibold text-foreground">
            Tool approval requested
            <span className="ml-2 text-xs font-normal text-description-fg">
              {stepLabel}
              {stepName ? ` · ${stepName}` : ""}
            </span>
          </div>
          <div className="mt-1 break-all font-mono text-xs text-foreground">
            {approval.toolName}
          </div>
        </div>
        <div
          className="shrink-0 text-xs text-description-fg"
          aria-live="polite"
        >
          {statusText}
        </div>
      </div>

      <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-sm border border-panel-border bg-editor-bg px-2 py-1 text-xs text-foreground">
        {approval.inputSummary || "No input details available."}
      </div>

      <label className="mt-2 block text-xs text-description-fg">
        Optional denial message
        <textarea
          className="mt-1 block w-full resize-y rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg placeholder:text-description-fg focus:border-focus-border focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
          rows={2}
          value={denyMessage}
          onChange={(event) => setDenyMessage(event.target.value)}
          disabled={isDisabled}
          placeholder="Tell the harness why this tool was denied"
          aria-label="Optional denial message"
        />
      </label>

      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="rounded-sm border border-panel-border px-2 py-1 text-xs text-error-fg hover:bg-toolbar-hover-bg disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isDisabled}
          onClick={() => respond(APPROVAL_DECISIONS.DENY)}
        >
          Deny
        </button>
        <button
          type="button"
          className="rounded-sm border border-focus-border px-2 py-1 text-xs text-link-fg hover:bg-toolbar-hover-bg disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isDisabled}
          onClick={() => respond(APPROVAL_DECISIONS.ALLOW_ONCE)}
        >
          Allow once
        </button>
      </div>
    </section>
  );
};
