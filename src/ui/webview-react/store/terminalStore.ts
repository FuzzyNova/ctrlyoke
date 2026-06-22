import { create } from "zustand";
import {
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
  type TerminalSessionStatus,
  type SessionKind,
  type ShellKind,
} from "../types/messages";

export type { SessionKind };

export interface TerminalSession {
  id: string;
  workflowId: string;
  stepName: string;
  kind: SessionKind;
  promptNumber?: number;
  /** HarnessId for AI CLI sessions (e.g. "claude-cli"). Undefined for shell sessions. */
  harnessId?: string;
  /** Shell variant for SHELL sessions. Undefined for ai-cli sessions. */
  shellKind?: ShellKind;
  status: TerminalSessionStatus;
  /**
   * True when this client owns interactive control of the PTY (input + resize).
   * Defaults to true optimistically; updated by TERMINAL_CONTROLLER_CHANGED.
   * When false, the terminal renders in view-only mode with a badge.
   */
  isController: boolean;
  /**
   * Column count of the controller's PTY, broadcast via TERMINAL_SIZE_CHANGED.
   * Used by viewer clients to lock their xterm width to the controller's so that
   * line-wrapping in the output matches exactly.
   */
  controllerCols?: number;
  /**
   * Row count of the controller's PTY, broadcast via TERMINAL_SIZE_CHANGED.
   * Viewer clients lock their xterm height to this so the rendered grid mirrors
   * the controller exactly — required for TUI / alternate-buffer apps whose
   * output is positioned for the controller's precise row count.
   */
  controllerRows?: number;
}

interface TerminalState {
  /** workflowId → ordered list of sessions */
  sessions: Record<string, TerminalSession[]>;
  /** workflowId → currently active sessionId in the rail */
  activeSessionIds: Record<string, string | null>;
}

interface TerminalActions {
  addSession: (session: TerminalSession) => void;
  updateSessionMetadata: (
    workflowId: string,
    sessionId: string,
    metadata: Partial<
      Pick<
        TerminalSession,
        "stepName" | "promptNumber" | "harnessId" | "shellKind" | "status"
      >
    >
  ) => void;
  endSession: (workflowId: string, sessionId: string, exitCode: number) => void;
  setActiveSession: (workflowId: string, sessionId: string) => void;
  /** Explicitly close/remove a session (user × button on shell sessions) */
  removeSession: (workflowId: string, sessionId: string) => void;

  /** Update isController for a session when TERMINAL_CONTROLLER_CHANGED arrives */
  setSessionController: (
    workflowId: string,
    sessionId: string,
    isController: boolean
  ) => void;

  /** Store the controller's PTY dimensions when TERMINAL_SIZE_CHANGED arrives */
  setSessionControllerSize: (
    workflowId: string,
    sessionId: string,
    cols: number,
    rows?: number
  ) => void;

  /** Called on new run start — clears only ai-cli sessions; shell sessions survive */
  clearAiCliSessions: (workflowId: string) => void;

  /** Revive a previously ended ai-cli session back to RUNNING (inject mode resume) */
  resumeSession: (workflowId: string, sessionId: string) => void;
}

const initialState: TerminalState = {
  sessions: {},
  activeSessionIds: {},
};

export const useTerminalStore = create<TerminalState & TerminalActions>()(
  (set) => ({
    ...initialState,

    addSession: (session) =>
      set((state) => {
        const existing = state.sessions[session.workflowId] ?? [];
        return {
          sessions: {
            ...state.sessions,
            [session.workflowId]: [...existing, session],
          },
          // Auto-activate new sessions
          activeSessionIds: {
            ...state.activeSessionIds,
            [session.workflowId]: session.id,
          },
        };
      }),

    updateSessionMetadata: (workflowId, sessionId, metadata) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId ? { ...s, ...metadata } : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    endSession: (workflowId, sessionId, exitCode) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status:
                  exitCode === 0
                    ? TERMINAL_SESSION_STATUS.COMPLETED
                    : TERMINAL_SESSION_STATUS.FAILED,
              }
            : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    setActiveSession: (workflowId, sessionId) =>
      set((state) => ({
        activeSessionIds: {
          ...state.activeSessionIds,
          [workflowId]: sessionId,
        },
      })),

    removeSession: (workflowId, sessionId) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).filter(
          (s) => s.id !== sessionId
        );
        const currentActive = state.activeSessionIds[workflowId];
        const newActive =
          currentActive === sessionId
            ? (sessions[sessions.length - 1]?.id ?? null)
            : currentActive;
        return {
          sessions: { ...state.sessions, [workflowId]: sessions },
          activeSessionIds: {
            ...state.activeSessionIds,
            [workflowId]: newActive,
          },
        };
      }),

    setSessionController: (workflowId, sessionId, isController) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId ? { ...s, isController } : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    setSessionControllerSize: (workflowId, sessionId, cols, rows) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId
            ? {
                ...s,
                controllerCols: cols,
                ...(rows != null ? { controllerRows: rows } : {}),
              }
            : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    resumeSession: (workflowId, sessionId) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId
            ? { ...s, status: TERMINAL_SESSION_STATUS.RUNNING }
            : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    clearAiCliSessions: (workflowId) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).filter(
          (s) => s.kind !== SESSION_KINDS.AI_CLI
        );
        const currentActive = state.activeSessionIds[workflowId];
        const removedIds = new Set(
          (state.sessions[workflowId] ?? [])
            .filter((s) => s.kind === SESSION_KINDS.AI_CLI)
            .map((s) => s.id)
        );
        const newActive =
          currentActive && removedIds.has(currentActive)
            ? (sessions[sessions.length - 1]?.id ?? null)
            : currentActive;
        return {
          sessions: { ...state.sessions, [workflowId]: sessions },
          activeSessionIds: {
            ...state.activeSessionIds,
            [workflowId]: newActive,
          },
        };
      }),
  })
);
