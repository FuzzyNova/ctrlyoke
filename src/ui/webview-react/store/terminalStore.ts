import { create } from "zustand";

export type SessionKind = "ai-cli" | "shell";

export interface TerminalSession {
  id: string;
  workflowId: string;
  stepName: string;
  kind: SessionKind;
  status: "running" | "completed" | "failed";
  /** Chunks buffered before TerminalInstance mounts — flushed on mount */
  pendingOutput: string[];
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

  pushPendingOutput: (workflowId: string, sessionId: string, chunk: string) => void;
  clearPendingOutput: (workflowId: string, sessionId: string) => void;

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
            ? { ...s, status: (exitCode === 0 ? "completed" : "failed") as TerminalSession["status"] }
            : s
        );
        return { sessions: { ...state.sessions, [workflowId]: sessions } };
      }),

    setActiveSession: (workflowId, sessionId) =>
      set((state) => ({
        activeSessionIds: { ...state.activeSessionIds, [workflowId]: sessionId },
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
          activeSessionIds: { ...state.activeSessionIds, [workflowId]: newActive },
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

    clearAiCliSessions: (workflowId) =>
      set((state) => {
        const sessions = (state.sessions[workflowId] ?? []).filter(
          (s) => s.kind !== "ai-cli"
        );
        const currentActive = state.activeSessionIds[workflowId];
        const removedIds = new Set(
          (state.sessions[workflowId] ?? [])
            .filter((s) => s.kind === "ai-cli")
            .map((s) => s.id)
        );
        const newActive =
          currentActive && removedIds.has(currentActive)
            ? (sessions[sessions.length - 1]?.id ?? null)
            : currentActive;
        return {
          sessions: { ...state.sessions, [workflowId]: sessions },
          activeSessionIds: { ...state.activeSessionIds, [workflowId]: newActive },
        };
      }),
  })
);
