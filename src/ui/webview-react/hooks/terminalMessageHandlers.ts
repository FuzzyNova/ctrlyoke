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
import { sendMessage } from "@hooks/useMessageHandler";
import type { MessageHandlerMap } from "./useMessageHandler";

/**
 * Register all terminal-related message handlers into the provided handler map.
 */
export function registerTerminalHandlers(handlers: MessageHandlerMap): void {
  // --------------------------------------------------------------------------
  // CLIENT_ID_ASSIGNED - Extension tells this client its own identity
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.CLIENT_ID_ASSIGNED] = (message: any) => {
    const { clientId } = message;
    if (clientId) {
      useUiStore.getState().setMyClientId(clientId as string);
    }
  };
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
    const { workflowId, sessionId, stepName, kind, promptNumber, harnessId, shellKind, controllerClientId } = message;
    if (!workflowId || !sessionId) return;

    const uiState = useUiStore.getState();
    const activeWorkflowId = uiState.activeWorkflowId;
    WebviewLog.debug(
      `[TERMINAL_STARTED] workflowId=inst:${workflowId?.slice(0, 8)} sessionId=${sessionId?.slice(0, 8)} kind=${kind} activeWorkflowId=inst:${activeWorkflowId?.slice(0, 8) ?? "null"} match=${workflowId === activeWorkflowId} controllerClientId=${controllerClientId?.slice(0, 12) ?? "none"}`
    );

    // Sessions replayed with a controllerClientId (from replayWorkflowStateTo) may
    // be for any workflow. Live sessions without a controller must match this client's
    // active workflow — reject them otherwise to prevent terminals from hijacking the
    // wrong client's view.
    if (
      controllerClientId === undefined &&
      activeWorkflowId &&
      workflowId !== activeWorkflowId
    ) {
      WebviewLog.debug(
        `[TERMINAL_STARTED] ignoring live session — workflowId=${workflowId?.slice(0, 8)} !== activeWorkflowId=${activeWorkflowId?.slice(0, 8)}`
      );
      return;
    }

    // Determine if this client is the controller for this session.
    // If controllerClientId is undefined, auto-claim by sending TERMINAL_CLAIM_CONTROL.
    const myClientId = uiState.myClientId;
    const isController =
      controllerClientId === undefined || controllerClientId === myClientId;

    // Idempotency: if this exact session is already registered (e.g. client switched away
    // and back, or is a new viewer joining a workflow that already sent TERMINAL_STARTED),
    // just update controller state without clearing and recreating the xterm instance.
    // Clearing+recreating causes a "briefly see scrollback then blank" flicker.
    const existingSessions = useTerminalStore.getState().sessions[workflowId] ?? [];
    const alreadyExists = existingSessions.some((s) => s.id === sessionId);
    WebviewLog.debug(
      `[TERMINAL_STARTED] idempotency check wf=${workflowId?.slice(0, 8)} sess=${sessionId?.slice(0, 8)} ` +
        `alreadyExists=${alreadyExists} isController=${isController} ` +
        `registryHasEntry=${!!terminalRegistry.get(workflowId, sessionId)} ` +
        `activeWorkflowId=${activeWorkflowId?.slice(0, 8) ?? "null"}`
    );
    if (alreadyExists) {
      const termStore = useTerminalStore.getState();
      termStore.updateSessionMetadata(workflowId, sessionId, {
        ...(stepName !== undefined ? { stepName } : {}),
        ...(promptNumber !== undefined ? { promptNumber } : {}),
        ...(harnessId !== undefined ? { harnessId } : {}),
        ...(shellKind !== undefined ? { shellKind } : {}),
        status: TERMINAL_SESSION_STATUS.RUNNING,
      });
      termStore.setSessionController(workflowId, sessionId, isController);
      if (controllerClientId === undefined) {
        sendMessage(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, { workflowId, sessionId });
      }
      return;
    }

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
      harnessId,
      shellKind,
      status: TERMINAL_SESSION_STATUS.RUNNING,
      pendingOutput: [],
      isController,
    });

    useUiStore.getState().setTerminalSessionActive(workflowId, true);

    // Auto-switch to Terminal tab when an ai-cli session starts.
    if (kind === SESSION_KINDS.AI_CLI) {
      useUiStore.getState().setActiveOutputTab(workflowId, "terminal");
    }

    // Auto-claim if no controller is assigned — the first client to send wins
    if (controllerClientId === undefined) {
      sendMessage(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, { workflowId, sessionId });
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_CONTROLLER_CHANGED - Controller assignment updated; refresh isController
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED] = (message: any) => {
    const { workflowId, sessionId, controllerClientId } = message;
    if (!workflowId || !sessionId) return;
    const myClientId = useUiStore.getState().myClientId;
    const isController =
      controllerClientId === undefined || controllerClientId === myClientId;
    useTerminalStore.getState().setSessionController(workflowId, sessionId, isController);
    WebviewLog.debug(
      `[TERMINAL_CONTROLLER_CHANGED] sessionId=${sessionId?.slice(0, 8)} controllerClientId=${controllerClientId?.slice(0, 12) ?? "none"} isController=${isController}`
    );
  };

  // --------------------------------------------------------------------------
  // TERMINAL_SIZE_CHANGED - Controller's PTY was resized; viewers must match
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_SIZE_CHANGED] = (message: any) => {
    const { workflowId, sessionId, cols } = message;
    if (!workflowId || !sessionId || !cols) return;

    // Always record the controller cols so ResizeObserver can maintain them
    useTerminalStore.getState().setSessionControllerSize(workflowId, sessionId, cols as number);

    // Only apply to the local xterm if this client is a viewer (not the controller)
    const sessions = useTerminalStore.getState().sessions[workflowId] ?? [];
    const session = sessions.find((s) => s.id === sessionId);
    if (session?.isController === false) {
      terminalRegistry.applyControllerSize(workflowId, sessionId, cols as number);
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
