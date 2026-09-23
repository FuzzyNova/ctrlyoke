import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";
import { isUnstartedRun } from "@root/utils/StepStatusDerivation";

/**
 * True when the displayed address is a run that was prepared but has executed
 * nothing — seeded by "New Run (Don't Start)" or "Set start position" on the
 * first step. Its natural action is Run (not Re-run, which would fork yet
 * another empty run), and the header labels it "not started".
 *
 * Reads the live workflow store rather than the frozen `runSummaries`
 * snapshot, so the answer flips the moment the run starts. Both selectors
 * return primitives: a fresh object identity per call would re-render on every
 * unrelated store write.
 */
export function useIsViewedRunUnstarted(): boolean {
  const isRunView = useUiStore(
    (s) => s.displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
  );
  const isUnstarted = useWorkflowStore((s) =>
    isUnstartedRun({
      executionState: s.executionState,
      currentIndex: s.currentStep,
      finalStepStatus: s.finalStepStatus,
      steps: s.steps,
    })
  );
  return isRunView && isUnstarted;
}
