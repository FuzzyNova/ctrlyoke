/**
 * Terminal message handlers for the FlightPath dashboard.
 *
 * Handles all PTY/xterm-related messages: output routing, session lifecycle,
 * and tab switching. Isolated here because terminal handlers have a unique
 * dependency on terminalRegistry that no other handler group shares.
 */
import {
  MESSAGE_TYPES,
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
} from "../types/messages";
import { WebviewLog } from "@utils/logger";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalRegistry } from "../terminalRegistry";
import type { MessageHandlerMap } from "./useMessageHandler";

/**
 * Register all terminal-related message handlers into the provided handler map.
 */
export function registerTerminalHandlers(handlers: MessageHandlerMap): void {
  // --------------------------------------------------------------------------
  // TERMINAL_OUTPUT - PTY output data; route directly to xterm or buffer it
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_OUTPUT] = (message: any) => {
    const { workflowId, sessionId, data } = message;
    if (!workflowId || !sessionId || !data) return;

    // Write directly to the xterm instance (no Zustand, no re-renders)
    const entry = terminalRegistry.get(workflowId, sessionId);
    if (entry) {
      entry.term.write(data as string);
    } else {
      // Terminal not yet mounted — buffer until TerminalInstance mounts
      useTerminalStore
        .getState()
        .pushPendingOutput(workflowId, sessionId, data as string);
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_STARTED - New PTY session created; register in store and rail
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_STARTED] = (message: any) => {
    const { workflowId, sessionId, stepName, kind, promptNumber } = message;
    if (!workflowId || !sessionId) return;

    const activeWorkflowId = useUiStore.getState().activeWorkflowId;
    WebviewLog.debug(
      `[TERMINAL_STARTED] workflowId=inst:${workflowId?.slice(0, 8)} sessionId=${sessionId?.slice(0, 8)} kind=${kind} activeWorkflowId=inst:${activeWorkflowId?.slice(0, 8) ?? "null"} match=${workflowId === activeWorkflowId}`
    );

    // For ai-cli sessions, only one should exist at a time per workflow.
    // Replace any previous ai-cli session so prompts within a run don't accumulate
    // separate xterm views. (clearAiCliSessions at WORKFLOW_STARTED handles run-to-run
    // clearing; this handles prompt-to-prompt replacement within a single run.)
    if (kind === SESSION_KINDS.AI_CLI) {
      const termStore = useTerminalStore.getState();
      const prevAiCliIds = (termStore.sessions[workflowId] ?? [])
        .filter((s) => s.kind === SESSION_KINDS.AI_CLI)
        .map((s) => s.id);
      if (prevAiCliIds.length > 0) {
        terminalRegistry.clearAiCliSessions(workflowId, prevAiCliIds);
        termStore.clearAiCliSessions(workflowId);
      }
    }

    useTerminalStore.getState().addSession({
      id: sessionId,
      workflowId,
      stepName: stepName ?? "terminal",
      kind: kind ?? SESSION_KINDS.AI_CLI,
      promptNumber,
      status: TERMINAL_SESSION_STATUS.RUNNING,
      pendingOutput: [],
      viewerOnly: message.viewerOnly === true,
    });

    useUiStore.getState().setTerminalSessionActive(workflowId, true);

    // Auto-switch to Terminal tab when an ai-cli session starts.
    // Also promote this workflow to active if needed — ACTIVE_WORKFLOW_CHANGED
    // may have been silently dropped if it was posted before the webview panel
    // was visible (postMessage no-ops when this.view is null).
    if (kind === SESSION_KINDS.AI_CLI) {
      const uiState = useUiStore.getState();
      if (uiState.activeWorkflowId !== workflowId) {
        uiState.setActiveWorkflowId(workflowId);
      }
      uiState.setActiveOutputTab(workflowId, "terminal");
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_ENDED - PTY session exited; freeze registry entry, update rail
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_ENDED] = (message: any) => {
    const { workflowId, sessionId, kind, exitCode } = message;
    if (!workflowId || !sessionId) return;

    const termStore = useTerminalStore.getState();
    termStore.endSession(workflowId, sessionId, exitCode ?? 0);

    // Freeze ai-cli sessions in the registry so onData is disabled
    if (kind === SESSION_KINDS.AI_CLI) {
      terminalRegistry.freeze(workflowId, sessionId);
    }

    // Check if all sessions for this workflow have ended
    const sessions = termStore.sessions[workflowId] ?? [];
    const hasRunningSessions = sessions.some(
      (s) => s.status === TERMINAL_SESSION_STATUS.RUNNING
    );

    if (!hasRunningSessions) {
      useUiStore.getState().setTerminalSessionActive(workflowId, false);

      // Auto-switch back to Output tab when all ai-cli sessions are done,
      // but only if no shell sessions remain open
      const hasShellSessions = sessions.some(
        (s) => s.kind === SESSION_KINDS.SHELL
      );
      if (!hasShellSessions) {
        useUiStore.getState().setActiveOutputTab(workflowId, "output");
      }
    }
  };
}
