import type { ToolResult } from "../types/cliEvents";

export interface ToolCallExpansionState {
  paramsExpanded: boolean;
  outputExpanded: boolean;
  errorExpanded: boolean;
}

export type ToolCallExpansionSection = "params" | "output" | "error";

export const DEFAULT_TOOL_CALL_EXPANSION_STATE: Readonly<ToolCallExpansionState> =
  Object.freeze({
    paramsExpanded: false,
    outputExpanded: false,
    errorExpanded: false,
  });

export const GENERIC_TOOL_CALL_MAX_RESULT_LINES = 10;

const DEFAULT_OUTPUT_FONT_SIZE = 13;
const TOOL_CALL_SUMMARY_BOTTOM_GAP = 10;
const TOOL_CALL_PARAMS_BOTTOM_GAP = 8;
const TOOL_CALL_RESULT_BOTTOM_GAP = 10;

export interface ToolCallSectionRenderPlan {
  hasContent: boolean;
  canToggle: boolean;
  isExpanded: boolean;
  isTruncated: boolean;
  lineCount: number;
  visibleLineCount: number;
  hiddenLineCount: number;
  height: number;
}

export interface ToolCallRenderPlanInput {
  parameters?: Record<string, unknown>;
  result?: ToolResult;
  expansion?: ToolCallExpansionState;
  outputFontSize?: number;
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
  isOutputTruncated: boolean;
  isErrorTruncated: boolean;
}

export function getGenericToolCallOutput(result?: ToolResult): {
  output?: string;
  error?: string;
} {
  const output =
    typeof result?.output === "string" ? result.output : undefined;
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
    .map(([key, value]) =>
      `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`
    )
    .join("\n");
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function getVisibleResultLineCount(text: string, expanded: boolean): number {
  const lineCount = countLines(text);
  if (expanded) {
    return lineCount;
  }

  return Math.min(lineCount, GENERIC_TOOL_CALL_MAX_RESULT_LINES);
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
    height: 0,
  };
}

function buildResultSectionRenderPlan(
  text: string,
  expanded: boolean,
  sectionLineHeight: number
): ToolCallSectionRenderPlan {
  const lineCount = countLines(text);
  const visibleLineCount = getVisibleResultLineCount(text, expanded);
  const isTruncated = lineCount > GENERIC_TOOL_CALL_MAX_RESULT_LINES;

  return {
    hasContent: true,
    canToggle: isTruncated,
    isExpanded: expanded,
    isTruncated,
    lineCount,
    visibleLineCount,
    hiddenLineCount: Math.max(0, lineCount - visibleLineCount),
    height: visibleLineCount * sectionLineHeight + TOOL_CALL_RESULT_BOTTOM_GAP,
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
  } = input;

  const summaryLineHeight = Math.max(24, outputFontSize * 1.8);
  // 1.85 (not 1.55): profiler data shows actual section height is ~21% taller than
  // the 1.55 estimate (scaleFactor=1.21, n=15). 1.85 gives 24px at font=13 vs prior 20px.
  const sectionLineHeight = Math.max(22, outputFontSize * 1.85);
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
          height:
            countLines(paramsText) * sectionLineHeight + TOOL_CALL_PARAMS_BOTTOM_GAP,
        }
      : buildHiddenSectionRenderPlan(paramsText)
    : getEmptySectionRenderPlan();

  const outputPlan = output
    ? buildResultSectionRenderPlan(
        output,
        expansion.outputExpanded,
        sectionLineHeight
      )
    : getEmptySectionRenderPlan();
  const errorPlan = error
    ? buildResultSectionRenderPlan(error, expansion.errorExpanded, sectionLineHeight)
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
    totalHeight: summaryHeight + params.height + outputPlan.height + errorPlan.height,
    paramsLineCount: params.lineCount,
    outputLineCount: outputPlan.lineCount,
    errorLineCount: errorPlan.lineCount,
    isOutputTruncated: outputPlan.isTruncated,
    isErrorTruncated: errorPlan.isTruncated,
  };
}

export function getVisibleToolCallText(
  text: string,
  section: Pick<ToolCallSectionRenderPlan, "visibleLineCount">
): string {
  if (section.visibleLineCount <= 0) {
    return "";
  }

  return text.split("\n").slice(0, section.visibleLineCount).join("\n");
}

export function estimateGenericToolCallHeight(
  parameters: Record<string, unknown> | undefined,
  result: ToolResult | undefined,
  expansion: ToolCallExpansionState,
  outputFontSize: number
): number {
  return buildToolCallRenderPlan({
    parameters,
    result,
    expansion,
    outputFontSize,
  }).totalHeight;
}
