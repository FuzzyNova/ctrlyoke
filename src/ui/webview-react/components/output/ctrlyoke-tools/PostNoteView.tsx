import React from "react";
import type { ToolResult } from "../../../types/cliEvents";
import type { RowFindDecoration } from "@utils/outputFind";
import { MarkdownText } from "@components/output/MarkdownText";
import { COORDINATION_UNTRUSTED_LABEL } from "@utils/coordinationPresentation";
import { RawToolCallSection } from "./RawToolCallSection";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { PostNoteParams, PostNoteResult } from "./postNoteModel";

export interface PostNoteBodyProps {
  params: PostNoteParams | undefined;
  result: PostNoteResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  noteFindDecorations?: RowFindDecoration;
  findQuery?: string;
  findCaseSensitive?: boolean;
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
  findQuery,
  findCaseSensitive,
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
      <MarkdownText
        findDecorations={noteFindDecorations}
        highlightQuery={findQuery}
        highlightCaseSensitive={findCaseSensitive}
        highlightActiveIndex={
          noteFindDecorations?.matches.findIndex((match) => match.active) ?? -1
        }
      >
        {result.text}
      </MarkdownText>
    </div>
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
    {params?.text && !result.text && (
      <span className="sr-only">{params.text}</span>
    )}
  </div>
);
