import { useMemo } from "react";
import { getHarnessDisplayName } from "@root/types/DashboardConstants";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";

export const NO_INTERRUPTIBLE_HEADLESS_TURN =
  "No live headless turn supports interruption";
const EXTERNAL_RUN = "Read-only — external run";

export interface InterruptTurnTarget {
  enabled: boolean;
  disabledReason?: string;
  title: string;
  /** Control session to interrupt; present only when `enabled`. */
  sessionId?: string;
}

/**
 * Resolve the open headless turn that Interrupt Turn would end. Unlike steer,
 * this ignores the rail-active PTY: a PTY turn cannot be interrupted through
 * a control channel, so a selected terminal must not hide a headless turn.
 */
export function useInterruptTurnTarget(
  workflowId: string | null
): InterruptTurnTarget {
  const headlessControlTargets = useTerminalStore((state) =>
    workflowId ? state.headlessControlTargets[workflowId] : undefined
  );
  const loadedWorkflows = useUiStore((state) => state.loadedWorkflows);

  return useMemo(() => {
    const isExternallyManaged = loadedWorkflows.some(
      (workflow) => workflow.id === workflowId && workflow.externalOwner
    );
    if (isExternallyManaged) {
      return {
        enabled: false,
        disabledReason: EXTERNAL_RUN,
        title: EXTERNAL_RUN,
      };
    }
    const target = headlessControlTargets?.find(
      (candidate) => candidate.canInterruptTurn
    );
    if (!target) {
      return {
        enabled: false,
        disabledReason: NO_INTERRUPTIBLE_HEADLESS_TURN,
        title: NO_INTERRUPTIBLE_HEADLESS_TURN,
      };
    }
    const harnessLabel = getHarnessDisplayName(target.harnessId);
    return {
      enabled: true,
      sessionId: target.controlSessionId,
      title: `Ends the current turn on the live ${harnessLabel} headless session (step ${target.stepIndex + 1}) without stopping the workflow.`,
    };
  }, [headlessControlTargets, loadedWorkflows, workflowId]);
}
