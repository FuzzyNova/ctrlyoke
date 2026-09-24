import {
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  SESSION_KINDS,
  TERMINAL_END_REASONS,
  USER_FEEDBACK_SEVERITY,
} from "../types/DashboardConstants";
import {
  buildTerminalEndedMessage,
  getPtyProcessManager,
  ptyPostMessage,
  type PtySession,
  type SpawnPtyOptions,
} from "../core/harness/PtyProcessManager";
import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";
import type { WebviewClientContext } from "./WebviewClientContext";
import type { TerminalStartedMessage } from "../types/WebviewMessageTypes";

type SessionCallbacks = Pick<SpawnPtyOptions, "onData" | "onExit">;

/**
 * Embedded-terminal message handlers and panel reconnect replay.
 *
 * PTY messages that represent shared terminal state are broadcast through
 * `ptyPostMessage`; reconnect buffers are sent only to the panel that just
 * recreated its webview.
 */
export class TerminalMessageHandlers {
  constructor(
    private readonly getUserFeedbackSink: () => UserFeedbackSink | undefined
  ) {}

  /**
   * The panel has this dedicated reconnect path, which sends TERMINAL_STARTED
   * plus reconnect buffers. Orchestrator client-ready replay must therefore skip
   * terminals for the panel to avoid double-sending and the xterm
   * dispose+recreate cycle that caused "briefly see scrollback then goes blank".
   * Browser clients have no separate reconnect loop and use orchestrator replay.
   */
  shouldSkipClientReadyReplay(ctx: WebviewClientContext): boolean {
    return ctx.clientId === PANEL_CLIENT_ID;
  }

  reconnectPanel(ctx: WebviewClientContext): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager) return;

    for (const session of ptyManager.getAllSessions()) {
      // Auto-claim controller if the session has no owner.
      // Use assignController (not direct mutation) so workflowRunControllers is
      // updated, then broadcast TERMINAL_CONTROLLER_CHANGED to all clients so
      // no other client keeps thinking it is still the controller.
      if (session.controllerClientId === undefined) {
        ptyManager.assignController(session.id, ctx.clientId);
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
          workflowId: session.workflowId,
          sessionId: session.id,
          controllerClientId: ctx.clientId,
        });
      }
      const terminalStartedMessage: TerminalStartedMessage = {
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId: session.workflowId,
        sessionId: session.id,
        stepName: session.stepName,
        stepIndex: session.stepIndex,
        kind: session.kind,
        promptNumber: session.promptNumber,
        harnessId: session.harnessId,
        parallelGroupId: session.parallelGroupId,
        shellKind: session.shellKind,
        controllerClientId: session.controllerClientId,
      };
      ctx.emit(terminalStartedMessage);
      for (const chunk of session.reconnectBuffer) {
        ctx.emit({
          type: MESSAGE_TYPES.TERMINAL_OUTPUT,
          workflowId: session.workflowId,
          sessionId: session.id,
          data: chunk,
        });
      }
      session.clearReconnectBuffer();
    }
  }

  handleInput(ctx: WebviewClientContext, message: any): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.sessionId || !message.data) return;
    const session = ptyManager.getSession(message.sessionId as string);
    if (!session || !this.isController(session, ctx)) return;
    ptyManager.writeToSession(
      message.sessionId as string,
      message.data as string
    );
  }

  handleResize(ctx: WebviewClientContext, message: any): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.sessionId || !message.cols || !message.rows)
      return;
    const session = ptyManager.getSession(message.sessionId as string);
    if (!session || !this.isController(session, ctx)) return;

    ptyManager.resizeSession(
      message.sessionId as string,
      message.cols as number,
      message.rows as number
    );
    // Broadcast the new dimensions to all clients so viewers can match the
    // controller's terminal width and avoid line-wrap display artifacts.
    ptyPostMessage({
      type: MESSAGE_TYPES.TERMINAL_SIZE_CHANGED,
      workflowId: session.workflowId,
      sessionId: session.id,
      cols: message.cols as number,
      rows: message.rows as number,
    });
  }

  handleViewportHint(ctx: WebviewClientContext, message: any): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.cols || !message.rows) return;
    // Store the viewport under THIS client's id. spawnPty reads only the
    // resolved controller's entry, so a viewer's (or another controller's) hint
    // can never affect a spawn controlled by a different client — no gate needed.
    ptyManager.setSpawnDimensions(
      ctx.clientId,
      message.cols as number,
      message.rows as number
    );
  }

  handleSpawnShell(ctx: WebviewClientContext, message: any): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.workflowId) return;
    const workflowId = message.workflowId as string;
    const cwd = (message.cwd as string | undefined) ?? process.cwd();
    let session: PtySession;
    try {
      session = ptyManager.spawnShell({
        workflowId,
        cwd,
        ...this.buildSessionCallbacks(),
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      Log.warn(
        `[TerminalMessageHandlers] Failed to spawn embedded shell: ${errorMessage}`
      );
      ctx.emit({
        type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
        action: "spawn embedded shell",
        error: errorMessage,
      });
      return;
    }
    // Register the spawning client as controller and update workflowRunControllers
    // so that subsequent restarts inherit the same controller via assignController.
    ptyManager.assignController(session.id, ctx.clientId);
    const terminalStartedMessage: TerminalStartedMessage = {
      type: MESSAGE_TYPES.TERMINAL_STARTED,
      workflowId,
      sessionId: session.id,
      stepName: session.stepName,
      stepIndex: session.stepIndex,
      kind: SESSION_KINDS.SHELL,
      shellKind: session.shellKind,
      controllerClientId: session.controllerClientId,
    };
    ptyPostMessage(terminalStartedMessage);
  }

  handleRestartShell(message: any): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.sessionId || !message.workflowId) return;
    const workflowId = message.workflowId as string;
    let newSession: PtySession | undefined;
    try {
      newSession = ptyManager.restartShellSession(
        message.sessionId as string,
        this.buildSessionCallbacks()
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      Log.warn(
        `[TerminalMessageHandlers] Failed to restart embedded shell: ${errorMessage}`
      );
      notifyUserFeedback(
        this.getUserFeedbackSink(),
        USER_FEEDBACK_SEVERITY.WARNING,
        errorMessage
      );
      return;
    }
    if (newSession) {
      const terminalStartedMessage: TerminalStartedMessage = {
        type: MESSAGE_TYPES.TERMINAL_STARTED,
        workflowId,
        sessionId: newSession.id,
        stepName: newSession.stepName,
        stepIndex: newSession.stepIndex,
        kind: SESSION_KINDS.SHELL,
        shellKind: newSession.shellKind,
        controllerClientId: newSession.controllerClientId,
      };
      ptyPostMessage(terminalStartedMessage);
    }
  }

  handleCloseShell(message: any): void {
    const ptyManager = getPtyProcessManager();
    if (ptyManager && message.sessionId) {
      ptyManager.killSession(
        message.sessionId as string,
        TERMINAL_END_REASONS.CLOSED
      );
    }
  }

  async handleCloseAiCli(message: any): Promise<void> {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.sessionId) return;
    await ptyManager.gracefulKillAiCliSession(
      message.sessionId as string,
      TERMINAL_END_REASONS.CLOSED
    );
  }

  handleClaimControl(ctx: WebviewClientContext, message: any): void {
    const ptyManager = getPtyProcessManager();
    if (!ptyManager || !message.sessionId || !message.workflowId) return;
    const session = ptyManager.assignController(
      message.sessionId as string,
      ctx.clientId
    );
    if (session) {
      // Broadcast updated controller to all clients so they can update isController.
      ptyPostMessage({
        type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
        workflowId: session.workflowId,
        sessionId: session.id,
        controllerClientId: session.controllerClientId,
      });
    }
  }

  private isController(
    session: PtySession,
    ctx: WebviewClientContext
  ): boolean {
    // An unowned session accepts input from any client until one claims control.
    return (
      session.controllerClientId === undefined ||
      ctx.clientId === session.controllerClientId
    );
  }

  private buildSessionCallbacks(): SessionCallbacks {
    return {
      onData: (session, chunk) => {
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_OUTPUT,
          workflowId: session.workflowId,
          sessionId: session.id,
          data: chunk,
        });
      },
      onExit: (session, exitCode) => {
        ptyPostMessage(buildTerminalEndedMessage(session, exitCode));
      },
    };
  }
}
