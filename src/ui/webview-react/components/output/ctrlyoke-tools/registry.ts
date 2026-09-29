import {
  MCP_POST_NOTE_TOOL_NAME,
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_CLAIM_PATHS_TOOL_NAME,
  MCP_RELEASE_PATHS_TOOL_NAME,
  MCP_READ_NOTES_TOOL_NAME,
  MCP_WORKFLOW_STATUS_TOOL_NAME,
  MCP_GLOBAL_STATUS_TOOL_NAME,
  MCP_READ_OUTPUT_TOOL_NAME,
  MCP_LIST_HARNESSES_TOOL_NAME,
  type McpToolName,
} from "@root/utils/McpToolDefinitions";
import { MCP_SERVER_IDS } from "@root/types/DashboardConstants";
import type { McpToolCallData } from "../../../types/cliEvents";
import {
  estimateGenericToolCallHeight,
  type ToolCallExpansionState,
} from "../../../utils/toolCallLayout";
import {
  estimatePostNoteHeight,
  parsePostNoteParams,
  parsePostNoteResultText,
  postNoteSearchText,
  postNoteSummary,
  unwrapCtrlYokeToolResultText,
  type PostNoteParams,
  type PostNoteResult,
} from "./postNoteModel";
import {
  appendStepSearchText,
  appendStepSummary,
  estimateAppendStepHeight,
  parseAppendStepParams,
  parseAppendStepResultText,
  type AppendStepParams,
  type AppendStepResult,
} from "./appendStepModel";
import {
  claimPathsSearchText,
  claimPathsSummary,
  estimateClaimPathsHeight,
  parseClaimPathsParams,
  parseClaimPathsResultText,
  type ClaimPathsParams,
  type ClaimPathsResult,
} from "./claimPathsModel";
import {
  releasePathsSearchText,
  releasePathsSummary,
  estimateReleasePathsHeight,
  parseReleasePathsParams,
  parseReleasePathsResultText,
  type ReleasePathsParams,
  type ReleasePathsResult,
} from "./releasePathsModel";
import {
  estimateReadNotesHeight,
  parseReadNotesParams,
  parseReadNotesResultText,
  readNotesSearchText,
  readNotesSummary,
  type ReadNotesParams,
  type ReadNotesResult,
} from "./readNotesModel";
import {
  estimateWorkflowStatusHeight,
  parseWorkflowStatusParams,
  parseWorkflowStatusResultText,
  workflowStatusSearchText,
  workflowStatusSummary,
  type WorkflowStatusParams,
  type WorkflowStatusResult,
} from "./workflowStatusModel";
import {
  estimateGlobalStatusHeight,
  parseGlobalStatusParams,
  parseGlobalStatusResultText,
  globalStatusSearchText,
  globalStatusSummary,
  type GlobalStatusParams,
  type GlobalStatusResult,
} from "./globalStatusModel";
import {
  estimateReadOutputHeight,
  parseReadOutputParams,
  parseReadOutputResultText,
  readOutputSearchText,
  readOutputSummary,
  type ReadOutputParams,
  type ReadOutputResult,
} from "./readOutputModel";
import {
  estimateListHarnessesHeight,
  parseListHarnessesParams,
  parseListHarnessesResultText,
  listHarnessesSearchText,
  listHarnessesSummary,
  type ListHarnessesParams,
  type ListHarnessesResult,
} from "./listHarnessesModel";

export interface CtrlYokeToolView<TParams, TResult> {
  parseParams(raw: unknown): TParams | undefined;
  parseResult(text: string): TResult | undefined;
  summary(params: TParams | undefined, result: TResult): string;
  searchText(params: TParams | undefined, result: TResult): string[];
  estimateHeight(
    params: TParams | undefined,
    result: TResult,
    data: McpToolCallData,
    expansion: ToolCallExpansionState,
    width: number | undefined,
    fontSize: number
  ): number;
  warning?(params: TParams | undefined, result: TResult): boolean;
}

const postNoteView: CtrlYokeToolView<PostNoteParams, PostNoteResult> = {
  parseParams: parsePostNoteParams,
  parseResult: parsePostNoteResultText,
  summary: postNoteSummary,
  searchText: postNoteSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimatePostNoteHeight(
      params,
      result,
      width,
      fontSize,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};

const appendStepView: CtrlYokeToolView<AppendStepParams, AppendStepResult> = {
  parseParams: parseAppendStepParams,
  parseResult: parseAppendStepResultText,
  summary: appendStepSummary,
  searchText: appendStepSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateAppendStepHeight(
      params,
      result,
      width,
      fontSize,
      expansion.appendStepPromptsExpanded,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};

const claimPathsView: CtrlYokeToolView<ClaimPathsParams, ClaimPathsResult> = {
  parseParams: parseClaimPathsParams,
  parseResult: parseClaimPathsResultText,
  summary: claimPathsSummary,
  searchText: claimPathsSearchText,
  warning: (_params, result) => result.denied.length > 0,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateClaimPathsHeight(
      params,
      result,
      width,
      fontSize,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};

const releasePathsView: CtrlYokeToolView<
  ReleasePathsParams,
  ReleasePathsResult
> = {
  parseParams: parseReleasePathsParams,
  parseResult: parseReleasePathsResultText,
  summary: releasePathsSummary,
  searchText: releasePathsSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateReleasePathsHeight(
      params,
      result,
      width,
      fontSize,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};

const readNotesView: CtrlYokeToolView<ReadNotesParams, ReadNotesResult> = {
  parseParams: parseReadNotesParams,
  parseResult: parseReadNotesResultText,
  summary: readNotesSummary,
  searchText: readNotesSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateReadNotesHeight(
      params,
      result,
      width,
      fontSize,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};

const workflowStatusView: CtrlYokeToolView<
  WorkflowStatusParams,
  WorkflowStatusResult
> = {
  parseParams: parseWorkflowStatusParams,
  parseResult: parseWorkflowStatusResultText,
  summary: workflowStatusSummary,
  searchText: workflowStatusSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateWorkflowStatusHeight(
      params,
      result,
      width,
      fontSize,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};
const globalStatusView: CtrlYokeToolView<
  GlobalStatusParams,
  GlobalStatusResult
> = {
  parseParams: parseGlobalStatusParams,
  parseResult: parseGlobalStatusResultText,
  summary: globalStatusSummary,
  searchText: globalStatusSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateGlobalStatusHeight(
      params,
      result,
      width,
      fontSize,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};
const readOutputView: CtrlYokeToolView<ReadOutputParams, ReadOutputResult> = {
  parseParams: parseReadOutputParams,
  parseResult: parseReadOutputResultText,
  summary: readOutputSummary,
  searchText: readOutputSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateReadOutputHeight(
      params,
      result,
      width,
      fontSize,
      expansion.readOutputExpanded,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};
const listHarnessesView: CtrlYokeToolView<
  ListHarnessesParams,
  ListHarnessesResult
> = {
  parseParams: parseListHarnessesParams,
  parseResult: parseListHarnessesResultText,
  summary: listHarnessesSummary,
  searchText: listHarnessesSearchText,
  estimateHeight: (params, result, data, expansion, width, fontSize) =>
    estimateListHarnessesHeight(
      params,
      result,
      width,
      fontSize,
      expansion.listHarnessModelsExpanded,
      expansion.rawExpanded
        ? estimateGenericToolCallHeight(
            data.parameters,
            data.result,
            expansion,
            fontSize,
            width
          )
        : 0
    ),
};

/** Partial registry grows by tool family as later plan stages land. */
export const CTRLYOKE_TOOL_VIEWS: Partial<
  Record<McpToolName, CtrlYokeToolView<unknown, unknown>>
> = {
  [MCP_POST_NOTE_TOOL_NAME]: postNoteView as CtrlYokeToolView<unknown, unknown>,
  [MCP_APPEND_STEP_TOOL_NAME]: appendStepView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_CLAIM_PATHS_TOOL_NAME]: claimPathsView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_RELEASE_PATHS_TOOL_NAME]: releasePathsView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_READ_NOTES_TOOL_NAME]: readNotesView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_WORKFLOW_STATUS_TOOL_NAME]: workflowStatusView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_GLOBAL_STATUS_TOOL_NAME]: globalStatusView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_READ_OUTPUT_TOOL_NAME]: readOutputView as CtrlYokeToolView<
    unknown,
    unknown
  >,
  [MCP_LIST_HARNESSES_TOOL_NAME]: listHarnessesView as CtrlYokeToolView<
    unknown,
    unknown
  >,
};

export interface ResolvedCtrlYokeToolView {
  view: CtrlYokeToolView<unknown, unknown>;
  params: unknown;
  result: unknown;
  summary: string;
  searchText: string[];
  warning: boolean;
}

export function resolveCtrlYokeToolView(
  data: McpToolCallData
): ResolvedCtrlYokeToolView | undefined {
  if (
    data.server !== MCP_SERVER_IDS.CTRLYOKE &&
    data.server !== MCP_SERVER_IDS.CTRLYOKE_COMMIT
  )
    return undefined;
  const view = CTRLYOKE_TOOL_VIEWS[data.tool as McpToolName];
  if (!view || !data.result?.success) return undefined;
  const text = unwrapCtrlYokeToolResultText(data.result);
  if (/^\s*Error\s*:/i.test(text)) return undefined;
  const result = view.parseResult(text);
  if (result === undefined) return undefined;
  const params = view.parseParams(data.parameters);
  return {
    view,
    params,
    result,
    summary: view.summary(params, result),
    searchText: view.searchText(params, result),
    warning: view.warning?.(params, result) ?? false,
  };
}
