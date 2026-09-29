import React from "react";
import { StatusIcon } from "@components/prompts/StatusIcon";
import { RawToolCallSection } from "./RawToolCallSection";
import type { ToolCallExpansionSection } from "@root/types/DashboardConstants";
import type { ToolCallExpansionState } from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import { highlightText } from "@utils/outputFind";
import type { McpToolCallData } from "../../../types/cliEvents";
import {
  estimateWorkflowStatusHeight,
  workflowStatusProgress,
  workflowStatusSearchText,
  workflowStepStatus,
  type WorkflowStatusParams,
  type WorkflowStatusResult,
} from "./workflowStatusModel";

export interface ToolViewBodyProps {
  params: unknown;
  result: unknown;
  data: McpToolCallData;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  outputFindMatches?: RowFindDecoration["matches"];
  paramsFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
  findDecorations?: RowFindDecoration;
}
function matchesIn(
  matches: RowFindDecoration["matches"] = [],
  start: number,
  length: number
): RowFindDecoration["matches"] {
  return matches
    .filter((m) => m.start < start + length && m.end > start)
    .map((m) => ({
      ...m,
      start: Math.max(0, m.start - start),
      end: Math.min(length, m.end - start),
    }));
}
export const WorkflowStatusBody: React.FC<ToolViewBodyProps> = ({
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
  const status = result as WorkflowStatusResult;
  const bodyLines = workflowStatusSearchText(
    params as WorkflowStatusParams | undefined,
    status
  )[1]
    .split("\n")
    .filter(Boolean);
  const rows = bodyLines.slice(0, status.steps.length);
  let offset = 0;
  return (
    <div className="space-y-2 text-[length:var(--cy-output-font-size-sm)]">
      <div
        className="h-1.5 overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-label="Workflow progress"
        aria-valuenow={workflowStatusProgress(status)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-[var(--vscode-progressBar-background)]"
          style={{ width: `${workflowStatusProgress(status)}%` }}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <thead>
            <tr className="text-description-foreground">
              <th className="w-8 p-1">#</th>
              <th className="w-5 p-1">Status</th>
              <th className="p-1">Name</th>
              <th className="p-1">Harness</th>
            </tr>
          </thead>
          <tbody>
            {status.steps.map((step, i) => {
              const line = rows[i] ?? "";
              const start = offset;
              offset += line.length + 1;
              const name =
                step.prompt.split(/\r?\n/, 1)[0] || `Step ${step.index + 1}`;
              const harness = status.metadata.harness ?? "workflow harness";
              return (
                <tr key={step.index} className="border-t border-border/50">
                  <td className="p-1 text-muted-foreground">
                    {step.index + 1}
                  </td>
                  <td className="p-1">
                    <StatusIcon status={workflowStepStatus(step.status)} />
                  </td>
                  <td className="break-words p-1">
                    {highlightText(
                      name,
                      matchesIn(
                        findDecorations?.matches,
                        start + `${step.index + 1} · ${step.status} · `.length,
                        name.length
                      )
                    )}
                  </td>
                  <td className="break-words p-1">{harness}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {status.schemaWarnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-warning-fg">
          {status.schemaWarnings.map((warning, i) => {
            const warningStart =
              rows.reduce((total, row) => total + row.length + 1, 0) +
              status.schemaWarnings
                .slice(0, i)
                .reduce((total, item) => total + item.message.length + 1, 0);
            return (
              <li key={`${warning.path ?? "warning"}-${i}`}>
                {highlightText(
                  warning.message,
                  matchesIn(
                    findDecorations?.matches,
                    warningStart,
                    warning.message.length
                  )
                )}
              </li>
            );
          })}
        </ul>
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
export { estimateWorkflowStatusHeight };
