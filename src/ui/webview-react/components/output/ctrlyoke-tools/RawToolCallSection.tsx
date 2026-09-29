import React from "react";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import { TOOL_CALL_EXPANSION_SECTIONS } from "@root/types/DashboardConstants";
import type { ToolCallExpansionSection } from "@root/types/DashboardConstants";
import type { McpToolCallData } from "../../../types/cliEvents";
import type { RowFindDecoration } from "../../../utils/outputFind";
import type { ToolCallExpansionState } from "../../../utils/toolCallLayout";

export interface RawToolCallSectionProps {
  server?: string;
  tool?: string;
  parameters?: Record<string, unknown>;
  result?: McpToolCallData["result"];
  data?: McpToolCallData;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
  buttonClassName?: string;
}

export const RawToolCallSection: React.FC<RawToolCallSectionProps> = ({
  server,
  tool,
  parameters,
  result,
  data,
  expansion,
  onExpansionChange,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
  buttonClassName = "text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit",
}) => {
  const resolvedServer = data?.server ?? server ?? "";
  const resolvedTool = data?.tool ?? tool ?? "";
  const resolvedParameters = data?.parameters ?? parameters;
  const resolvedResult = data?.result ?? result;
  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        aria-expanded={expansion.rawExpanded ?? false}
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
          server={resolvedServer}
          tool={resolvedTool}
          parameters={resolvedParameters}
          result={resolvedResult}
          paramsFindMatches={paramsFindMatches}
          outputFindMatches={outputFindMatches}
          errorFindMatches={errorFindMatches}
          expansion={expansion}
          onExpansionChange={onExpansionChange}
        />
      )}
    </>
  );
};
