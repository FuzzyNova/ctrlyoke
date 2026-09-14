/**
 * Workflow naming — pure functions shared between the extension backend
 * (`WorkflowInstance`) and the React webview (`PromptEditor`).
 *
 * Must remain free of `fs`, `vscode`, or any Node.js-specific APIs so it can
 * run in both environments without side effects.
 */

/** Name used when a draft yields no usable words. */
export const EPHEMERAL_PROMPT_WORKFLOW_NAME = "Ephemeral Prompt";

/** How many leading words of a draft become the derived workflow name. */
const WORKFLOW_NAME_WORD_COUNT = 5;

/**
 * Derive a workflow name from a dashboard prompt draft.
 *
 * An explicit prompt name always wins; otherwise the first few
 * alphanumeric-trimmed words of the draft become the name.
 *
 * Both sides call this. The backend uses it to actually name the workflow; the
 * webview uses it to predict that name for the "Run in New Workflow" toast,
 * which is raised on `ACTIVE_WORKFLOW_CHANGED` — before the replay that would
 * carry the real name. Two copies of this would drift into a toast that names
 * the new workflow something the workflow list does not.
 */
export function generateWorkflowNameFromPrompt(
  text: string,
  promptName?: string
): string {
  if (promptName?.trim()) {
    return promptName.trim();
  }

  const cleanWords = text
    .trim()
    .split(/\s+/)
    .slice(0, WORKFLOW_NAME_WORD_COUNT)
    .map((word) => word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
    .filter((word) => word.length > 0);

  return cleanWords.length > 0
    ? cleanWords.join(" ")
    : EPHEMERAL_PROMPT_WORKFLOW_NAME;
}
