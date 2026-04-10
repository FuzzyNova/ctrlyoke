import { create } from "zustand";
import {
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
  type TerminalSessionStatus,
  type SessionKind,
} from "../types/messages";

export type { SessionKind };

export interface TerminalSession {
  id: string;
  workflowId: string;
  stepName: string;
  kind: SessionKind;
  promptNumber?: number;
  status: TerminalSessionStatus;
  /** Chunks buffered before TerminalInstance mounts — flushed on mount */
  pendingOutput: string[];
  /**
   * True when this client owns interactive control of the PTY (input + resize).
   * Defaults to true optimistically; updated by TERMINAL_CONTROLLER_CHANGED.
   * When false, the terminal renders in view-only mode with a badge.
   */
  isController: boolean;
}

interface TerminalState {
  /** workflowId → ordered list of sessions */
  sessions: Record<string, TerminalSession[]>;
  /** workflowId → currently active sessionId in the rail */
  activeSessionIds: Record<string, string | null>;
}

interface TerminalActions {
  addSession: (session: TerminalSession) => void;
  endSession: (workflowId: string, sessionId: string, exitCode: number) => void;
  setActiveSession: (workflowId: string, sessionId: string) => void;
  /** Explicitly close/remove a session (user × button on shell sessions) */
  removeSession: (workflowId: string, sessionId: string) => void;

  pushPendingOutput: (
    workflowId: string,
    sessionId: string,
    chunk: string
  ) => void;
  clearPendingOutput: (workflowId: string, sessionId: string) => void;

  /** Update isController for a session when TERMINAL_CONTROLLER_CHANGED arrives */
  setSessionController: (
    workflowId: string,
    sessionId: string,
    isController: boolean
  ) => void;

  /** Called on new run start — clears only ai-cli sessions; shell sessions survive */
  clearAiCliSessions: (workflowId: string) => void;
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

    pushPendingOutput: (workflowId, sessionId, chunk) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId
            ? { ...s, pendingOutput: [...s.pendingOutput, chunk] }
            : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    clearPendingOutput: (workflowId, sessionId) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId ? { ...s, pendingOutput: [] } : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    setSessionController: (workflowId, sessionId, isController) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).map((s) =>
          s.id === sessionId ? { ...s, isController } : s
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
