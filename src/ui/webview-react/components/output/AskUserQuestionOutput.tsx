/**
 * AskUserQuestionOutput — renders an interactive question the AI asked the
 * user mid-turn: every question, its options (with descriptions/preview art),
 * and how it was resolved — a picked option, a freeform typed reply, attached
 * notes, or a decline (asked to clarify / rejected outright).
 *
 * Harness-agnostic: it only depends on the shared `AskUserQuestionData`
 * contract, not on Claude's specific tool shape, so any harness that starts
 * populating the same event type renders through this component unchanged.
 */
import React, { useMemo } from "react";
import type { AskUserQuestionData } from "../../types/cliEvents";
import { OPERATION_STATUS } from "../../types/cliEvents";
import {
  highlightText,
  sliceDecorationMatches,
  type RowFindDecoration,
} from "@utils/outputFind";
import { buildAskUserQuestionSearchSegments } from "@utils/askUserQuestionLayout";
import { ToolCallBlock } from "./ToolCallBlock";
import { ToolDot } from "./FileOperationOutput";
import { TOOL_RESULT_LINE } from "./outputStyles";

interface AskUserQuestionOutputProps {
  data: AskUserQuestionData;
  findDecorations?: RowFindDecoration;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarize(data: AskUserQuestionData): {
  dotStatus: "pending" | "success" | "error";
  headerLabel: string;
} {
  if (data.declined) {
    return {
      dotStatus: "error",
      headerLabel:
        data.declined.reason === "clarify"
          ? "Asked to clarify"
          : "Question declined",
    };
  }
  if (data.status === OPERATION_STATUS.COMPLETED) {
    return {
      dotStatus: "success",
      headerLabel: `Answered ${pluralize(data.questions.length, "question")}`,
    };
  }
  return {
    dotStatus: "pending",
    headerLabel: `Asked ${pluralize(data.questions.length, "question")}`,
  };
}

export const AskUserQuestionOutput: React.FC<AskUserQuestionOutputProps> = ({
  data,
  findDecorations,
}) => {
  const segments = useMemo(
    () => buildAskUserQuestionSearchSegments(data),
    [data]
  );
  const { dotStatus, headerLabel } = summarize(data);

  // Row-level match offsets are only meaningful within their own segment —
  // rebase to the segment first, then again to whichever element within it
  // (question / option label / description / answer / notes) is rendering.
  const localMatches = (
    segmentStart: number | undefined,
    segmentEnd: number | undefined,
    range?: [number, number]
  ): RowFindDecoration["matches"] => {
    if (segmentStart === undefined || segmentEnd === undefined || !range) {
      return [];
    }
    const segmentMatches = sliceDecorationMatches(
      findDecorations,
      segmentStart,
      segmentEnd
    );
    return sliceDecorationMatches(
      { matches: segmentMatches },
      range[0],
      range[1]
    );
  };

  const declinedSegment = segments.find((segment) => segment.field === "error");

  return (
    <ToolCallBlock
      dot={<ToolDot status={dotStatus} />}
      header={
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {headerLabel}
        </span>
      }
    >
      <div className="mt-1 flex flex-col gap-3">
        {data.questions.map((question, questionIndex) => {
          const segment = segments[questionIndex]?.block
            ? segments[questionIndex]
            : undefined;
          const customReply =
            question.answer &&
            !question.options.some((option) => option.label === question.answer)
              ? question.answer
              : undefined;

          return (
            <div
              key={questionIndex}
              className={
                questionIndex > 0
                  ? "border-t border-panel-border/50 pt-3"
                  : undefined
              }
            >
              <div className="text-foreground [overflow-wrap:anywhere]">
                {segment
                  ? highlightText(
                      question.question,
                      localMatches(
                        segment.start,
                        segment.end,
                        segment.block!.questionRange
                      )
                    )
                  : question.question}
              </div>

              {question.options.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {question.options.map((option, optionIndex) => {
                    const isSelected = option.label === question.answer;
                    const optionRange =
                      segment?.block?.optionRanges[optionIndex];
                    return (
                      <div
                        key={optionIndex}
                        className="flex items-start gap-1.5 text-[length:var(--fp-output-font-size-sm)]"
                      >
                        <span
                          className={`shrink-0 mt-px ${
                            isSelected
                              ? "text-indicator-success"
                              : "text-description-fg"
                          }`}
                        >
                          {isSelected ? "✓" : "○"}
                        </span>
                        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          <span
                            className={
                              isSelected
                                ? "text-foreground font-medium"
                                : "text-description-fg"
                            }
                          >
                            {optionRange
                              ? highlightText(
                                  option.label,
                                  localMatches(
                                    segment?.start,
                                    segment?.end,
                                    optionRange.label
                                  )
                                )
                              : option.label}
                          </span>
                          {option.description && (
                            <span className="text-description-fg">
                              {": "}
                              {optionRange?.description
                                ? highlightText(
                                    option.description,
                                    localMatches(
                                      segment?.start,
                                      segment?.end,
                                      optionRange.description
                                    )
                                  )
                                : option.description}
                            </span>
                          )}
                          {isSelected && option.preview && (
                            <pre className="mt-1 whitespace-pre-wrap rounded bg-editor-bg/50 px-2 py-1 text-[length:var(--fp-output-font-size-xs)] text-description-fg [overflow-wrap:anywhere]">
                              {option.preview}
                            </pre>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {customReply && (
                <div
                  className={`${TOOL_RESULT_LINE} mt-1 flex items-start gap-1`}
                >
                  <span className="shrink-0">⎿</span>
                  <span className="min-w-0 flex-1">
                    Reply:{" "}
                    {segment?.block?.answerRange
                      ? highlightText(
                          customReply,
                          localMatches(
                            segment.start,
                            segment.end,
                            segment.block.answerRange
                          )
                        )
                      : customReply}
                  </span>
                </div>
              )}

              {question.notes && (
                <div
                  className={`${TOOL_RESULT_LINE} mt-1 flex items-start gap-1`}
                >
                  <span className="shrink-0">⎿</span>
                  <span className="min-w-0 flex-1">
                    Note:{" "}
                    {segment?.block?.notesRange
                      ? highlightText(
                          question.notes,
                          localMatches(
                            segment.start,
                            segment.end,
                            segment.block.notesRange
                          )
                        )
                      : question.notes}
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {data.declined?.feedback && (
          <div className={`${TOOL_RESULT_LINE} flex items-start gap-1`}>
            <span className="shrink-0">⎿</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap">
              {declinedSegment
                ? highlightText(
                    data.declined.feedback,
                    sliceDecorationMatches(
                      findDecorations,
                      declinedSegment.start,
                      declinedSegment.end
                    )
                  )
                : data.declined.feedback}
            </span>
          </div>
        )}
      </div>
    </ToolCallBlock>
  );
};

AskUserQuestionOutput.displayName = "AskUserQuestionOutput";
