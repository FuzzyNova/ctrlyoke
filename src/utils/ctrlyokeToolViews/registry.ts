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
} from "../McpToolDefinitions";
import { MCP_SERVER_IDS } from "../../types/DashboardConstants";
import type { McpToolCallData } from "../../types/CliOutputTypes";
import { unwrapCtrlYokeToolResultText } from "./shared";
import {
  parsePostNoteParams,
  parsePostNoteResultText,
  postNoteSearchText,
  postNoteSummary,
} from "./postNoteModel";
import {
  appendStepSearchText,
  appendStepSummary,
  parseAppendStepParams,
  parseAppendStepResultText,
} from "./appendStepModel";
import {
  claimPathsSearchText,
  claimPathsSummary,
  parseClaimPathsParams,
  parseClaimPathsResultText,
  type ClaimPathsResult,
} from "./claimPathsModel";
import {
  releasePathsSearchText,
  releasePathsSummary,
  parseReleasePathsParams,
  parseReleasePathsResultText,
} from "./releasePathsModel";
import {
  parseReadNotesParams,
  parseReadNotesResultText,
  readNotesSearchText,
  readNotesSummary,
} from "./readNotesModel";
import {
  parseWorkflowStatusParams,
  parseWorkflowStatusResultText,
  workflowStatusSearchText,
  workflowStatusSummary,
} from "./workflowStatusModel";
import {
  parseGlobalStatusParams,
  parseGlobalStatusResultText,
  globalStatusSearchText,
  globalStatusSummary,
} from "./globalStatusModel";
import {
  parseReadOutputParams,
  parseReadOutputResultText,
  readOutputSearchText,
  readOutputSummary,
} from "./readOutputModel";
import {
  parseListHarnessesParams,
  parseListHarnessesResultText,
  listHarnessesSearchText,
  listHarnessesSummary,
} from "./listHarnessesModel";
import {
  editStepSummary,
  parseEditStepParams,
  parseEditStepResultText,
  editStepSearchText,
  type EditStepParams,
  type EditStepResult,
} from "./editStepModel";
import {
  parseRemoveStepParams,
  parseRemoveStepResultText,
  removeStepSummary,
  removeStepSearchText,
  type RemoveStepParams,
  type RemoveStepResult,
} from "./removeStepModel";
import {
  parseReorderStepsParams,
  parseReorderStepsResultText,
  reorderStepsSummary,
  reorderStepsSearchText,
  type ReorderStepsParams,
  type ReorderStepsResult,
} from "./reorderStepsModel";
import {
  parseSubmitCommitMessageParams,
  parseSubmitCommitMessageResultText,
  commitMessageSummary,
  submitCommitMessageSearchText,
  type SubmitCommitMessageParams,
  type SubmitCommitMessageResult,
} from "./submitCommitMessageModel";

export interface CtrlYokeToolModel<P, R> {
  parseParams(raw: unknown): P | undefined;
  parseResultText(text: string): R | undefined;
  summary(params: P | undefined, result: R): string;
  searchText(params: P | undefined, result: R): string[];
  warning?(params: P | undefined, result: R): boolean;
}

const editStepModel: CtrlYokeToolModel<EditStepParams, EditStepResult> = {
  parseParams: parseEditStepParams,
  parseResultText: parseEditStepResultText,
  summary: editStepSummary,
  searchText: editStepSearchText,
  warning: (_params, result) => result.changed === false,
};
const removeStepModel: CtrlYokeToolModel<RemoveStepParams, RemoveStepResult> = {
  parseParams: parseRemoveStepParams,
  parseResultText: parseRemoveStepResultText,
  summary: removeStepSummary,
  searchText: removeStepSearchText,
  warning: (_params, result) => result.changed === false,
};
const reorderStepsModel: CtrlYokeToolModel<
  ReorderStepsParams,
  ReorderStepsResult
> = {
  parseParams: parseReorderStepsParams,
  parseResultText: parseReorderStepsResultText,
  summary: reorderStepsSummary,
  searchText: reorderStepsSearchText,
  warning: (_params, result) => result.changed === false,
};
const submitCommitMessageModel: CtrlYokeToolModel<
  SubmitCommitMessageParams,
  SubmitCommitMessageResult
> = {
  parseParams: parseSubmitCommitMessageParams,
  parseResultText: parseSubmitCommitMessageResultText,
  summary: (params) => commitMessageSummary(params),
  searchText: submitCommitMessageSearchText,
};

export const CTRLYOKE_TOOL_MODELS: Record<
  McpToolName,
  CtrlYokeToolModel<unknown, unknown>
> = {
  [MCP_POST_NOTE_TOOL_NAME]: {
    parseParams: parsePostNoteParams,
    parseResultText: parsePostNoteResultText,
    summary: postNoteSummary,
    searchText: postNoteSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_APPEND_STEP_TOOL_NAME]: {
    parseParams: parseAppendStepParams,
    parseResultText: parseAppendStepResultText,
    summary: appendStepSummary,
    searchText: appendStepSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_CLAIM_PATHS_TOOL_NAME]: {
    parseParams: parseClaimPathsParams,
    parseResultText: parseClaimPathsResultText,
    summary: claimPathsSummary,
    searchText: claimPathsSearchText,
    warning: (_params, result) =>
      (result as ClaimPathsResult).denied.length > 0,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_RELEASE_PATHS_TOOL_NAME]: {
    parseParams: parseReleasePathsParams,
    parseResultText: parseReleasePathsResultText,
    summary: releasePathsSummary,
    searchText: releasePathsSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_READ_NOTES_TOOL_NAME]: {
    parseParams: parseReadNotesParams,
    parseResultText: parseReadNotesResultText,
    summary: readNotesSummary,
    searchText: readNotesSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_WORKFLOW_STATUS_TOOL_NAME]: {
    parseParams: parseWorkflowStatusParams,
    parseResultText: parseWorkflowStatusResultText,
    summary: workflowStatusSummary,
    searchText: workflowStatusSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_GLOBAL_STATUS_TOOL_NAME]: {
    parseParams: parseGlobalStatusParams,
    parseResultText: parseGlobalStatusResultText,
    summary: globalStatusSummary,
    searchText: globalStatusSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_READ_OUTPUT_TOOL_NAME]: {
    parseParams: parseReadOutputParams,
    parseResultText: parseReadOutputResultText,
    summary: readOutputSummary,
    searchText: readOutputSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_LIST_HARNESSES_TOOL_NAME]: {
    parseParams: parseListHarnessesParams,
    parseResultText: parseListHarnessesResultText,
    summary: listHarnessesSummary,
    searchText: listHarnessesSearchText,
  } as CtrlYokeToolModel<unknown, unknown>,
  [MCP_EDIT_STEP_TOOL_NAME]: editStepModel as CtrlYokeToolModel<
    unknown,
    unknown
  >,
  [MCP_REMOVE_STEP_TOOL_NAME]: removeStepModel as CtrlYokeToolModel<
    unknown,
    unknown
  >,
  [MCP_REORDER_STEPS_TOOL_NAME]: reorderStepsModel as CtrlYokeToolModel<
    unknown,
    unknown
  >,
  [MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME]:
    submitCommitMessageModel as CtrlYokeToolModel<unknown, unknown>,
};

export interface ResolvedCtrlYokeToolModel {
  model: CtrlYokeToolModel<unknown, unknown>;
  params: unknown;
  result: unknown;
  summary: string;
  /** Ordered body text pieces, excluding the separately searched summary. */
  searchText: string[];
  warning: boolean;
}

export function resolveCtrlYokeToolModel(
  data: McpToolCallData
): ResolvedCtrlYokeToolModel | undefined {
  if (
    data.server !== MCP_SERVER_IDS.CTRLYOKE &&
    data.server !== MCP_SERVER_IDS.CTRLYOKE_COMMIT
  )
    return undefined;
  const model = CTRLYOKE_TOOL_MODELS[data.tool as McpToolName];
  if (!model || !data.result?.success) return undefined;
  const text = unwrapCtrlYokeToolResultText(data.result);
  if (/^\s*Error\s*:/i.test(text)) return undefined;
  const result = model.parseResultText(text);
  if (result === undefined) return undefined;
  const params = model.parseParams(data.parameters);
  return {
    model,
    params,
    result,
    summary: model.summary(params, result),
    searchText: model.searchText(params, result).slice(1),
    warning: model.warning?.(params, result) ?? false,
  };
}
