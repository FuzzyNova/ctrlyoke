import React from "react";
import {
  ATOMIC_REFERENCE_KINDS,
  TOOL_CALL_EXPANSION_SECTIONS,
} from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { openContextReference } from "@utils/contextReferenceActions";
import { coordinationParticipantAttribution } from "@utils/coordinationPresentation";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { ClaimPathsParams, ClaimPathsResult } from "./claimPathsModel";

export const ClaimPathsBody: React.FC<{
  params?: ClaimPathsParams;
  result: ClaimPathsResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: import("../../../types/cliEvents").ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
}> = ({
  params: _params,
  result,
  server,
  tool,
  parameters,
  genericResult,
  expansion,
  onExpansionChange,
}) => {
  const vscode = getVsCodeApi();
  return (
    <div className="space-y-1">
      {result.granted.length > 0 && (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {result.granted.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-link-fg hover:text-link-active-fg hover:underline font-inherit text-left"
                onClick={() =>
                  openContextReference(
                    { type: ATOMIC_REFERENCE_KINDS.FILE, path },
                    vscode
                  )
                }
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.denied.length > 0 && (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {result.denied.map(({ path, owner }) => (
            <li
              key={`${path}-${owner.participantId}`}
              className="text-warning-fg"
            >
              {path} — denied to {coordinationParticipantAttribution(owner)}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
        aria-expanded={expansion.rawExpanded ?? false}
        onClick={() => {
          const isOpening = !(expansion.rawExpanded ?? false);
          onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.RAW, isOpening);
          if (isOpening)
            onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.PARAMS, true);
        }}
      >
        {expansion.rawExpanded ? "Hide raw" : "Raw"}
      </button>
      {expansion.rawExpanded && (
        <McpToolCallOutput
          server={server}
          tool={tool}
          parameters={parameters}
          result={genericResult}
          expansion={expansion}
          onExpansionChange={onExpansionChange}
        />
      )}
    </div>
  );
};
