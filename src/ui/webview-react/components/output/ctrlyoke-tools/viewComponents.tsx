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
import { MCP_APPEND_STEP_TOOL_NAME } from "@root/utils/McpToolDefinitions";
import { AppendStepBody } from "./AppendStepView";
import type { AppendStepParams, AppendStepResult } from "./appendStepModel";
import {
  MCP_CLAIM_PATHS_TOOL_NAME,
  MCP_RELEASE_PATHS_TOOL_NAME,
  MCP_READ_NOTES_TOOL_NAME,
  MCP_WORKFLOW_STATUS_TOOL_NAME,
  MCP_GLOBAL_STATUS_TOOL_NAME,
  MCP_READ_OUTPUT_TOOL_NAME,
  MCP_LIST_HARNESSES_TOOL_NAME,
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
} from "@root/utils/McpToolDefinitions";
import { ClaimPathsBody } from "./ClaimPathsView";
import type { ClaimPathsParams, ClaimPathsResult } from "./claimPathsModel";
import { ReleasePathsBody } from "./ReleasePathsView";
import type {
  ReleasePathsParams,
  ReleasePathsResult,
} from "./releasePathsModel";
import { ReadNotesBody } from "./ReadNotesView";
import type { ReadNotesParams, ReadNotesResult } from "./readNotesModel";
import { WorkflowStatusBody } from "./WorkflowStatusView";
import { GlobalStatusBody } from "./GlobalStatusView";
import { ReadOutputBody } from "./ReadOutputView";
import { ListHarnessesBody } from "./ListHarnessesView";
import {
  EditStepBody,
  RemoveStepBody,
  ReorderStepsBody,
  SubmitCommitMessageBody,
} from "./StepMutationViews";

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
  findQuery?: string;
  findCaseSensitive?: boolean;
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  bodyFindMatches?: RowFindDecoration["matches"];
  bodyFindDecorations?: RowFindDecoration[];
  errorFindMatches?: RowFindDecoration["matches"];
}

const PostNoteBodyAdapter: React.FC<CtrlYokeToolBodyProps> = ({
  params,
  result,
  data,
  expansion,
  onExpansionChange,
  findDecorations,
  findQuery,
  findCaseSensitive,
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
    findQuery={findQuery}
    findCaseSensitive={findCaseSensitive}
    paramsFindMatches={paramsFindMatches}
    outputFindMatches={outputFindMatches}
    errorFindMatches={errorFindMatches}
  />
);

const AppendStepBodyAdapter: React.FC<CtrlYokeToolBodyProps> = ({
  params,
  result,
  data,
  expansion,
  onExpansionChange,
  paramsFindMatches,
  outputFindMatches,
  bodyFindMatches,
  errorFindMatches,
}) => (
  <AppendStepBody
    params={params as AppendStepParams | undefined}
    result={result as AppendStepResult}
    server={data.server}
    tool={data.tool}
    parameters={data.parameters}
    genericResult={data.result}
    expansion={expansion}
    onExpansionChange={onExpansionChange}
    paramsFindMatches={paramsFindMatches}
    outputFindMatches={outputFindMatches}
    bodyFindMatches={bodyFindMatches}
    errorFindMatches={errorFindMatches}
  />
);

const ClaimPathsBodyAdapter: React.FC<CtrlYokeToolBodyProps> = (props) => (
  <ClaimPathsBody
    params={props.params as ClaimPathsParams | undefined}
    result={props.result as ClaimPathsResult}
    server={props.data.server}
    tool={props.data.tool}
    parameters={props.data.parameters}
    genericResult={props.data.result}
    expansion={props.expansion}
    onExpansionChange={props.onExpansionChange}
  />
);

const ReleasePathsBodyAdapter: React.FC<CtrlYokeToolBodyProps> = (props) => (
  <ReleasePathsBody
    params={props.params as ReleasePathsParams | undefined}
    result={props.result as ReleasePathsResult}
    server={props.data.server}
    tool={props.data.tool}
    parameters={props.data.parameters}
    genericResult={props.data.result}
    expansion={props.expansion}
    onExpansionChange={props.onExpansionChange}
  />
);

const ReadNotesBodyAdapter: React.FC<CtrlYokeToolBodyProps> = (props) => (
  <ReadNotesBody
    params={props.params as ReadNotesParams | undefined}
    result={props.result as ReadNotesResult}
    server={props.data.server}
    tool={props.data.tool}
    parameters={props.data.parameters}
    genericResult={props.data.result}
    expansion={props.expansion}
    onExpansionChange={props.onExpansionChange}
    bodyFindDecorations={props.bodyFindDecorations}
    findQuery={props.findQuery}
    findCaseSensitive={props.findCaseSensitive}
  />
);

/** React bodies stay separate from the pure parsing/search/height registry. */
export const CTRLYOKE_TOOL_VIEW_BODIES: Record<
  McpToolName,
  React.ComponentType<CtrlYokeToolBodyProps>
> = {
  [MCP_POST_NOTE_TOOL_NAME]: PostNoteBodyAdapter,
  [MCP_APPEND_STEP_TOOL_NAME]: AppendStepBodyAdapter,
  [MCP_CLAIM_PATHS_TOOL_NAME]: ClaimPathsBodyAdapter,
  [MCP_RELEASE_PATHS_TOOL_NAME]: ReleasePathsBodyAdapter,
  [MCP_READ_NOTES_TOOL_NAME]: ReadNotesBodyAdapter,
  [MCP_WORKFLOW_STATUS_TOOL_NAME]: WorkflowStatusBody,
  [MCP_GLOBAL_STATUS_TOOL_NAME]: GlobalStatusBody,
  [MCP_READ_OUTPUT_TOOL_NAME]: ReadOutputBody,
  [MCP_LIST_HARNESSES_TOOL_NAME]: ListHarnessesBody,
  [MCP_EDIT_STEP_TOOL_NAME]: EditStepBody,
  [MCP_REMOVE_STEP_TOOL_NAME]: RemoveStepBody,
  [MCP_REORDER_STEPS_TOOL_NAME]: ReorderStepsBody,
  [MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME]: SubmitCommitMessageBody,
};
