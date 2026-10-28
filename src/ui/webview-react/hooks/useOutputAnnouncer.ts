import { useEffect } from "react";
import { OUTPUT_ANNOUNCEMENT_MODES } from "@root/types/DashboardConstants";
import { useAnnouncerStore } from "@store/announcerStore";
import { selectUiAccessibility, useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  OutputAnnouncementTracker,
  describeLastResponse,
  type OutputAnnouncementSnapshot,
} from "@utils/outputAnnouncements";
import { workflowViewAddressKey } from "@utils/viewAddress";

/**
 * How long store changes are gathered before they are compared. A burst of
 * messages (one streamed batch, a step finishing and the next starting) then
 * becomes one announcement instead of several that interrupt each other.
 */
const ANNOUNCEMENT_OBSERVE_DELAY_MS = 250;

/** The displayed output: the loaded run's while one is on screen, else live. */
function displayedEntries() {
  const { liveOrderedEntries, historyOutputs } = useWorkflowStore.getState();
  const fromHistory =
    useUiStore.getState().isViewingHistory && historyOutputs !== null;
  return {
    fromHistory,
    entries: fromHistory ? historyOutputs.orderedEntries : liveOrderedEntries,
  };
}

function readSnapshot(): OutputAnnouncementSnapshot {
  const workflow = useWorkflowStore.getState();
  const appliedViewAddress = useUiStore.getState().appliedViewAddress;
  const { fromHistory, entries } = displayedEntries();
  return {
    viewKey: appliedViewAddress
      ? workflowViewAddressKey(appliedViewAddress)
      : null,
    entriesFromHistory: fromHistory,
    executionState: workflow.executionState,
    steps: workflow.steps,
    finalStep: workflow.finalStep,
    finalStepStatus: workflow.finalStepStatus,
    finalStepLoopCount: workflow.finalStepLoopCount,
    entries,
    nowMs: Date.now(),
  };
}

/**
 * Feeds the screen-reader live region from store changes, as configured by
 * `ui.accessibility.outputAnnouncements`. See `outputAnnouncements.ts` for why
 * this watches the stores and not the output pane.
 */
export function useOutputAnnouncer(): void {
  const mode = useSettingsStore(
    (state) => selectUiAccessibility(state).outputAnnouncements
  );

  useEffect(() => {
    if (mode === OUTPUT_ANNOUNCEMENT_MODES.NONE) return;
    const tracker = new OutputAnnouncementTracker(mode);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      timer = null;
      const messages = tracker.observe(readSnapshot());
      if (messages.length > 0) {
        useAnnouncerStore.getState().announce(messages.join(" "));
      }
    };
    const schedule = () => {
      if (timer === null) {
        timer = setTimeout(evaluate, ANNOUNCEMENT_OBSERVE_DELAY_MS);
      }
    };
    // Baseline: what is already on screen is never announced.
    evaluate();
    const unsubscribeWorkflow = useWorkflowStore.subscribe(schedule);
    const unsubscribeUi = useUiStore.subscribe(schedule);
    return () => {
      unsubscribeWorkflow();
      unsubscribeUi();
      if (timer !== null) clearTimeout(timer);
    };
  }, [mode]);
}

/**
 * Announce the most recent finished response in the displayed output. An
 * explicit request, so it speaks even with announcements turned off.
 */
export function announceLastResponse(): void {
  const { steps, finalStep } = useWorkflowStore.getState();
  useAnnouncerStore
    .getState()
    .announce(
      describeLastResponse(displayedEntries().entries, { steps, finalStep })
    );
}
