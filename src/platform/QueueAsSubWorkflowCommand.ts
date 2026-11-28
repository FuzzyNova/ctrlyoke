import type * as vscode from "vscode";
import type { UserFeedbackSink } from "../core/UserFeedbackSink";
import { getErrorMessage } from "../utils/ErrorUtils";
import { saveIfDirty } from "./VsCodeDocuments";

/**
 * What the explorer's "Queue as Sub-workflow" command needs from the
 * orchestrator: the sink an auto-save failure is raised on, and the queue
 * action itself.
 */
export interface SubWorkflowQueueTarget {
  getUserFeedbackSink(): UserFeedbackSink;
  queueSubWorkflowFromFileForPanel(filePath: string): Promise<void>;
}

/**
 * Handler of `ctrlyoke.queueAsSubWorkflowFromContext`: save the chosen file
 * if it has unsaved edits, then queue it as one `type: workflow` step on the
 * workflow the panel is showing. Failures are reported, never thrown, so the
 * explorer command never rejects.
 */
export async function queueAsSubWorkflowFromContext(
  uri: vscode.Uri | undefined,
  orchestrator: SubWorkflowQueueTarget,
  reportError: (message: string) => void
): Promise<void> {
  if (!uri) {
    reportError("No file selected");
    return;
  }
  await saveIfDirty(uri.fsPath, orchestrator.getUserFeedbackSink());
  try {
    await orchestrator.queueSubWorkflowFromFileForPanel(uri.fsPath);
  } catch (error) {
    reportError(`Failed to queue as a sub-workflow: ${getErrorMessage(error)}`);
  }
}
