import {
  MCP_POST_NOTE_TOOL_NAME,
  MCP_APPEND_STEP_TOOL_NAME,
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

/** Partial registry grows by tool family as later plan stages land. */
export const CTRLYOKE_TOOL_VIEWS: Partial<
  Record<McpToolName, CtrlYokeToolView<unknown, unknown>>
> = {
  [MCP_POST_NOTE_TOOL_NAME]: postNoteView as CtrlYokeToolView<unknown, unknown>,
  [MCP_APPEND_STEP_TOOL_NAME]: appendStepView as CtrlYokeToolView<
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
  };
}
