/**
 * Shared dashboard/backend wording for undo while a run has a step in flight
 * (`IN_FLIGHT_EXECUTION_STATES`). Viewing changes stays available; applying an
 * undo or redo does not, because the harness may still be writing the same
 * files and the step's workspace snapshot is only captured once it finishes.
 */
export const IN_FLIGHT_RUN_UNDO_BLOCKED_MESSAGE =
  "Can't undo or redo while the workflow is running. Stop or pause it first.";

/**
 * Why a mid-run change list can be incomplete: harness file-edit events arrive
 * live, but changes made any other way (shell commands, scripts, generators)
 * are only found by the snapshot comparison taken when a step finishes.
 */
export const IN_FLIGHT_RUN_PARTIAL_CHANGES_MESSAGE =
  "Not every change may be listed yet. Files changed by shell commands or scripts appear when their step finishes.";

/** Shown once the run stops under a dialog that was opened mid-run. */
export const IN_FLIGHT_RUN_REOPEN_TO_UNDO_MESSAGE =
  "The run is no longer in progress. Close and reopen this dialog to undo with the complete list of changes.";
