import * as fs from "node:fs/promises";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";
import type { RunSummary } from "../types/WorkflowTimelineTypes";
import { withFileLock } from "../utils/FileLockUtils";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import {
  matchRunSelector,
  matchWorkflowSelector,
  parseRunSelector,
  RUN_SELECTOR_MATCH_KINDS,
  WORKFLOW_SELECTOR_MATCH_KINDS,
  type WorkflowLineageLookup,
} from "../core/orchestration/WorkflowRunSelector";

export {
  formatCliStepSelector,
  formatFinalPassSelector,
  formatHistoryTargetSelector,
  matchesHistoryShowStep,
  parseCliStepIndex,
  parseHistoryShowAttempt,
  parseHistoryShowStep,
} from "./CliStepSelector";
export type {
  CliHistoryShowAttemptSelector,
  CliHistoryShowStepSelector,
} from "./CliStepSelector";

/**
 * Resolve one CLI run selector to its durable RunRef exactly once. Numeric
 * selectors are manifest display IDs, never positions in a run list.
 */
export interface CliRunSummaryProvider {
  getRunSummaries(workflowKey: WorkflowKey): Promise<RunSummary[]>;
}

export function createWorkflowLineageNotFoundError(workflowKey: string): Error {
  return new Error(
    `Workflow lineage "${workflowKey}" was not found. Run \`ctrlyoke history list\` to find a lineage key.`
  );
}

export type CliWorkflowLineageProvider = WorkflowLineageLookup;

/**
 * Resolve a lineage key, or a case-insensitive workflow display name or key
 * slug.
 */
export async function resolveCliWorkflowKey(
  workspaceRoot: string,
  lineageRepository: CliWorkflowLineageProvider,
  value: string,
  writeErr: (message: string) => void = (message) => console.error(message)
): Promise<WorkflowKey> {
  const match = await matchWorkflowSelector(
    workspaceRoot,
    lineageRepository,
    value
  );
  if (match.kind === WORKFLOW_SELECTOR_MATCH_KINDS.KEY) {
    return match.workflowKey;
  }
  if (match.kind === WORKFLOW_SELECTOR_MATCH_KINDS.NAME) {
    writeErr(`Using lineage ${match.workflowKey}`);
    return match.workflowKey;
  }
  if (match.kind === WORKFLOW_SELECTOR_MATCH_KINDS.AMBIGUOUS) {
    const candidates = await Promise.all(
      match.workflowKeys.map(async (workflowKey) => {
        const latestRunRef = (
          await lineageRepository.listRunRefs(workspaceRoot, workflowKey)
        )[0];
        const timestamp = latestRunRef
          ? WorkflowPaths.parseRunRefTimestamp(latestRunRef)
          : undefined;
        const latestRunDate = timestamp
          ? new Date(timestamp).toISOString().slice(0, 10)
          : "no runs";
        return `  ${workflowKey} (latest run: ${latestRunDate})`;
      })
    );
    throw new Error(
      `Workflow name "${value}" is ambiguous. Matching lineages:\n${candidates.join("\n")}`
    );
  }
  throw createWorkflowLineageNotFoundError(value);
}

export async function resolveCliRunRef(
  outputHistoryManager: CliRunSummaryProvider,
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

  const parsed = parseRunSelector(selector);
  if (parsed === undefined) {
    throw new Error(
      /^\d+$/.test(selector)
        ? `Invalid ${optionName} run ID "${selector}"`
        : `Invalid ${optionName} selector "${selector}"; provide a run reference or numeric run ID`
    );
  }
  const match = matchRunSelector(summaries, parsed);
  if (match.kind === RUN_SELECTOR_MATCH_KINDS.FOUND) {
    return match.run.runRef;
  }
  if (match.kind === RUN_SELECTOR_MATCH_KINDS.AMBIGUOUS) {
    throw new Error(
      `Ambiguous ${optionName} run ID "${selector}"; use a stable run reference instead`
    );
  }
  throw new Error(
    typeof parsed === "number"
      ? `Run ID "${selector}" was not found in workflow "${workflowKey}"`
      : `Run "${selector}" was not found in workflow "${workflowKey}"`
  );
}

/** Resolve a selector under the lineage metadata lock before any CLI mutation. */
export async function resolveCliRunRefAtLineage(
  workspaceRoot: string,
  outputHistoryManager: CliRunSummaryProvider,
  workflowKey: WorkflowKey,
  selector: string | undefined,
  optionName: "--from" | "--run"
): Promise<RunRef> {
  let lineageStats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    lineageStats = await fs.stat(
      WorkflowPaths.lineageDir(workspaceRoot, workflowKey)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw createWorkflowLineageNotFoundError(workflowKey);
    }
    throw error;
  }
  if (!lineageStats.isDirectory()) {
    throw createWorkflowLineageNotFoundError(workflowKey);
  }

  return withFileLock(
    WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
    () =>
      resolveCliRunRef(outputHistoryManager, workflowKey, selector, optionName)
  );
}
