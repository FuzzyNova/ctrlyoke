/**
 * Labels for the menu items that copy step output. "Response" is the
 * assistant's text (`StepOutputTextMode.ASSISTANT`); "Transcript" is the
 * complete rendered output, including thinking, tool calls, diffs and
 * terminal output.
 */
export const OUTPUT_COPY_MENU_LABELS = {
  /** Step menu: one step's response. */
  COPY_RESPONSE: "Copy Response",
  /** Step menu: one step's transcript. */
  COPY_TRANSCRIPT: "Copy Transcript",
  /** Output menu: every visible step's prompt and response. */
  COPY_ALL_RESPONSES: "Copy All Responses",
  /** Output menu: the response of the step under the pointer. */
  COPY_STEP_RESPONSE: "Copy Step Response",
  /** Output menu: the transcript of the step under the pointer. */
  COPY_STEP_TRANSCRIPT: "Copy Step Transcript",
} as const;

export const OUTPUT_COPY_MENU_TITLES = {
  RESPONSE:
    "The assistant's response. Thinking, tool calls and diffs are left out.",
  TRANSCRIPT:
    "The prompt and everything the step produced: thinking, tool calls and results, diffs, commands and terminal output.",
  ALL_RESPONSES:
    "Each visible step's prompt and assistant response. Thinking, tool calls and diffs are left out.",
} as const;

export function formatCopyAllResponsesLabel(hiddenStepCount: number): string {
  if (hiddenStepCount === 0) return OUTPUT_COPY_MENU_LABELS.COPY_ALL_RESPONSES;
  const steps = hiddenStepCount === 1 ? "step" : "steps";
  return `${OUTPUT_COPY_MENU_LABELS.COPY_ALL_RESPONSES} (${hiddenStepCount} ${steps} hidden)`;
}
