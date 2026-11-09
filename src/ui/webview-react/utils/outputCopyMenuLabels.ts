/**
 * Labels for the commands that copy step output. A prompt step's "response"
 * is the assistant's text (`StepOutputTextMode.ASSISTANT`); a script step's
 * "output" is its stdout and stderr. "Transcript" is the complete rendered
 * output, including thinking, tool calls, diffs and terminal output.
 */
export const OUTPUT_COPY_MENU_LABELS = {
  /** Step menu: one prompt step's response. */
  COPY_RESPONSE: "Copy Response",
  /** Step menu: one script step's output. */
  COPY_OUTPUT: "Copy Output",
  /** Step menu: one step's transcript. */
  COPY_TRANSCRIPT: "Copy Transcript",
  /** Output menu: every visible step's prompt and response. */
  COPY_ALL_RESPONSES: "Copy All Responses",
  /** Output menu: the response of the prompt step under the pointer. */
  COPY_STEP_RESPONSE: "Copy Step Response",
  /** Output menu: the output of the script step under the pointer. */
  COPY_STEP_OUTPUT: "Copy Step Output",
  /** Output menu: the transcript of the step under the pointer. */
  COPY_STEP_TRANSCRIPT: "Copy Step Transcript",
} as const;

/**
 * The inline button in each step's stats row, which copies the same text as
 * Copy Response / Copy Output. Sentence case to match the rest of the row.
 */
export const OUTPUT_COPY_BUTTON_LABELS = {
  COPY_RESPONSE: "Copy response",
  COPY_OUTPUT: "Copy output",
  COPIED: "Copied",
  COPY_RESPONSE_ARIA_LABEL: "Copy response to clipboard",
  COPY_OUTPUT_ARIA_LABEL: "Copy output to clipboard",
} as const;

export const OUTPUT_COPY_MENU_TITLES = {
  RESPONSE:
    "The assistant's response. Thinking, tool calls and diffs are left out.",
  SCRIPT_OUTPUT: "The script's output (stdout and stderr).",
  TRANSCRIPT:
    "The prompt and everything the step produced: thinking, tool calls and results, diffs, commands and terminal output.",
  SCRIPT_TRANSCRIPT: "The script's command and its output.",
  ALL_RESPONSES:
    "Each visible step's prompt and assistant response. Thinking, tool calls and diffs are left out. Script steps contribute their command and output.",
} as const;

/**
 * Labels and tooltips for one step's copy commands. Prompt steps copy a
 * "response"; script steps have no assistant, so the same command copies
 * their "output" — the same split as the step menu's Copy Prompt / Copy
 * Script.
 */
export function getStepCopyLabels(isScript: boolean) {
  return isScript
    ? {
        menu: OUTPUT_COPY_MENU_LABELS.COPY_OUTPUT,
        outputMenu: OUTPUT_COPY_MENU_LABELS.COPY_STEP_OUTPUT,
        button: OUTPUT_COPY_BUTTON_LABELS.COPY_OUTPUT,
        buttonAriaLabel: OUTPUT_COPY_BUTTON_LABELS.COPY_OUTPUT_ARIA_LABEL,
        title: OUTPUT_COPY_MENU_TITLES.SCRIPT_OUTPUT,
        transcriptTitle: OUTPUT_COPY_MENU_TITLES.SCRIPT_TRANSCRIPT,
      }
    : {
        menu: OUTPUT_COPY_MENU_LABELS.COPY_RESPONSE,
        outputMenu: OUTPUT_COPY_MENU_LABELS.COPY_STEP_RESPONSE,
        button: OUTPUT_COPY_BUTTON_LABELS.COPY_RESPONSE,
        buttonAriaLabel: OUTPUT_COPY_BUTTON_LABELS.COPY_RESPONSE_ARIA_LABEL,
        title: OUTPUT_COPY_MENU_TITLES.RESPONSE,
        transcriptTitle: OUTPUT_COPY_MENU_TITLES.TRANSCRIPT,
      };
}

export function formatCopyAllResponsesLabel(hiddenStepCount: number): string {
  if (hiddenStepCount === 0) return OUTPUT_COPY_MENU_LABELS.COPY_ALL_RESPONSES;
  const steps = hiddenStepCount === 1 ? "step" : "steps";
  return `${OUTPUT_COPY_MENU_LABELS.COPY_ALL_RESPONSES} (${hiddenStepCount} ${steps} hidden)`;
}
