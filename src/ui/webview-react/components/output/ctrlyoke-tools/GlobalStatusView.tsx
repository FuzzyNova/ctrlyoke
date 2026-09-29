import React from "react";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import { TOOL_CALL_EXPANSION_SECTIONS } from "@root/types/DashboardConstants";
import { highlightText } from "@utils/outputFind";
import {
  globalStatusSearchText,
  type GlobalStatusParams,
  type GlobalStatusResult,
} from "./globalStatusModel";
import type { ToolViewBodyProps } from "./WorkflowStatusView";
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
  const lines = globalStatusSearchText(
    params as GlobalStatusParams | undefined,
    status
  )[1]
    .split("\n")
    .filter(Boolean);
  const workflowLines = lines.slice(0, status.workflows.length);
  let offset = 0;
  return (
    <div className="space-y-2 text-[length:var(--cy-output-font-size-sm)]">
      <ul className="space-y-1">
        {status.workflows.map((workflow, i) => {
          const text = workflowLines[i] ?? "";
          const start = offset;
          offset += text.length + 1;
          const nameStart = start + `${workflow.executionState} · `.length;
          return (
            <li
              key={`${workflow.workflowKey}-${workflow.runRef ?? "latest"}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="rounded-full bg-muted px-2 py-0.5">
                {workflow.executionState}
              </span>
              <span className="min-w-0 flex-1 break-words">
                ·{" "}
                {highlightText(
                  workflow.workflowName,
                  (findDecorations?.matches ?? [])
                    .filter(
                      (m) =>
                        m.start < nameStart + workflow.workflowName.length &&
                        m.end > nameStart
                    )
                    .map((m) => ({
                      ...m,
                      start: Math.max(0, m.start - nameStart),
                      end: Math.min(
                        workflow.workflowName.length,
                        m.end - nameStart
                      ),
                    }))
                )}{" "}
                <span className="text-muted-foreground">
                  · {workflow.workflowKey} · {workflow.currentStep}/
                  {workflow.totalSteps} ·{" "}
                  {workflow.harness ?? "workflow harness"}
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
      <button
        type="button"
        className="text-bash-expand-link cursor-pointer bg-transparent p-0 text-[length:var(--cy-output-font-size-sm)] hover:underline"
        aria-expanded={!!expansion.rawExpanded}
        onClick={() => {
          const opening = !expansion.rawExpanded;
          onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.RAW, opening);
          if (opening)
            onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.PARAMS, true);
        }}
      >
        {expansion.rawExpanded ? "Hide raw" : "Raw"}
      </button>
      {expansion.rawExpanded && (
        <McpToolCallOutput
          server={data.server}
          tool={data.tool}
          parameters={data.parameters}
          result={data.result}
          paramsFindMatches={paramsFindMatches}
          outputFindMatches={outputFindMatches}
          errorFindMatches={errorFindMatches}
          expansion={expansion}
          onExpansionChange={onExpansionChange}
        />
      )}
    </div>
  );
};
