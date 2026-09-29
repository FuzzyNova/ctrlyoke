import React from "react";
import {
  MCP_POST_NOTE_TOOL_NAME,
  type McpToolName,
} from "@root/utils/McpToolDefinitions";
import type { ToolCallExpansionSection } from "@root/types/DashboardConstants";
import type { McpToolCallData } from "../../../types/cliEvents";
import type { RowFindDecoration } from "../../../utils/outputFind";
import type { ToolCallExpansionState } from "../../../utils/toolCallLayout";
import { PostNoteBody } from "./PostNoteView";
import type { PostNoteParams, PostNoteResult } from "./postNoteModel";

export interface CtrlYokeToolBodyProps {
  params: unknown;
  result: unknown;
  data: McpToolCallData;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  findDecorations?: RowFindDecoration;
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
}

const PostNoteBodyAdapter: React.FC<CtrlYokeToolBodyProps> = ({
  params,
  result,
  data,
  expansion,
  onExpansionChange,
  findDecorations,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
}) => (
  <PostNoteBody
    params={params as PostNoteParams | undefined}
    result={result as PostNoteResult}
    server={data.server}
    tool={data.tool}
    parameters={data.parameters}
    genericResult={data.result}
    expansion={expansion}
    onExpansionChange={onExpansionChange}
    noteFindDecorations={findDecorations}
    paramsFindMatches={paramsFindMatches}
    outputFindMatches={outputFindMatches}
    errorFindMatches={errorFindMatches}
  />
);

/** React bodies stay separate from the pure parsing/search/height registry. */
export const CTRLYOKE_TOOL_VIEW_BODIES: Partial<
  Record<McpToolName, React.ComponentType<CtrlYokeToolBodyProps>>
> = {
  [MCP_POST_NOTE_TOOL_NAME]: PostNoteBodyAdapter,
};
