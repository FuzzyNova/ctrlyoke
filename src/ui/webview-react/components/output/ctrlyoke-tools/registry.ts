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
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  type McpToolName,
} from "@root/utils/McpToolDefinitions";
import type { McpToolCallData } from "../../../types/cliEvents";
import {
  CTRLYOKE_TOOL_MODELS,
  resolveCtrlYokeToolModel,
  type CtrlYokeToolModel,
} from "@root/utils/ctrlyokeToolViews/registry";
import {
  estimatePostNoteHeight,
  estimateAppendStepHeight,
  estimateClaimPathsHeight,
  estimateReleasePathsHeight,
  estimateReadNotesHeight,
  estimateWorkflowStatusHeight,
  estimateGlobalStatusHeight,
  estimateReadOutputHeight,
  estimateListHarnessesHeight,
  estimateStepMutationHeight,
} from "./heightEstimators";
import {
  estimateGenericToolCallHeight,
  type ToolCallExpansionState,
} from "../../../utils/toolCallLayout";

export type CtrlYokeToolView<P, R> = CtrlYokeToolModel<P, R> & {
  estimateHeight(
    params: P | undefined,
    result: R,
    data: McpToolCallData,
    expansion: ToolCallExpansionState,
    width: number | undefined,
    fontSize: number
  ): number;
};

function getRawToolCallHeight(
  data: McpToolCallData,
  expansion: ToolCallExpansionState,
  width: number | undefined,
  fontSize: number
): number {
  return expansion.rawExpanded
    ? estimateGenericToolCallHeight(
        data.parameters,
        data.result,
        expansion,
        fontSize,
        width
      )
    : 0;
}

function withHeight(
  tool: McpToolName,
  estimate: (
    params: unknown,
    result: unknown,
    data: McpToolCallData,
    expansion: ToolCallExpansionState,
    width: number | undefined,
    fontSize: number
  ) => number
): CtrlYokeToolView<unknown, unknown> {
  return {
    ...CTRLYOKE_TOOL_MODELS[tool],
    estimateHeight: (params, result, data, expansion, width, fontSize) =>
      estimate(params, result, data, expansion, width, fontSize),
  };
}

export const CTRLYOKE_TOOL_VIEWS: Record<
  McpToolName,
  CtrlYokeToolView<unknown, unknown>
> = {
  [MCP_POST_NOTE_TOOL_NAME]: withHeight(
    MCP_POST_NOTE_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimatePostNoteHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_APPEND_STEP_TOOL_NAME]: withHeight(
    MCP_APPEND_STEP_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateAppendStepHeight(
        params as never,
        result as never,
        width,
        fontSize,
        expansion.appendStepPromptsExpanded,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_CLAIM_PATHS_TOOL_NAME]: withHeight(
    MCP_CLAIM_PATHS_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateClaimPathsHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_RELEASE_PATHS_TOOL_NAME]: withHeight(
    MCP_RELEASE_PATHS_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateReleasePathsHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_READ_NOTES_TOOL_NAME]: withHeight(
    MCP_READ_NOTES_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateReadNotesHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_WORKFLOW_STATUS_TOOL_NAME]: withHeight(
    MCP_WORKFLOW_STATUS_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateWorkflowStatusHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_GLOBAL_STATUS_TOOL_NAME]: withHeight(
    MCP_GLOBAL_STATUS_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateGlobalStatusHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_READ_OUTPUT_TOOL_NAME]: withHeight(
    MCP_READ_OUTPUT_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateReadOutputHeight(
        params as never,
        result as never,
        width,
        fontSize,
        expansion.readOutputExpanded,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_LIST_HARNESSES_TOOL_NAME]: withHeight(
    MCP_LIST_HARNESSES_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateListHarnessesHeight(
        params as never,
        result as never,
        width,
        fontSize,
        expansion.listHarnessModelsExpanded,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_EDIT_STEP_TOOL_NAME]: withHeight(
    MCP_EDIT_STEP_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateStepMutationHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_REMOVE_STEP_TOOL_NAME]: withHeight(
    MCP_REMOVE_STEP_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateStepMutationHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_REORDER_STEPS_TOOL_NAME]: withHeight(
    MCP_REORDER_STEPS_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateStepMutationHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
  [MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME]: withHeight(
    MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
    (params, result, data, expansion, width, fontSize) =>
      estimateStepMutationHeight(
        params as never,
        result as never,
        width,
        fontSize,
        getRawToolCallHeight(data, expansion, width, fontSize)
      )
  ),
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
  const resolved = resolveCtrlYokeToolModel(data);
  if (!resolved) return undefined;
  return {
    view: CTRLYOKE_TOOL_VIEWS[data.tool as McpToolName],
    params: resolved.params,
    result: resolved.result,
    summary: resolved.summary,
    searchText: resolved.searchText,
    warning: resolved.warning,
  };
}
