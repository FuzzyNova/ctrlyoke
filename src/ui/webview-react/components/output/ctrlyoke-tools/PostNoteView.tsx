import React from "react";
import { MarkdownText } from "@components/output/MarkdownText";
import { COORDINATION_UNTRUSTED_LABEL } from "@utils/coordinationPresentation";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import { TOOL_CALL_EXPANSION_SECTIONS } from "@root/types/DashboardConstants";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import type { PostNoteParams, PostNoteResult } from "./postNoteModel";

export interface PostNoteBodyProps {
  params: PostNoteParams | undefined;
  result: PostNoteResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: import("../../../types/cliEvents").ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  noteFindDecorations?: import("@utils/outputFind").RowFindDecoration;
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
}

export const PostNoteBody: React.FC<PostNoteBodyProps> = ({
  params,
  result,
  server,
  tool,
  parameters,
  genericResult,
  expansion,
  onExpansionChange,
  noteFindDecorations,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
}) => (
  <div className="space-y-1">
    <div
      className="whitespace-pre-wrap break-words"
      data-untrusted-content="true"
      aria-label={COORDINATION_UNTRUSTED_LABEL}
    >
      <MarkdownText findDecorations={noteFindDecorations}>
        {result.text}
      </MarkdownText>
    </div>
    <button
      type="button"
      className="text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
      aria-expanded={expansion.rawExpanded ?? false}
      onClick={() => {
        const isOpening = !(expansion.rawExpanded ?? false);
        onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.RAW, isOpening);
        if (isOpening) {
          onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.PARAMS, true);
        }
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
        paramsFindMatches={paramsFindMatches}
        outputFindMatches={outputFindMatches}
        errorFindMatches={errorFindMatches}
        expansion={expansion}
        onExpansionChange={onExpansionChange}
      />
    )}
    {params?.text && !result.text && (
      <span className="sr-only">{params.text}</span>
    )}
  </div>
);
