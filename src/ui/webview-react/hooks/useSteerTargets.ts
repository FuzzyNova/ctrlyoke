import { useMemo } from "react";
import { useTerminalStore } from "@store/terminalStore";
import { useWorkflowStore } from "@store/workflowStore";
import { buildSteerTargets, type SteerTarget } from "@utils/steerTargets";

/**
 * Every live steer destination for a workflow (see `buildSteerTargets`). The
 * Run menu's steer items, Send Steer to Step and End Step Early all read this
 * one selector, so they always agree on which sessions exist.
 */
export function useSteerTargets(workflowId: string | null): SteerTarget[] {
  const headlessControlTargets = useTerminalStore((state) =>
    workflowId ? state.headlessControlTargets[workflowId] : undefined
  );
  const sessions = useTerminalStore((state) =>
    workflowId ? state.sessions[workflowId] : undefined
  );
  const activeStepIndices = useWorkflowStore(
    (state) => state.activeStepIndices
  );

  return useMemo(
    () =>
      buildSteerTargets(headlessControlTargets, sessions, activeStepIndices),
    [activeStepIndices, headlessControlTargets, sessions]
  );
}
