import { useMemo } from "react";
import { useActiveInteractiveSession } from "@hooks/useActiveInteractiveSession";
import { useTerminalStore } from "@store/terminalStore";
import type { HeadlessSteerDelivery } from "@/types/messages";

export interface ActiveSteerTarget {
  sessionId: string;
  stepIndex?: number;
  harnessId?: string;
  steerDelivery?: HeadlessSteerDelivery;
  canInterruptTurn?: boolean;
}

/**
 * Resolve the live steer destination, preferring the session selected in the
 * terminal rail over an open headless control channel.
 */
export function useActiveSteerTarget(
  workflowId: string | null
): ActiveSteerTarget | undefined {
  const activeInteractiveSession = useActiveInteractiveSession(workflowId);
  const headlessControlTargets = useTerminalStore((state) =>
    workflowId ? state.headlessControlTargets[workflowId] : undefined
  );

  return useMemo(() => {
    if (activeInteractiveSession) {
      return {
        sessionId: activeInteractiveSession.id,
        stepIndex: activeInteractiveSession.stepIndex,
        harnessId: activeInteractiveSession.harnessId,
      };
    }

    const target = headlessControlTargets?.[0];
    return target
      ? {
          sessionId: target.controlSessionId,
          stepIndex: target.stepIndex,
          harnessId: target.harnessId,
          steerDelivery: target.steerDelivery,
          ...(target.canInterruptTurn !== undefined
            ? { canInterruptTurn: target.canInterruptTurn }
            : {}),
        }
      : undefined;
  }, [activeInteractiveSession, headlessControlTargets]);
}
