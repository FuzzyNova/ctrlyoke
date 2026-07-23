/**
 * Shared LOAD_RUN_VIEW sender for every surface that lets a user switch the
 * displayed draft/run: the recent-workflows list, the run-navigation panel,
 * and (eventually) the legacy output-header run selector. Centralizing it is
 * what keeps the "selecting the executing run returns to live output instead
 * of replaying a snapshot" rule from drifting out of sync between callers —
 * see RUN_NAVIGATION_UX_PLAN.md's "Deletion and live-run behavior" section.
 */
import { MESSAGE_TYPES } from "../types/messages";
import { useUiStore } from "../store/uiStore";
import { useWorkflowStore } from "../store/workflowStore";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import type {
  WorkflowRunNavigationSummary,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";

/**
 * A lineage is "drillable" — worth a run-panel entry point (header badge or
 * list row indicator) — once it has more than one addressable target:
 * promoted runs plus draft. One rule, shared by both surfaces per
 * RUN_NAVIGATION_UX_PLAN.md, so a single-run lineage with no draft and a
 * draft-only lineage never gain new UI.
 */
export function isDrillableRunNav(
  runNav: WorkflowRunNavigationSummary | undefined
): boolean {
  if (!runNav) return false;
  return runNav.runCount + (runNav.hasDraft ? 1 : 0) > 1;
}

/** "Run 1042" / "Draft", or their narrow "#1042" / "Draft" forms. */
export function runNavIndicatorLabel(
  runNav: WorkflowRunNavigationSummary,
  isNarrow: boolean
): string {
  if (runNav.primaryAddress.kind === "draft") {
    return "Draft";
  }
  const runId = runNav.primaryRunId ?? "?";
  return isNarrow ? `#${runId}` : `Run ${runId}`;
}

/**
 * The header badge's label: the *viewed* run's manifest `runId`, resolved by
 * matching `address.runRef` against `runSummaries` — never derived from array
 * length or index, so deletion gaps stay visible.
 */
export function viewedRunLabel(
  address: WorkflowViewAddress,
  runSummaries: RunSummary[],
  isNarrow: boolean
): string {
  if (address.kind !== "run") {
    return "Draft";
  }
  const runId =
    runSummaries.find((summary) => summary.runRef === address.runRef)?.runId ??
    "?";
  return isNarrow ? `#${runId}` : `Run ${runId}`;
}

interface VsCodeLike {
  postMessage: (message: unknown) => void;
}

/**
 * Navigates to `address`. Already-viewing and executing-run addresses are
 * short-circuited:
 * - the address already displayed closes/no-ops without a round trip;
 * - the currently executing run of the currently displayed lineage returns
 *   to live output (today's back-to-live path) instead of fetching a
 *   persisted snapshot of a run still being written to.
 *
 * Everything else requests an addressed snapshot the normal way.
 */
export function navigateToWorkflowAddress(
  vscode: VsCodeLike,
  address: WorkflowViewAddress,
  targetWorkflowName?: string
): void {
  const ui = useUiStore.getState();
  if (areWorkflowAddressesEqual(address, ui.displayedViewAddress)) {
    return;
  }

  const isDisplayedLineage =
    ui.displayedViewAddress?.workflowKey === address.workflowKey;
  const isExecutingRunRow =
    isDisplayedLineage &&
    address.kind === "run" &&
    ui.executionRunRef !== null &&
    address.runRef === ui.executionRunRef;

  if (isExecutingRunRow) {
    useWorkflowStore.getState().clearHistoryOutputs();
    ui.clearHistoryView();
    return;
  }

  const requestId = ui.requestRunViewLoad(
    address,
    isDisplayedLineage ? ui.runSummaries : [],
    isDisplayedLineage ? (ui.executionRunRef ?? undefined) : undefined,
    targetWorkflowName
  );
  vscode.postMessage({
    type: MESSAGE_TYPES.LOAD_RUN_VIEW,
    address,
    requestId,
  });
}
