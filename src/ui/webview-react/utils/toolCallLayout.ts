import type { ToolResult } from "../types/cliEvents";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedOutputPreview,
  getCollapsedOutputMaxChars,
} from "./outputTruncation";
import {
  DEFAULT_OUTPUT_FONT_SIZE,
  toolCallLineHeight,
  toolResultLineHeight,
} from "./outputLineMetrics";
import type { ToolCallExpansionSection as SharedToolCallExpansionSection } from "@root/types/DashboardConstants";

export interface ToolCallExpansionState {
  paramsExpanded: boolean;
  outputExpanded: boolean;
  errorExpanded: boolean;
  rawExpanded?: boolean;
  appendStepPromptsExpanded?: boolean;
  readOutputExpanded?: Readonly<Record<string, boolean>>;
  listHarnessModelsExpanded?: boolean;
}

export type ToolCallExpansionSection = SharedToolCallExpansionSection;

export const DEFAULT_TOOL_CALL_EXPANSION_STATE: Readonly<ToolCallExpansionState> =
  Object.freeze({
    paramsExpanded: false,
    outputExpanded: false,
    errorExpanded: false,
    rawExpanded: false,
    appendStepPromptsExpanded: false,
    readOutputExpanded: {},
    listHarnessModelsExpanded: false,
  });

export const GENERIC_TOOL_CALL_MAX_RESULT_LINES =
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;
export const GENERIC_TOOL_CALL_MAX_RESULT_CHARS =
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS;

const TOOL_CALL_SUMMARY_BOTTOM_GAP = 10;
const TOOL_CALL_PARAMS_BOTTOM_GAP = 8;
const TOOL_CALL_RESULT_BOTTOM_GAP = 10;
// outputRow(72) + pl-4(16) + ml-2(8): total horizontal chrome for tool result text
const TOOL_RESULT_HORIZONTAL_CHROME = 96;
// Consolas/Monaco at (fontSize-1): ~0.60 char-width ratio
const TOOL_RESULT_SM_FONT_CHAR_RATIO = 0.6;

export interface ToolCallSectionRenderPlan {
  hasContent: boolean;
  canToggle: boolean;
  isExpanded: boolean;
  isTruncated: boolean;
  lineCount: number;
  visibleLineCount: number;
  hiddenLineCount: number;
  visibleText: string;
  height: number;
}

export interface ToolCallRenderPlanInput {
  parameters?: Record<string, unknown>;
  result?: ToolResult;
  expansion?: ToolCallExpansionState;
  outputFontSize?: number;
  outputContentWidth?: number;
  maxResultLines?: number;
}

export interface ToolCallRenderPlan {
  summaryLineHeight: number;
  summaryHeight: number;
  sectionLineHeight: number;
  params: ToolCallSectionRenderPlan;
  output: ToolCallSectionRenderPlan;
  error: ToolCallSectionRenderPlan;
  paramsHeight: number;
  outputHeight: number;
  errorHeight: number;
  totalHeight: number;
  paramsLineCount: number;
  outputLineCount: number;
  errorLineCount: number;
  maxResultChars: number;
  isOutputTruncated: boolean;
  isErrorTruncated: boolean;
}

export function getGenericToolCallOutput(result?: ToolResult): {
  output?: string;
  error?: string;
} {
  const output = typeof result?.output === "string" ? result.output : undefined;
  const error =
    result != null && !result.success && typeof result.error === "string"
      ? result.error
      : undefined;

  return { output, error };
}

export function getGenericToolCallParamsText(
  parameters?: Record<string, unknown>
): string {
  if (parameters == null || Object.keys(parameters).length === 0) {
    return "";
  }

  return Object.entries(parameters)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`
    )
    .join("\n");
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function buildHiddenSectionRenderPlan(text: string): ToolCallSectionRenderPlan {
  const lineCount = countLines(text);
  return {
    hasContent: true,
    canToggle: true,
    isExpanded: false,
    isTruncated: false,
    lineCount,
    visibleLineCount: 0,
    hiddenLineCount: lineCount,
    visibleText: "",
    height: 0,
  };
}

function buildResultSectionRenderPlan(
  text: string,
  expanded: boolean,
  sectionLineHeight: number,
  outputContentWidth?: number,
  outputFontSize = DEFAULT_OUTPUT_FONT_SIZE,
  maxResultLines = GENERIC_TOOL_CALL_MAX_RESULT_LINES,
  maxResultChars = GENERIC_TOOL_CALL_MAX_RESULT_CHARS
): ToolCallSectionRenderPlan {
  const lineCount = countLines(text);
  const preview = buildCollapsedOutputPreview(text, {
    expanded,
    maxLines: maxResultLines,
    maxChars: maxResultChars,
  });
  // When only 1 line would be hidden, buildCollapsedOutputPreview returns the
  // full text (isTruncated=false). Use expanded || isTruncated so the
  // "[show less]" button is still available when the section is expanded.
  const canToggle = expanded || preview.isTruncated;

  // Count visual lines (with wrapping) when content width is known.
  // Raw countLines() misses wrap-induced lines — output text uses whitespace-pre-wrap
  // with a smaller font (cy-output-font-size-sm = fontSize-1), causing severe underestimates
  // on long-output tool calls (observed: 10 raw lines → 72 visual lines, 1468px delta).
  let visualLineCount = preview.visibleLineCount;
  if (outputContentWidth != null && outputContentWidth > 0) {
    const smFontSize = Math.max(10, outputFontSize - 1);
    const charWidth = Math.max(
      5.5,
      smFontSize * TOOL_RESULT_SM_FONT_CHAR_RATIO
    );
    const availableWidth = Math.max(
      80,
      outputContentWidth - TOOL_RESULT_HORIZONTAL_CHROME
    );
    const charsPerLine = Math.max(8, Math.floor(availableWidth / charWidth));
    visualLineCount = preview.visibleText.split("\n").reduce((total, line) => {
      if (line.length === 0) return total + 1;
      return total + Math.max(1, Math.ceil(line.length / charsPerLine));
    }, 0);
  }

  return {
    hasContent: true,
    canToggle,
    isExpanded: expanded,
    isTruncated: preview.isTruncated,
    lineCount,
    visibleLineCount: preview.visibleLineCount,
    hiddenLineCount: preview.hiddenLineCount,
    visibleText: preview.visibleText,
    height: visualLineCount * sectionLineHeight + TOOL_CALL_RESULT_BOTTOM_GAP,
  };
}

function getEmptySectionRenderPlan(): ToolCallSectionRenderPlan {
  return {
    hasContent: false,
    canToggle: false,
    isExpanded: false,
    isTruncated: false,
    lineCount: 0,
    visibleLineCount: 0,
    hiddenLineCount: 0,
    visibleText: "",
    height: 0,
  };
}

export function buildToolCallRenderPlan(
  input: ToolCallRenderPlanInput
): ToolCallRenderPlan {
  const {
    parameters,
    result,
    expansion = DEFAULT_TOOL_CALL_EXPANSION_STATE,
    outputFontSize = DEFAULT_OUTPUT_FONT_SIZE,
    outputContentWidth,
    maxResultLines,
  } = input;
  const resolvedMaxResultLines =
    maxResultLines ?? GENERIC_TOOL_CALL_MAX_RESULT_LINES;
  const maxResultChars = getCollapsedOutputMaxChars({
    maxLines: resolvedMaxResultLines,
    contentWidth: outputContentWidth,
    outputFontSize: Math.max(10, outputFontSize - 1),
    horizontalChrome: TOOL_RESULT_HORIZONTAL_CHROME,
    charWidthMultiplier: TOOL_RESULT_SM_FONT_CHAR_RATIO,
  });

  const summaryLineHeight = toolCallLineHeight(outputFontSize);
  const sectionLineHeight = toolResultLineHeight(outputFontSize);
  const summaryHeight = summaryLineHeight + TOOL_CALL_SUMMARY_BOTTOM_GAP;
  const paramsText = getGenericToolCallParamsText(parameters);
  const { output, error } = getGenericToolCallOutput(result);

  const params = paramsText
    ? expansion.paramsExpanded
      ? {
          hasContent: true,
          canToggle: true,
          isExpanded: true,
          isTruncated: false,
          lineCount: countLines(paramsText),
          visibleLineCount: countLines(paramsText),
          hiddenLineCount: 0,
          visibleText: paramsText,
          height:
            countLines(paramsText) * sectionLineHeight +
            TOOL_CALL_PARAMS_BOTTOM_GAP,
        }
      : buildHiddenSectionRenderPlan(paramsText)
    : getEmptySectionRenderPlan();

  const outputPlan = output
    ? buildResultSectionRenderPlan(
        output,
        expansion.outputExpanded,
        sectionLineHeight,
        outputContentWidth,
        outputFontSize,
        resolvedMaxResultLines,
        maxResultChars
      )
    : getEmptySectionRenderPlan();
  const errorPlan = error
    ? buildResultSectionRenderPlan(
        error,
        expansion.errorExpanded,
        sectionLineHeight,
        outputContentWidth,
        outputFontSize,
        resolvedMaxResultLines,
        maxResultChars
      )
    : getEmptySectionRenderPlan();

  return {
    summaryLineHeight,
    summaryHeight,
    sectionLineHeight,
    params,
    output: outputPlan,
    error: errorPlan,
    paramsHeight: params.height,
    outputHeight: outputPlan.height,
    errorHeight: errorPlan.height,
    totalHeight:
      summaryHeight + params.height + outputPlan.height + errorPlan.height,
    paramsLineCount: params.lineCount,
    outputLineCount: outputPlan.lineCount,
    errorLineCount: errorPlan.lineCount,
    maxResultChars,
    isOutputTruncated: outputPlan.isTruncated,
    isErrorTruncated: errorPlan.isTruncated,
  };
}

export function getVisibleToolCallText(
  text: string,
  section: Pick<ToolCallSectionRenderPlan, "visibleLineCount" | "visibleText">
): string {
  if (section.visibleText) {
    return section.visibleText;
  }

  if (section.visibleLineCount <= 0) {
    return "";
  }

  return text.split("\n").slice(0, section.visibleLineCount).join("\n");
}

export function estimateGenericToolCallHeight(
  parameters: Record<string, unknown> | undefined,
  result: ToolResult | undefined,
  expansion: ToolCallExpansionState,
  outputFontSize: number,
  outputContentWidth?: number,
  maxResultLines?: number
): number {
  return buildToolCallRenderPlan({
    parameters,
    result,
    expansion,
    outputFontSize,
    outputContentWidth,
    maxResultLines,
  }).totalHeight;
}
