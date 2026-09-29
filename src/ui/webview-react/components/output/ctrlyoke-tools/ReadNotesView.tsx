import React from "react";
import {
  COORDINATION_ENTRY_KINDS,
  TOOL_CALL_EXPANSION_SECTIONS,
} from "@root/types/DashboardConstants";
import { COORDINATION_UNTRUSTED_LABEL } from "@utils/coordinationPresentation";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import { MarkdownText } from "@components/output/MarkdownText";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import type { ReadNotesParams, ReadNotesResult } from "./readNotesModel";
import { readNotesEntryText } from "./readNotesModel";

export const ReadNotesBody: React.FC<{
  params?: ReadNotesParams;
  result: ReadNotesResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: import("../../../types/cliEvents").ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  findDecorations?: RowFindDecoration;
}> = ({
  params: _params,
  result,
  server,
  tool,
  parameters,
  genericResult,
  expansion,
  onExpansionChange,
  findDecorations,
}) => (
  <div className="space-y-2">
    <ol className="m-0 list-none space-y-2 p-0">
      {result.entries.map((entry) => (
        <li key={entry.seq}>
          <div className="font-medium">{readNotesEntryText(entry)}</div>
          {entry.kind === COORDINATION_ENTRY_KINDS.NOTE &&
            entry.text !== undefined && (
              <div
                className="whitespace-pre-wrap break-words"
                data-untrusted-content="true"
                aria-label={COORDINATION_UNTRUSTED_LABEL}
              >
                <MarkdownText findDecorations={findDecorations}>
                  {entry.text}
                </MarkdownText>
              </div>
            )}
        </li>
      ))}
    </ol>
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
