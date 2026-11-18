import {
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  USER_FEEDBACK_SEVERITY,
} from "../types/DashboardConstants";
import {
  buildTerminalEndedMessage,
  buildTerminalOpenTabsMessage,
  buildTerminalStartedMessage,
  claimTerminalsOnReplay,
  getPtyProcessManager,
  ptyPostMessage,
  type PtyProcessManager,
  type PtySession,
  type SpawnPtyOptions,
} from "../core/harness/PtyProcessManager";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";
import type { DashboardClientContext } from "./DashboardClientContext";

type SessionCallbacks = Pick<SpawnPtyOptions, "onData" | "onExit">;

/**
 * Resolves the directory a user shell for `workflowId` starts in: the
 * workflow's execution root (its worktree while one is active), falling back
 * to the workspace root. Returns `undefined` when neither is known.
 */
export type ShellCwdResolver = (workflowId: string) => string | undefined;

/**
 * Embedded-terminal message handlers and panel reconnect replay.
 *
 * PTY messages that represent shared terminal state are broadcast through
 * `ptyPostMessage`; reconnect buffers are sent only to the panel that just
 * recreated its webview.
 */
export class TerminalMessageHandlers {
  constructor(
    private readonly getUserFeedbackSink: () => UserFeedbackSink | undefined,
    private readonly getPtyManager: () => PtyProcessManager | null = getPtyProcessManager,
    private readonly resolveShellCwd: ShellCwdResolver = () => undefined
  ) {}

  /**
   * The panel has this dedicated reconnect path, which sends TERMINAL_STARTED
   * plus reconnect buffers. Orchestrator client-ready replay must therefore skip
   * terminals for the panel to avoid double-sending and the xterm
   * dispose+recreate cycle that caused "briefly see scrollback then goes blank".
   * Browser clients have no separate reconnect loop and use orchestrator replay.
   */
  shouldSkipClientReadyReplay(ctx: DashboardClientContext): boolean {
    return ctx.clientId === PANEL_CLIENT_ID;
  }

  reconnectPanel(ctx: DashboardClientContext): void {
    const ptyManager = this.getPtyManager();
    if (!ptyManager) return;

    // Open tabs, not just live PTYs: an ended tab nobody closed replays ended.
    const sessions = ptyManager.getAllTabs();
    // Claim unowned sessions (or ones awaiting this client's return) before
    // replaying, so each TERMINAL_STARTED below names the right controller.
    for (const workflowId of new Set(sessions.map((s) => s.workflowId))) {
      claimTerminalsOnReplay(ptyManager, workflowId, ctx.clientId);
    }
    for (const session of sessions) {
      const terminalStartedMessage = buildTerminalStartedMessage(session);
      ctx.emit(terminalStartedMessage);
      for (const chunk of session.reconnectBuffer) {
        ctx.emit({
          type: MESSAGE_TYPES.TERMINAL_OUTPUT,
          workflowId: session.workflowId,
          sessionId: session.id,
          data: chunk,
        });
      }
    }
    // Every workflow's tabs were replayed, so the open-tab set is global.
    ctx.emit(buildTerminalOpenTabsMessage(sessions));
  }

  handleInput(ctx: DashboardClientContext, message: any): void {
    const ptyManager = this.getPtyManager();
    if (!ptyManager || !message.sessionId || !message.data) return;
    const session = ptyManager.getSession(message.sessionId as string);
    if (!session || !this.isController(session, ctx)) return;
    ptyManager.noteControllerInput(session.id, message.data as string);
    ptyManager.writeToSession(
      message.sessionId as string,
      message.data as string
    );
  }

  handleResize(ctx: DashboardClientContext, message: any): void {
    const ptyManager = this.getPtyManager();
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

  handleViewportHint(ctx: DashboardClientContext, message: any): void {
    const ptyManager = this.getPtyManager();
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

  handleSpawnShell(ctx: DashboardClientContext, message: any): void {
    const ptyManager = this.getPtyManager();
    if (!ptyManager || !message.workflowId) return;
    const workflowId = message.workflowId as string;
    // The host picks the directory; a client never supplies a path. A shell
    // opened for a workflow starts where its steps run (the worktree, when
    // the run uses one).
    const cwd = this.resolveShellCwd(workflowId) ?? process.cwd();
    let session: PtySession;
    try {
      session = ptyManager.spawnShell({
        workflowId,
        cwd,
        ...this.buildSessionCallbacks(),
      });
    } catch (error) {
      // The dashboard toasts and logs this failure; no host log line needed.
      const errorMessage = getErrorMessage(error);
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
    const terminalStartedMessage = buildTerminalStartedMessage(session);
    ptyPostMessage(terminalStartedMessage);
  }

  handleRestartShell(message: any): void {
    const ptyManager = this.getPtyManager();
    if (!ptyManager || !message.sessionId || !message.workflowId) return;
    let newSession: PtySession | undefined;
    try {
      newSession = ptyManager.restartShellSession(
        message.sessionId as string,
        this.buildSessionCallbacks()
      );
    } catch (error) {
      notifyUserFeedback(
        this.getUserFeedbackSink(),
        USER_FEEDBACK_SEVERITY.WARNING,
        getErrorMessage(error),
        undefined,
        error
      );
      return;
    }
    if (newSession) {
      const terminalStartedMessage = buildTerminalStartedMessage(newSession);
      ptyPostMessage(terminalStartedMessage);
    }
  }

  /**
   * A tab closed on any client — controller or viewer — closes it for all of
   * them: the PTY is killed if still running and every client is told to drop
   * the tab, including for a session that already exited. Both close messages
   * mean the same thing; closeTab picks the shutdown that suits the kind.
   */
  async handleCloseTab(message: any): Promise<void> {
    const ptyManager = this.getPtyManager();
    if (!ptyManager || !message.sessionId || !message.workflowId) return;
    ptyPostMessage(
      await ptyManager.closeTab(
        message.workflowId as string,
        message.sessionId as string
      )
    );
  }

  handleClaimControl(ctx: DashboardClientContext, message: any): void {
    const ptyManager = this.getPtyManager();
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
    ctx: DashboardClientContext
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
