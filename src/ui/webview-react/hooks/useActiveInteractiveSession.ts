import {
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@root/types/DashboardConstants";
import type { TerminalSession } from "@store/terminalStore";
import { useTerminalStore } from "@store/terminalStore";

/**
 * Resolve the session currently selected in the terminal rail for a workflow.
 * Steering must follow that selection rather than choosing another live PTY.
 */
export function useActiveInteractiveSession(
  workflowId: string | null
): TerminalSession | undefined {
  const activeSessionId = useTerminalStore((state) =>
    workflowId ? state.activeSessionIds[workflowId] : null
  );
  const sessions = useTerminalStore((state) =>
    workflowId ? state.sessions[workflowId] : undefined
  );

  const activeSession = sessions?.find(
    (session) => session.id === activeSessionId
  );
  return activeSession?.kind === SESSION_KINDS.AI_CLI &&
    activeSession.status === TERMINAL_SESSION_STATUS.RUNNING
    ? activeSession
    : undefined;
}
