/**
 * Shared LOAD_RUN_VIEW sender for every surface that lets a user switch the
 * displayed draft/run: the recent-workflows list and the run-navigation panel.
 * It is the only such sender — the output header's legacy run selector, which
 * used to duplicate it, is gone. Centralizing it is
 * what keeps the "selecting the executing run returns to live output instead
 * of replaying a snapshot" rule from drifting out of sync between callers —
 * see RUN_NAVIGATION_UX_PLAN.md's "Deletion and live-run behavior" section.
 */
import { MESSAGE_TYPES } from "../types/messages";
import { useUiStore } from "../store/uiStore";
import { useWorkflowStore } from "../store/workflowStore";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import { WebviewLog } from "@utils/logger";
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

function addressLabel(address: WorkflowViewAddress | null): string {
  if (!address) return "(none)";
  return address.kind === "draft"
    ? `${address.workflowKey}/draft`
    : `${address.workflowKey}/${address.runRef}`;
}

/**
 * Navigates to `address`. Already-viewing addresses are short-circuited.
 *
 * Selecting the currently executing run switches output back to live
 * immediately, but still requests its authoritative addressed snapshot. The
 * snapshot restores that run's definition, revisions, and view registration;
 * clearing history alone would leave the client addressed to the historical
 * run it just left and cause live messages for the executing run to be
 * filtered out.
 *
 * - the address already displayed closes/no-ops without a round trip;
 * - every actual address change requests an addressed snapshot.
 */
export function navigateToWorkflowAddress(
  vscode: VsCodeLike,
  address: WorkflowViewAddress,
  targetWorkflowName?: string
): void {
  const ui = useUiStore.getState();
  if (areWorkflowAddressesEqual(address, ui.displayedViewAddress)) {
    WebviewLog.debug(
      `[runNavigation] already viewing ${addressLabel(address)} — no load requested`
    );
    return;
  }

  const previousAddress = ui.displayedViewAddress;
  const isDisplayedLineage =
    previousAddress?.workflowKey === address.workflowKey;
  const isExecutingRunRow =
    isDisplayedLineage &&
    address.kind === "run" &&
    ui.executionRunRef !== null &&
    address.runRef === ui.executionRunRef;

  const requestId = ui.requestRunViewLoad(
    address,
    isDisplayedLineage ? ui.runSummaries : [],
    isDisplayedLineage ? (ui.executionRunRef ?? undefined) : undefined,
    targetWorkflowName
  );
  if (isExecutingRunRow) {
    useWorkflowStore.getState().clearHistoryOutputs();
    ui.clearHistoryView();
  }
  WebviewLog.debug(
    `[runNavigation] loading ${addressLabel(address)} from ${addressLabel(previousAddress)} ` +
      `(requestId=${requestId}, view=${isExecutingRunRow ? "live" : "snapshot"})`
  );
  vscode.postMessage({
    type: MESSAGE_TYPES.LOAD_RUN_VIEW,
    address,
    requestId,
  });
}
