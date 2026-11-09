/**
 * The messages behind `IDashboardProvider`'s workflow-registry notifications.
 *
 * Every dashboard client (the VS Code panel through `DashboardApplication`
 * and browser tabs through `CtrlYokeHostedServer`) sends the same payload for
 * each notification. Build it here so the two transports cannot drift.
 */
import type {
  CoordinationScopeSnapshot,
  ParallelGroupDefinition,
  WorkflowStep,
  WorkflowSummary,
} from "../types/CtrlYokeTypes";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  CliOutput,
  CliWatchOutputMessage,
  CoordinationScopeUpdatedMessage,
  StepsExtendedMessage,
  WorkflowAddedMessage,
  WorkflowDismissedMessage,
  WorkflowSummaryUpdatedMessage,
} from "../types/WebviewMessageTypes";

export function workflowAddedMessage(
  summary: WorkflowSummary
): WorkflowAddedMessage {
  return { type: MESSAGE_TYPES.WORKFLOW_ADDED, summary };
}

export function workflowDismissedMessage(
  workflowId: string
): WorkflowDismissedMessage {
  return { type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId };
}

export function workflowSummaryUpdatedMessage(
  summary: WorkflowSummary
): WorkflowSummaryUpdatedMessage {
  return { type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary };
}

export function coordinationScopeUpdatedMessage(
  scope: CoordinationScopeSnapshot
): CoordinationScopeUpdatedMessage {
  return { type: MESSAGE_TYPES.COORDINATION_SCOPE_UPDATED, scope };
}

export function cliWatchOutputMessage(
  workflowId: string,
  stepIndex: number,
  output: CliOutput,
  prompt?: string
): CliWatchOutputMessage {
  return {
    type: MESSAGE_TYPES.CLI_WATCH_OUTPUT,
    workflowId,
    stepIndex,
    output,
    ...(prompt ? { prompt } : {}),
  };
}

/** A CLI-managed workflow appended steps to its queue. */
export function cliPromptsExtendedMessage(
  workflowId: string,
  steps: WorkflowStep[],
  definitionRevision?: number,
  parallelGroups?: ParallelGroupDefinition[]
): StepsExtendedMessage {
  return {
    type: MESSAGE_TYPES.STEPS_EXTENDED,
    workflowId,
    steps,
    ...(definitionRevision !== undefined ? { definitionRevision } : {}),
    ...(parallelGroups !== undefined ? { parallelGroups } : {}),
  };
}
