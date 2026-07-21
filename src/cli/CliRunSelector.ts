import { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";
import { withFileLock } from "../utils/FileLockUtils";
import * as WorkflowPaths from "../utils/WorkflowPaths";

/**
 * Resolve one CLI run selector to its durable RunRef exactly once. Numeric
 * selectors are manifest display IDs, never positions in a run list.
 */
export async function resolveCliRunRef(
  outputHistoryManager: OutputHistoryManager,
  workflowKey: WorkflowKey,
  selector: string | undefined,
  optionName: "--from" | "--run"
): Promise<RunRef> {
  const summaries = await outputHistoryManager.getRunSummaries(workflowKey);

  if (selector === undefined) {
    const latest = summaries[0];
    if (!latest) {
      throw new Error(
        `Workflow "${workflowKey}" has no completed or recoverable runs`
      );
    }
    return latest.runRef;
  }

  if (/^\d+$/.test(selector)) {
    const runId = Number(selector);
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw new Error(`Invalid ${optionName} run ID "${selector}"`);
    }
    const matches = summaries.filter((summary) => summary.runId === runId);
    if (matches.length === 1) {
      return matches[0].runRef;
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ${optionName} run ID "${selector}"; use a stable run reference instead`
      );
    }
    throw new Error(
      `Run ID "${selector}" was not found in workflow "${workflowKey}"`
    );
  }

  try {
    WorkflowPaths.assertValidRunRef(selector);
  } catch {
    throw new Error(
      `Invalid ${optionName} selector "${selector}"; provide a run reference or numeric run ID`
    );
  }
  if (summaries.some((summary) => summary.runRef === selector)) {
    return selector;
  }
  throw new Error(
    `Run "${selector}" was not found in workflow "${workflowKey}"`
  );
}

/** Resolve a selector under the lineage metadata lock before any CLI mutation. */
export async function resolveCliRunRefAtLineage(
  workspaceRoot: string,
  outputHistoryManager: OutputHistoryManager,
  workflowKey: WorkflowKey,
  selector: string | undefined,
  optionName: "--from" | "--run"
): Promise<RunRef> {
  return withFileLock(
    WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
    () =>
      resolveCliRunRef(outputHistoryManager, workflowKey, selector, optionName)
  );
}
