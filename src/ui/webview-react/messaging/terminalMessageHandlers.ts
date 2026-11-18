/**
 * Terminal message handlers for the ctrlyoke dashboard.
 *
 * Handles all PTY/xterm-related messages: output routing, session lifecycle,
 * and tab switching. Isolated here because terminal handlers have a unique
 * dependency on terminalRegistry that no other handler group shares.
 */
import {
  MESSAGE_TYPES,
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
  type TerminalEndReason,
  type TerminalSessionStatus,
} from "../types/messages";
import { OUTPUT_TABS } from "@root/types/DashboardConstants";
import { WebviewLog } from "@utils/logger";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { terminalRegistry } from "../terminalRegistry";
import { sendMessage } from "@messaging/sendMessage";
import type { MessageHandlerMap } from "./inboundMessageRouter";
import type {
  TerminalEndedMessage,
  TerminalOpenTabsMessage,
  TerminalStartedMessage,
} from "@root/types/WebviewMessageTypes";
import { autoFocusOutputOnExecution } from "@utils/executionOutputFocus";

const pendingAutoClaims = new Set<string>();

function getPendingAutoClaimKey(workflowId: string, sessionId: string): string {
  return `${workflowId}::${sessionId}`;
}

function hasSession(workflowId: string, sessionId: string): boolean {
  return (useTerminalStore.getState().sessions[workflowId] ?? []).some(
    (session) => session.id === sessionId
  );
}

function queuePendingAutoClaim(
  workflowId: string,
  sessionId: string,
  reason: string
): void {
  const key = getPendingAutoClaimKey(workflowId, sessionId);
  pendingAutoClaims.add(key);
  WebviewLog.debug(
    `[terminal-control] queued pending auto-claim wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} reason=${reason}`
  );
}

function consumePendingAutoClaim(
  workflowId: string,
  sessionId: string,
  reason: string
): boolean {
  const key = getPendingAutoClaimKey(workflowId, sessionId);
  const queued = pendingAutoClaims.delete(key);
  if (queued) {
    WebviewLog.debug(
      `[terminal-control] consumed pending auto-claim wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} reason=${reason}`
    );
  }
  return queued;
}

function clearPendingAutoClaim(
  workflowId: string,
  sessionId: string,
  reason: string
): void {
  const key = getPendingAutoClaimKey(workflowId, sessionId);
  if (!pendingAutoClaims.delete(key)) {
    return;
  }
  WebviewLog.debug(
    `[terminal-control] cleared pending auto-claim wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} reason=${reason}`
  );
}

function requestTerminalControlClaim(
  workflowId: string,
  sessionId: string,
  reason: string
): void {
  WebviewLog.debug(
    `[terminal-control] requesting claim wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} reason=${reason}`
  );
  sendMessage(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, {
    workflowId,
    sessionId,
  });
}

/**
 * Mark a session ended and freeze its xterm so keystrokes stop routing to a
 * dead PTY (shells too — a restarted shell is a new session). Unknown sessions
 * are ignored: a closed tab's TERMINAL_ENDED can land after TERMINAL_REMOVED.
 *
 * When this ends the workflow's last running session, the terminal-active flag
 * clears and, with no shell tab to keep the terminal pane useful, Output is
 * shown again. Re-ending an already-ended tab (a replay) never moves the user.
 */
function endTerminalSession(
  workflowId: string,
  sessionId: string,
  status: TerminalSessionStatus,
  endReason: TerminalEndReason | undefined
): void {
  const termStore = useTerminalStore.getState();
  const session = (termStore.sessions[workflowId] ?? []).find(
    (s) => s.id === sessionId
  );
  if (!session) return;
  const wasRunning = session.status === TERMINAL_SESSION_STATUS.RUNNING;
  termStore.endSession(workflowId, sessionId, status, endReason);
  clearPendingAutoClaim(workflowId, sessionId, "terminal ended");
  terminalRegistry.freeze(workflowId, sessionId);
  if (!wasRunning) return;

  const sessions = useTerminalStore.getState().sessions[workflowId] ?? [];
  const hasRunningSessions = sessions.some(
    (s) => s.status === TERMINAL_SESSION_STATUS.RUNNING
  );
  if (hasRunningSessions) return;

  useUiStore.getState().setTerminalSessionActive(workflowId, false);
  const hasShellSessions = sessions.some((s) => s.kind === SESSION_KINDS.SHELL);
  if (!hasShellSessions) {
    useUiStore.getState().setActiveOutputTab(workflowId, OUTPUT_TABS.OUTPUT);
  }
}

/**
 * Drop a terminal tab: dispose its xterm and remove it from the rail. When no
 * running session is left the terminal-active flag clears, and when no tab is
 * left at all Output is shown again.
 */
function removeTerminalTab(workflowId: string, sessionId: string): void {
  clearPendingAutoClaim(workflowId, sessionId, "terminal removed");
  terminalRegistry.clearSession(workflowId, sessionId);
  useTerminalStore.getState().removeSession(workflowId, sessionId);

  const sessions = useTerminalStore.getState().sessions[workflowId] ?? [];
  if (!sessions.some((s) => s.status === TERMINAL_SESSION_STATUS.RUNNING)) {
    useUiStore.getState().setTerminalSessionActive(workflowId, false);
  }
  if (sessions.length === 0) {
    useUiStore.getState().setActiveOutputTab(workflowId, OUTPUT_TABS.OUTPUT);
  }
}

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
      // A frozen xterm belongs to an ended session and already shows all its
      // output; this is replayed scrollback, and writing it would repeat it.
      if (!entry.frozen) {
        entry.term.write(data as string);
      }
      return;
    }
    // No entry yet — the PTY can emit its first chunks before create() runs.
    // Buffer in the registry (keyed by workflow+session, independent of whether
    // the session record exists yet) so create() can flush them in order. Only
    // for the active workflow: backgrounded workflows are replayed from the
    // server-side reconnect buffer on switch, so buffering here would double up.
    if (workflowId === useUiStore.getState().activeWorkflowId) {
      terminalRegistry.bufferOrphanOutput(
        workflowId,
        sessionId,
        data as string
      );
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_STARTED - New PTY session created; register in store and rail
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_STARTED] = (
    message: TerminalStartedMessage
  ) => {
    const {
      workflowId,
      sessionId,
      stepName,
      kind,
      promptNumber,
      harnessId,
      stepIndex,
      parallelGroupId,
      shellKind,
      controllerClientId,
    } = message;
    if (!workflowId || !sessionId) return;
    // Set only when replay re-announces a tab whose process already exited.
    const endedStatus =
      message.status !== undefined &&
      message.status !== TERMINAL_SESSION_STATUS.RUNNING
        ? message.status
        : undefined;

    const uiState = useUiStore.getState();
    const activeWorkflowId = uiState.activeWorkflowId;
    const queuedAutoClaim = consumePendingAutoClaim(
      workflowId,
      sessionId,
      "terminal started"
    );
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
    const willAutoClaim = controllerClientId === undefined || queuedAutoClaim;

    // Idempotency: if this exact session is already registered (e.g. client switched away
    // and back, or is a new viewer joining a workflow that already sent TERMINAL_STARTED),
    // just update controller state without clearing and recreating the xterm instance.
    // Clearing+recreating causes a "briefly see scrollback then blank" flicker.
    const existingSessions =
      useTerminalStore.getState().sessions[workflowId] ?? [];
    const alreadyExists = existingSessions.some((s) => s.id === sessionId);
    WebviewLog.debug(
      `[TERMINAL_STARTED] idempotency check wf=${workflowId?.slice(0, 8)} sess=${sessionId?.slice(0, 8)} ` +
        `alreadyExists=${alreadyExists} isController=${isController} ` +
        `queuedAutoClaim=${queuedAutoClaim} willAutoClaim=${willAutoClaim} ` +
        `registryHasEntry=${!!terminalRegistry.get(workflowId, sessionId)} ` +
        `activeWorkflowId=${activeWorkflowId?.slice(0, 8) ?? "null"}`
    );
    if (alreadyExists) {
      const termStore = useTerminalStore.getState();
      termStore.updateSessionMetadata(workflowId, sessionId, {
        ...(stepName !== undefined ? { stepName } : {}),
        stepIndex,
        ...(promptNumber !== undefined ? { promptNumber } : {}),
        ...(harnessId !== undefined ? { harnessId } : {}),
        parallelGroupId,
        ...(shellKind !== undefined ? { shellKind } : {}),
      });
      termStore.setSessionController(workflowId, sessionId, isController);
      if (endedStatus !== undefined) {
        // It exited while this client was not listening (TERMINAL_ENDED lost).
        endTerminalSession(
          workflowId,
          sessionId,
          endedStatus,
          message.endReason
        );
        return;
      }
      termStore.updateSessionMetadata(workflowId, sessionId, {
        status: TERMINAL_SESSION_STATUS.RUNNING,
        // Live again — a previous end reason would mislabel the next exit.
        endReason: undefined,
      });
      terminalRegistry.unfreeze(workflowId, sessionId);
      if (willAutoClaim) {
        requestTerminalControlClaim(
          workflowId,
          sessionId,
          queuedAutoClaim
            ? "reconciling stale replay for existing session"
            : "existing session has no controller"
        );
      }
      return;
    }

    useTerminalStore.getState().addSession({
      id: sessionId,
      workflowId,
      stepName: stepName ?? "terminal",
      stepIndex,
      kind: kind ?? SESSION_KINDS.AI_CLI,
      promptNumber,
      harnessId,
      parallelGroupId,
      shellKind,
      status: endedStatus ?? TERMINAL_SESSION_STATUS.RUNNING,
      ...(endedStatus !== undefined ? { endReason: message.endReason } : {}),
      isController,
    });

    if (endedStatus !== undefined) {
      // An ended tab replayed to a client that never saw it: its scrollback
      // follows, and TerminalInstance mounts it frozen (no input routing).
      clearPendingAutoClaim(workflowId, sessionId, "ended tab replayed");
      return;
    }

    useUiStore.getState().setTerminalSessionActive(workflowId, true);

    // Auto-focus the output section on interactive execution when enabled.
    if (kind === SESSION_KINDS.AI_CLI) {
      autoFocusOutputOnExecution(workflowId, "terminal");
    }

    if (willAutoClaim) {
      requestTerminalControlClaim(
        workflowId,
        sessionId,
        queuedAutoClaim
          ? "reconciling stale replay for new session"
          : "new session has no controller"
      );
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_CONTROLLER_CHANGED - Controller assignment updated; refresh isController
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED] = (message: any) => {
    const { workflowId, sessionId, controllerClientId } = message;
    if (!workflowId || !sessionId) return;
    const myClientId = useUiStore.getState().myClientId;
    const activeWorkflowId = useUiStore.getState().activeWorkflowId;
    const sessionExists = hasSession(workflowId, sessionId);
    const isController =
      controllerClientId === undefined || controllerClientId === myClientId;
    useTerminalStore
      .getState()
      .setSessionController(workflowId, sessionId, isController);
    WebviewLog.debug(
      `[TERMINAL_CONTROLLER_CHANGED] workflowId=inst:${workflowId?.slice(0, 8)} sessionId=${sessionId?.slice(0, 8)} ` +
        `controllerClientId=${controllerClientId?.slice(0, 12) ?? "none"} isController=${isController} ` +
        `activeWorkflowId=inst:${activeWorkflowId?.slice(0, 8) ?? "null"} sessionExists=${sessionExists}`
    );
    if (controllerClientId !== undefined) {
      if (controllerClientId === myClientId && !sessionExists) {
        WebviewLog.debug(
          `[terminal-control] preserving pending auto-claim until replayed start arrives wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
        );
        return;
      }
      clearPendingAutoClaim(
        workflowId,
        sessionId,
        controllerClientId === myClientId
          ? "controller assigned after session replay completed"
          : "controller assigned to another client"
      );
      return;
    }

    if (
      !sessionExists &&
      (activeWorkflowId === workflowId || activeWorkflowId === null)
    ) {
      queuePendingAutoClaim(
        workflowId,
        sessionId,
        activeWorkflowId === workflowId
          ? "controller released while active workflow was already selected"
          : "controller released before active workflow replay completed"
      );
    }

    // If no controller is assigned and this client is actively viewing the workflow,
    // auto-claim so exactly one client takes ownership. Only claim for the workflow
    // currently in view — do not grab sessions for workflows being viewed on other tabs.
    // All eligible connected clients fire this; only the last one processed by the
    // server's routeQueue wins — an intentional "last writer wins" resolution.
    if (activeWorkflowId === workflowId) {
      requestTerminalControlClaim(
        workflowId,
        sessionId,
        "controller released for active workflow"
      );
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_SIZE_CHANGED - Controller's PTY was resized; viewers must match
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_SIZE_CHANGED] = (message: any) => {
    const { workflowId, sessionId, cols, rows } = message;
    if (!workflowId || !sessionId || !cols) return;

    // Always record the controller dims so the ResizeObserver and mount seeding
    // can maintain them.
    useTerminalStore
      .getState()
      .setSessionControllerSize(
        workflowId,
        sessionId,
        cols as number,
        rows as number | undefined
      );

    // Only apply to the local xterm if this client is a viewer (not the controller)
    const sessions = useTerminalStore.getState().sessions[workflowId] ?? [];
    const session = sessions.find((s) => s.id === sessionId);
    const entry = terminalRegistry.get(workflowId, sessionId);
    WebviewLog.trace(
      `[TERMINAL_SIZE_CHANGED] wf=${workflowId?.slice(0, 8)} sess=${sessionId?.slice(0, 8)} ` +
        `controller=${cols}x${rows ?? "?"} isController=${session?.isController} ` +
        `viewerBefore=${entry ? `${entry.term.cols}x${entry.term.rows}` : "no-entry"}`
    );
    if (session?.isController === false) {
      terminalRegistry.applyControllerSize(
        workflowId,
        sessionId,
        cols as number,
        rows as number | undefined
      );
    }
  };

  // --------------------------------------------------------------------------
  // ACTIVE_TERMINAL_WORKFLOWS - Global set of workflows with a running PTY.
  // Authoritative source for the dropdown terminal icon; independent of which
  // workflow this client is currently viewing.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS] = (message: any) => {
    const workflows = Array.isArray(message?.workflows)
      ? message.workflows
      : [];
    useTerminalStore.getState().setActiveTerminalWorkflows(workflows);
  };

  // --------------------------------------------------------------------------
  // TERMINAL_ENDED - PTY session exited; freeze registry entry, update rail
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_ENDED] = (message: TerminalEndedMessage) => {
    const { workflowId, sessionId, status, endReason } = message;
    if (!workflowId || !sessionId) return;
    endTerminalSession(workflowId, sessionId, status, endReason);
  };

  // --------------------------------------------------------------------------
  // TERMINAL_OPEN_TABS - End of a terminal replay; drop tabs no longer open
  //
  // The extension keeps every open tab, ended ones included, until a client
  // closes it, and replay re-announces each one. A TERMINAL_REMOVED broadcast
  // while this client's socket was down (a backgrounded browser tab) is lost,
  // so any tab here that is missing from this list was closed elsewhere — or
  // belongs to a run the extension has since moved past — and goes too.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_OPEN_TABS] = (
    message: TerminalOpenTabsMessage
  ) => {
    if (!Array.isArray(message?.sessionIds)) return;
    const openIds = new Set(message.sessionIds);
    const allSessions = useTerminalStore.getState().sessions;
    const workflowIds =
      message.workflowId !== undefined
        ? [message.workflowId]
        : Object.keys(allSessions);
    for (const workflowId of workflowIds) {
      const staleIds = (allSessions[workflowId] ?? [])
        .filter((s) => !openIds.has(s.id))
        .map((s) => s.id);
      if (staleIds.length === 0) continue;
      WebviewLog.debug(
        `[TERMINAL_OPEN_TABS] dropping ${staleIds.length} closed tab(s) wf=${workflowId.slice(0, 8)}: ` +
          staleIds.map((id) => id.slice(0, 8)).join(", ")
      );
      for (const sessionId of staleIds) {
        removeTerminalTab(workflowId, sessionId);
      }
    }
  };

  // --------------------------------------------------------------------------
  // TERMINAL_REMOVED - A tab was closed for every client; drop it entirely
  //
  // The extension is the sole authority on terminal lifetime. It sends this
  // when any client closes a tab (the closer already dropped it locally), and
  // when a newly spawned process takes over the AI session this terminal was
  // holding open, so the conversation continues in the new tab instead of
  // being shown twice. Arrives around the session's own TERMINAL_ENDED in
  // either order; both the store and the registry no-op on an unknown session.
  // --------------------------------------------------------------------------
  handlers[MESSAGE_TYPES.TERMINAL_REMOVED] = (message: any) => {
    const { workflowId, sessionId } = message;
    if (!workflowId || !sessionId) return;
    WebviewLog.debug(
      `[TERMINAL_REMOVED] wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
    );
    removeTerminalTab(workflowId, sessionId);
  };
}
