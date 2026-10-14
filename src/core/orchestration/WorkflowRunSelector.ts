import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

/**
 * Human-typed workflow and run selectors, shared by the CLI's history commands
 * and `priorContext: { workflow, run }`. A workflow selector is a lineage key,
 * a workflow name, or a key's slug; a run selector is a run's display number or
 * its stable `RunRef`.
 */
export interface WorkflowLineageLookup {
  listLineageKeys(workspaceRoot: string): Promise<WorkflowKey[]>;
  listRunRefs(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<RunRef[]>;
  tryReadDescriptor(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowLineageDescriptor | undefined>;
}

export const WORKFLOW_SELECTOR_MATCH_KINDS = {
  KEY: "key",
  NAME: "name",
  AMBIGUOUS: "ambiguous",
  NOT_FOUND: "notFound",
} as const;

export type WorkflowSelectorMatch =
  | {
      kind:
        | typeof WORKFLOW_SELECTOR_MATCH_KINDS.KEY
        | typeof WORKFLOW_SELECTOR_MATCH_KINDS.NAME;
      workflowKey: WorkflowKey;
    }
  | {
      kind: typeof WORKFLOW_SELECTOR_MATCH_KINDS.AMBIGUOUS;
      workflowKeys: WorkflowKey[];
    }
  | { kind: typeof WORKFLOW_SELECTOR_MATCH_KINDS.NOT_FOUND };

/**
 * True when `selector` names this lineage by its display name or its key's
 * slug, ignoring case. An exact key is checked separately because it always
 * wins over a name.
 */
export function selectorNamesLineage(
  selector: string,
  workflowKey: WorkflowKey,
  workflowName: string | undefined
): boolean {
  const normalized = selector.toLowerCase();
  return (
    workflowName?.toLowerCase() === normalized ||
    WorkflowPaths.workflowNameFromKey(workflowKey).toLowerCase() === normalized
  );
}

/** Resolve a workflow selector; an exact key wins over any name match. */
export async function matchWorkflowSelector(
  workspaceRoot: string,
  lineages: WorkflowLineageLookup,
  selector: string
): Promise<WorkflowSelectorMatch> {
  const keys = await lineages.listLineageKeys(workspaceRoot);
  if (keys.includes(selector as WorkflowKey)) {
    return {
      kind: WORKFLOW_SELECTOR_MATCH_KINDS.KEY,
      workflowKey: selector as WorkflowKey,
    };
  }

  const descriptors = await Promise.all(
    keys.map(async (workflowKey) => ({
      workflowKey,
      descriptor: await lineages.tryReadDescriptor(workspaceRoot, workflowKey),
    }))
  );
  const matches = descriptors
    .filter(({ workflowKey, descriptor }) =>
      selectorNamesLineage(selector, workflowKey, descriptor?.workflowName)
    )
    .map(({ workflowKey }) => workflowKey);

  if (matches.length === 1) {
    return {
      kind: WORKFLOW_SELECTOR_MATCH_KINDS.NAME,
      workflowKey: matches[0],
    };
  }
  if (matches.length > 1) {
    return {
      kind: WORKFLOW_SELECTOR_MATCH_KINDS.AMBIGUOUS,
      workflowKeys: matches,
    };
  }
  return { kind: WORKFLOW_SELECTOR_MATCH_KINDS.NOT_FOUND };
}

/** A run's display number or its stable reference. */
export type RunSelector = number | RunRef;

/** Parse typed text as a run selector, or undefined when it is neither form. */
export function parseRunSelector(text: string): RunSelector | undefined {
  if (/^\d+$/.test(text)) {
    const runId = Number(text);
    return Number.isSafeInteger(runId) && runId > 0 ? runId : undefined;
  }
  try {
    WorkflowPaths.assertValidRunRef(text);
    return text;
  } catch {
    return undefined;
  }
}

export const RUN_SELECTOR_MATCH_KINDS = {
  FOUND: "found",
  AMBIGUOUS: "ambiguous",
  NOT_FOUND: "notFound",
} as const;

export type RunSelectorMatch<T> =
  | { kind: typeof RUN_SELECTOR_MATCH_KINDS.FOUND; run: T }
  | { kind: typeof RUN_SELECTOR_MATCH_KINDS.AMBIGUOUS }
  | { kind: typeof RUN_SELECTOR_MATCH_KINDS.NOT_FOUND };

/**
 * Find the run a selector names. A number is the manifest's display ID, never
 * a position in the list.
 */
export function matchRunSelector<T extends { runRef: RunRef; runId: number }>(
  runs: readonly T[],
  selector: RunSelector
): RunSelectorMatch<T> {
  const matches = runs.filter((run) =>
    typeof selector === "number"
      ? run.runId === selector
      : run.runRef === selector
  );
  if (matches.length === 1) {
    return { kind: RUN_SELECTOR_MATCH_KINDS.FOUND, run: matches[0] };
  }
  return matches.length > 1
    ? { kind: RUN_SELECTOR_MATCH_KINDS.AMBIGUOUS }
    : { kind: RUN_SELECTOR_MATCH_KINDS.NOT_FOUND };
}
