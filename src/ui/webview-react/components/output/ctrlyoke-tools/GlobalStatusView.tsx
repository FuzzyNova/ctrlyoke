import React from "react";
import { RawToolCallSection } from "./RawToolCallSection";
import { highlightText } from "@utils/outputFind";
import {
  globalStatusHarnessLabel,
  globalStatusSearchText,
  type GlobalStatusParams,
  type GlobalStatusResult,
} from "./globalStatusModel";
import type { ToolViewBodyProps } from "./WorkflowStatusView";
import { sliceFindMatches } from "./shared";
export const GlobalStatusBody: React.FC<ToolViewBodyProps> = ({
  params,
  result,
  data,
  expansion,
  onExpansionChange,
  findDecorations,
  outputFindMatches,
  paramsFindMatches,
  errorFindMatches,
}) => {
  const status = result as GlobalStatusResult;
  const bodyText = globalStatusSearchText(
    params as GlobalStatusParams | undefined,
    status
  )[1];
  const lines = bodyText.split("\n").filter(Boolean);
  const workflowLines = lines.slice(0, status.workflows.length);
  let offset = 0;
  return (
    <div className="space-y-2 text-[length:var(--cy-output-font-size-sm)]">
      <ul className="space-y-1">
        {status.workflows.map((workflow, i) => {
          const text = workflowLines[i] ?? "";
          const start = offset;
          offset += text.length + 1;
          const nameStart = start + text.indexOf(workflow.workflowName);
          return (
            <li
              key={`${workflow.workflowKey}-${workflow.runRef ?? "latest"}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="rounded-full bg-muted px-2 py-0.5">
                {workflow.executionState}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {highlightText(
                  workflow.workflowName,
                  sliceFindMatches(
                    findDecorations?.matches,
                    nameStart,
                    workflow.workflowName.length
                  )
                )}{" "}
                <span className="text-muted-foreground">
                  · {workflow.workflowKey} · {workflow.currentStep}/
                  {workflow.totalSteps} · {globalStatusHarnessLabel(workflow)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {status.truncated && (
        <div className="text-muted-foreground">
          Truncated · {status.omittedCount} omitted
        </div>
      )}
      {status.note && (
        <div className="text-muted-foreground">{status.note}</div>
      )}
      <RawToolCallSection
        data={data}
        paramsFindMatches={paramsFindMatches}
        outputFindMatches={outputFindMatches}
        errorFindMatches={errorFindMatches}
        expansion={expansion}
        onExpansionChange={onExpansionChange}
        buttonClassName="text-bash-expand-link cursor-pointer bg-transparent p-0 text-[length:var(--cy-output-font-size-sm)] hover:underline"
      />
    </div>
  );
};
