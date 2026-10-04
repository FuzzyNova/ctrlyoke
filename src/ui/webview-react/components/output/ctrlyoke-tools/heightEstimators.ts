import { DIFF_VIEW_TYPES } from "@root/types/DashboardConstants";
import { COORDINATION_ENTRY_KINDS } from "@root/types/DashboardConstants";
import { toRdvFromContent, buildDiffRenderPlan } from "@utils/rdvAdapter";
import {
  appendStepHarnessModelLabel,
  appendStepPromptPreview,
  type AppendStepParams,
  type AppendStepResult,
} from "@root/utils/ctrlyokeToolViews/appendStepModel";
import {
  claimPathsSearchText,
  type ClaimPathsParams,
  type ClaimPathsResult,
} from "@root/utils/ctrlyokeToolViews/claimPathsModel";
import {
  globalStatusSearchText,
  type GlobalStatusParams,
  type GlobalStatusResult,
} from "@root/utils/ctrlyokeToolViews/globalStatusModel";
import {
  allHarnesses,
  type ListHarnessesParams,
  type ListHarnessesResult,
} from "@root/utils/ctrlyokeToolViews/listHarnessesModel";
import {
  postNoteSummary,
  type PostNoteParams,
  type PostNoteResult,
} from "@root/utils/ctrlyokeToolViews/postNoteModel";
import {
  readNotesSearchText,
  type ReadNotesParams,
  type ReadNotesResult,
} from "@root/utils/ctrlyokeToolViews/readNotesModel";
import {
  readOutputHeading,
  type ReadOutputParams,
  type ReadOutputResult,
} from "@root/utils/ctrlyokeToolViews/readOutputModel";
import {
  releasePathsSearchText,
  type ReleasePathsParams,
  type ReleasePathsResult,
} from "@root/utils/ctrlyokeToolViews/releasePathsModel";
import {
  editStepSearchText,
  type EditStepParams,
  type EditStepResult,
} from "@root/utils/ctrlyokeToolViews/editStepModel";
import {
  removeStepSearchText,
  type RemoveStepParams,
  type RemoveStepResult,
} from "@root/utils/ctrlyokeToolViews/removeStepModel";
import {
  reorderStepsSearchText,
  type ReorderStepsParams,
  type ReorderStepsResult,
} from "@root/utils/ctrlyokeToolViews/reorderStepsModel";
import {
  submitCommitMessageSearchText,
  type SubmitCommitMessageParams,
  type SubmitCommitMessageResult,
} from "@root/utils/ctrlyokeToolViews/submitCommitMessageModel";
import {
  workflowStatusRowLine,
  type WorkflowStatusParams,
  type WorkflowStatusResult,
} from "@root/utils/ctrlyokeToolViews/workflowStatusModel";
import { wrappedTextLines } from "./shared";

export function estimatePostNoteHeight(
  params: PostNoteParams | undefined,
  result: PostNoteResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const text = `${postNoteSummary(params, result)}\n${result.text}`;
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const lines = text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
  return 34 + lines * fontSize * 1.55 + (result.text ? 10 : 0) + rawHeight;
}

function appendWrappedLines(
  text: string,
  width: number,
  fontSize: number
): number {
  return wrappedTextLines(text, width, fontSize, 12);
}

export function estimateAppendStepHeight(
  params: AppendStepParams | undefined,
  result: AppendStepResult,
  width: number | undefined,
  fontSize: number,
  promptsExpanded = false,
  rawHeight = 0
): number {
  const availableWidth = Math.max(160, width ?? 640);
  let height = 38;
  if (params) {
    for (const item of params.steps) {
      const grouped = "parallel" in item;
      const steps = grouped ? item.parallel : [item];
      if (grouped) height += 30;
      for (const step of steps) {
        const prompt = promptsExpanded
          ? step.prompt
          : appendStepPromptPreview(step);
        const detail = `#${result.insertIndex + 1} ${step.name ?? "Step"} ${appendStepHarnessModelLabel(step)}`;
        height +=
          Math.max(1, appendWrappedLines(detail, availableWidth, fontSize)) *
          fontSize *
          1.55;
        height +=
          Math.max(1, appendWrappedLines(prompt, availableWidth, fontSize)) *
          fontSize *
          1.45;
        height += 12;
      }
    }
  }
  return height + rawHeight;
}

export function estimateClaimPathsHeight(
  _params: ClaimPathsParams | undefined,
  result: ClaimPathsResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const text = claimPathsSearchText(undefined, result);
  const lines = text.reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
    0
  );
  return 34 + lines * fontSize * 1.55 + rawHeight;
}

export function estimateReleasePathsHeight(
  _params: ReleasePathsParams | undefined,
  result: ReleasePathsResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const lines = releasePathsSearchText(undefined, result).reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
    0
  );
  return 34 + lines * fontSize * 1.55 + rawHeight;
}

export function estimateReadNotesHeight(
  _params: ReadNotesParams | undefined,
  result: ReadNotesResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const charsPerLine = Math.max(
    24,
    Math.floor((width ?? 640) / (fontSize * 0.58))
  );
  const lines = readNotesSearchText(undefined, result).reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
    0
  );
  const bodyLines = result.entries.reduce(
    (total, entry) =>
      total +
      (entry.kind === COORDINATION_ENTRY_KINDS.NOTE && entry.text
        ? Math.max(1, Math.ceil(entry.text.length / charsPerLine))
        : 0),
    0
  );
  return 34 + (lines + bodyLines) * fontSize * 1.55 + rawHeight;
}

function workflowWrappedLines(
  text: string,
  width: number,
  fontSize: number
): number {
  return wrappedTextLines(text, width, fontSize, 16);
}

export function estimateWorkflowStatusHeight(
  _params: WorkflowStatusParams | undefined,
  result: WorkflowStatusResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const available = Math.max(160, width ?? 640);
  const tableLines = result.steps.reduce(
    (sum, step) =>
      sum +
      workflowWrappedLines(
        workflowStatusRowLine(step, result),
        available,
        fontSize
      ),
    0
  );
  const warnings = result.schemaWarnings.reduce(
    (sum, warning) =>
      sum + workflowWrappedLines(warning.message, available, fontSize),
    0
  );
  return (
    72 +
    result.steps.length * 10 +
    tableLines * fontSize * 1.45 +
    warnings * fontSize * 1.45 +
    rawHeight
  );
}

function globalWrappedLines(
  text: string,
  width: number,
  fontSize: number
): number {
  const chars = Math.max(16, Math.floor(width / (fontSize * 0.58)));
  return text
    .split("\n")
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / chars)), 0);
}

export function estimateGlobalStatusHeight(
  _params: GlobalStatusParams | undefined,
  result: GlobalStatusResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const available = Math.max(160, width ?? 640);
  const rows = globalStatusSearchText(undefined, result)[1]
    .split("\n")
    .reduce(
      (sum, line) => sum + globalWrappedLines(line, available, fontSize),
      0
    );
  return 52 + rows * fontSize * 1.5 + rawHeight;
}

function outputWrappedLines(
  text: string,
  width: number,
  fontSize: number
): number {
  const chars = Math.max(20, Math.floor(width / (fontSize * 0.58)));
  return text
    .split("\n")
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / chars)),
      0
    );
}

export function estimateReadOutputHeight(
  _params: ReadOutputParams | undefined,
  result: ReadOutputResult,
  width: number | undefined,
  fontSize: number,
  expanded: Readonly<Record<string, boolean>> = {},
  rawHeight = 0
): number {
  const available = Math.max(160, width ?? 640);
  const body = result.outputs.reduce(
    (sum, output) =>
      sum +
      outputWrappedLines(readOutputHeading(output), available, fontSize) *
        fontSize *
        1.45 +
      (expanded[String(output.index)] && output.responseText
        ? outputWrappedLines(output.responseText, available, fontSize) *
          fontSize *
          1.45
        : 24),
    0
  );
  return (
    38 +
    body +
    (result.outputs.some((output) => !!output.nextCursor)
      ? fontSize * 1.5
      : 0) +
    rawHeight
  );
}

export function estimateListHarnessesHeight(
  _params: ListHarnessesParams | undefined,
  result: ListHarnessesResult,
  width: number | undefined,
  fontSize: number,
  modelsExpanded = false,
  rawHeight = 0
): number {
  const availableWidth = Math.max(160, width ?? 640);
  const chips = allHarnesses(result).map((harness) =>
    Math.ceil(
      `${harness.displayName} · ${harness.available ? "available" : "unavailable"}`
        .length *
        fontSize *
        0.58 +
        32
    )
  );
  let rows = 1;
  let rowWidth = 0;
  for (const chipWidth of chips) {
    if (rowWidth > 0 && rowWidth + chipWidth > availableWidth) {
      rows++;
      rowWidth = 0;
    }
    rowWidth += chipWidth + 8;
  }
  const models = modelsExpanded
    ? result.harnesses.reduce(
        (total, harness) => total + (harness.models?.length ?? 0),
        0
      )
    : 0;
  return 38 + rows * fontSize * 1.8 + models * fontSize * 1.4 + rawHeight;
}

type StepMutationParams =
  | EditStepParams
  | RemoveStepParams
  | ReorderStepsParams
  | SubmitCommitMessageParams;
type StepMutationResult =
  | EditStepResult
  | RemoveStepResult
  | ReorderStepsResult
  | SubmitCommitMessageResult;

function mutationWrappedLines(
  text: string,
  width: number,
  fontSize: number
): number {
  return wrappedTextLines(text, width, fontSize, 12);
}

export function estimateStepMutationHeight(
  params: StepMutationParams | undefined,
  result: StepMutationResult,
  width: number | undefined,
  fontSize: number,
  rawHeight = 0
): number {
  const availableWidth = Math.max(160, width ?? 640);
  const text =
    "clearProperties" in result
      ? editStepSearchText(
          params && "updates" in params ? params : undefined,
          result
        )
      : "indices" in result
        ? reorderStepsSearchText(
            params && "indices" in params ? params : undefined,
            result
          )
        : "index" in result || (params && "index" in params)
          ? removeStepSearchText(
              params && "index" in params ? params : undefined,
              result as RemoveStepResult
            )
          : submitCommitMessageSearchText(
              params && "message" in params ? params : undefined
            );
  let height =
    38 +
    text.reduce(
      (sum, line) =>
        sum +
        mutationWrappedLines(line, availableWidth, fontSize) * fontSize * 1.5,
      0
    );
  if ("clearProperties" in result) {
    const prompt =
      params && "updates" in params
        ? params.updates.prompt
        : result.updates?.prompt;
    if (typeof prompt === "string") {
      const oldPrompt =
        typeof result.before?.prompt === "string" ? result.before.prompt : "";
      const hunks = toRdvFromContent(oldPrompt, prompt).hunks;
      height += buildDiffRenderPlan(hunks, {
        viewType: DIFF_VIEW_TYPES.UNIFIED,
        outputFontSize: fontSize,
        outputContentWidth: availableWidth,
      }).totalHeight;
    }
  }
  if ("message" in (params ?? {}))
    height +=
      mutationWrappedLines(
        (params as SubmitCommitMessageParams).message,
        availableWidth,
        fontSize
      ) *
        fontSize *
        1.55 +
      8;
  return height + rawHeight;
}
