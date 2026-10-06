import React from "react";
import { StatusIcon } from "@components/prompts/StatusIcon";
import { RawToolCallSection } from "./RawToolCallSection";
import type { ToolCallExpansionSection } from "@root/types/DashboardConstants";
import type { ToolCallExpansionState } from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import { highlightText } from "@utils/outputFind";
import type { McpToolCallData } from "../../../types/cliEvents";
import {
  workflowStatusHarnessLabel,
  workflowStatusProgress,
  workflowStatusRowPrefix,
  workflowStatusSearchText,
  workflowStatusStepName,
  workflowStatusStepTitle,
  workflowStepStatus,
  type WorkflowStatusParams,
  type WorkflowStatusResult,
} from "@root/utils/ctrlyokeToolViews/workflowStatusModel";
import { sliceFindMatches } from "./shared";

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
  const harness = workflowStatusHarnessLabel(status);
  let offset = 0;
  return (
    <div className="space-y-2 text-(length:--cy-output-font-size-sm)">
      <div
        className="h-1.5 overflow-hidden rounded-sm bg-muted"
        role="progressbar"
        aria-label="Workflow progress"
        aria-valuenow={workflowStatusProgress(status)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-(--vscode-progressBar-background)"
          style={{ width: `${workflowStatusProgress(status)}%` }}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-description-foreground">
              <th className="w-px whitespace-nowrap p-1">#</th>
              <th className="w-px p-1">
                <span className="sr-only">Status</span>
              </th>
              <th className="p-1">Name</th>
              <th className="w-px whitespace-nowrap p-1">Harness</th>
            </tr>
          </thead>
          <tbody>
            {status.steps.map((step, i) => {
              const line = rows[i] ?? "";
              const start = offset;
              offset += line.length + 1;
              const name = workflowStatusStepName(step);
              return (
                <tr key={step.index} className="border-t border-border/50">
                  <td className="whitespace-nowrap p-1 text-muted-foreground">
                    {step.index + 1}
                  </td>
                  <td className="p-1">
                    <StatusIcon status={workflowStepStatus(step.status)} />
                  </td>
                  <td
                    className="p-1 wrap-anywhere"
                    title={workflowStatusStepTitle(step)}
                  >
                    {highlightText(
                      name,
                      sliceFindMatches(
                        findDecorations?.matches,
                        start + workflowStatusRowPrefix(step).length,
                        name.length
                      )
                    )}
                  </td>
                  <td className="whitespace-nowrap p-1">{harness}</td>
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
                  sliceFindMatches(
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
        buttonClassName="text-bash-expand-link cursor-pointer bg-transparent p-0 text-(length:--cy-output-font-size-sm) hover:underline"
      />
    </div>
  );
};
