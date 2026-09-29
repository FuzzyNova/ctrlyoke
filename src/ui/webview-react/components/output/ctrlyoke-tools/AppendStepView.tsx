import React from "react";
import type { ToolResult } from "../../../types/cliEvents";
import { highlightText } from "@utils/outputFind";
import { RawToolCallSection } from "./RawToolCallSection";
import { TOOL_CALL_EXPANSION_SECTIONS } from "@root/types/DashboardConstants";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import type { AppendStepParams, AppendStepResult } from "./appendStepModel";
import { sliceFindMatches } from "./shared";
import {
  appendStepParallelGroupLine,
  appendStepPromptPreview,
  appendStepRowLine,
  APPEND_STEP_DEFAULT_HARNESS_LABEL,
  appendStepSearchText,
} from "./appendStepModel";

export interface AppendStepBodyProps {
  params: AppendStepParams | undefined;
  result: AppendStepResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  outputFindMatches?: RowFindDecoration["matches"];
  bodyFindMatches?: RowFindDecoration["matches"];
  paramsFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
}

function displayIndex(index: number): string {
  return `#${index + 1}`;
}

export const AppendStepBody: React.FC<AppendStepBodyProps> = ({
  params,
  result,
  server,
  tool,
  parameters,
  genericResult,
  expansion,
  onExpansionChange,
  outputFindMatches,
  bodyFindMatches,
  paramsFindMatches,
  errorFindMatches,
}) => {
  const promptsExpanded = expansion.appendStepPromptsExpanded ?? false;
  const searchableLines =
    appendStepSearchText(params, result)[1]?.split("\n") ?? [];
  let bodyOffset = 0;
  let stepIndex = result.insertIndex;
  let parallelGroupIndex = 0;

  return (
    <div className="space-y-2">
      {params ? (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-[length:var(--cy-output-font-size-sm)]">
            <thead>
              <tr className="text-description-foreground">
                <th className="w-14 p-1 font-medium">Position</th>
                <th className="w-1/5 p-1 font-medium">Name</th>
                <th className="w-1/4 p-1 font-medium">Harness / model</th>
                <th className="p-1 font-medium">Prompt</th>
              </tr>
            </thead>
            <tbody>
              {params.steps.map((item, itemIndex) => {
                const grouped = "parallel" in item;
                const steps = grouped ? item.parallel : [item];
                const groupResult = grouped
                  ? result.parallelGroupsAdded[parallelGroupIndex++]
                  : undefined;
                const groupFailFast =
                  groupResult?.failFast ??
                  (grouped ? item.failFast !== false : false);
                const groupStart = stepIndex;
                if (grouped) {
                  const groupLine = appendStepParallelGroupLine(
                    groupStart,
                    groupStart + steps.length - 1,
                    groupFailFast
                  );
                  bodyOffset += groupLine.length + 1;
                }
                const rows = steps.map((step) => {
                  const currentIndex = stepIndex++;
                  const promptLine = appendStepPromptPreview(step);
                  const name = step.name ?? "Step";
                  const harnessModel =
                    [step.harness, step.model].filter(Boolean).join(" / ") ||
                    APPEND_STEP_DEFAULT_HARNESS_LABEL;
                  const shownPrompt = promptsExpanded
                    ? step.prompt
                    : promptLine;
                  const line =
                    searchableLines.find((candidate) =>
                      candidate.startsWith(`${displayIndex(currentIndex)} · `)
                    ) ?? appendStepRowLine(currentIndex, step);
                  const lineStart = bodyOffset;
                  bodyOffset += line.length + 1;
                  const nameStart = `${displayIndex(currentIndex)} · `.length;
                  const harnessStart = nameStart + name.length + " · ".length;
                  const promptStart =
                    harnessStart + harnessModel.length + " · ".length;
                  return (
                    <tr
                      key={`${currentIndex}-${step.name ?? "step"}`}
                      className="border-t border-border/50 align-top"
                    >
                      <td className="p-1 text-muted-foreground">
                        {highlightText(
                          displayIndex(currentIndex),
                          sliceFindMatches(
                            bodyFindMatches,
                            lineStart,
                            displayIndex(currentIndex).length
                          )
                        )}{" "}
                        ·
                      </td>
                      <td className="break-words p-1">
                        {highlightText(
                          name,
                          sliceFindMatches(
                            bodyFindMatches,
                            lineStart + nameStart,
                            name.length
                          )
                        )}{" "}
                        ·
                      </td>
                      <td className="break-words p-1">
                        {highlightText(
                          harnessModel,
                          sliceFindMatches(
                            bodyFindMatches,
                            lineStart + harnessStart,
                            harnessModel.length
                          )
                        )}{" "}
                        ·
                      </td>
                      <td className="break-words p-1">
                        {highlightText(
                          shownPrompt,
                          sliceFindMatches(
                            bodyFindMatches,
                            lineStart + promptStart,
                            promptLine.length
                          )
                        )}
                      </td>
                    </tr>
                  );
                });
                if (!grouped) return rows;
                return (
                  <React.Fragment key={`parallel-${itemIndex}`}>
                    <tr className="border-t border-border bg-muted/40">
                      <td colSpan={4} className="p-1">
                        <span className="font-medium">
                          {
                            appendStepParallelGroupLine(
                              groupStart,
                              stepIndex - 1,
                              groupFailFast
                            ).split(" failFast")[0]
                          }
                        </span>
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                          {" "}
                          failFast {groupFailFast ? "on" : "off"}
                        </span>
                      </td>
                    </tr>
                    {rows}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {params.steps.some((item) =>
            ("parallel" in item ? item.parallel : [item]).some((step) =>
              step.prompt.includes("\n")
            )
          ) && (
            <button
              type="button"
              className="text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
              aria-expanded={promptsExpanded}
              onClick={() =>
                onExpansionChange(
                  TOOL_CALL_EXPANSION_SECTIONS.APPEND_STEP_PROMPTS,
                  !promptsExpanded
                )
              }
            >
              {promptsExpanded ? "Collapse prompts" : "Expand prompts"}
            </button>
          )}
        </div>
      ) : (
        <div className="text-[length:var(--cy-output-font-size-sm)] text-muted-foreground">
          {result.stepsAdded} {result.stepsAdded === 1 ? "step" : "steps"} at{" "}
          {displayIndex(result.insertIndex)}–
          {displayIndex(result.insertedEndIndex)}
        </div>
      )}
      <RawToolCallSection
        server={server}
        tool={tool}
        parameters={parameters}
        result={genericResult}
        paramsFindMatches={paramsFindMatches}
        outputFindMatches={outputFindMatches}
        errorFindMatches={errorFindMatches}
        expansion={expansion}
        onExpansionChange={onExpansionChange}
      />
    </div>
  );
};
