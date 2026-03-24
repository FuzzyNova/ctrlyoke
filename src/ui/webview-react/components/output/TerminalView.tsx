import React from "react";
import { sendMessage } from "@hooks/useMessageHandler";
import { useTerminalStore } from "@store/terminalStore";
import { terminalRegistry } from "../../terminalRegistry";
import { MESSAGE_TYPES } from "../../types/messages";
import { TerminalInstance } from "./TerminalInstance";
import type { TerminalSession } from "@store/terminalStore";

// Stable empty fallback — avoids infinite re-render from `?? []` in useSyncExternalStore.
const EMPTY_SESSIONS: TerminalSession[] = [];

interface TerminalViewProps {
  workflowId: string;
  /** Absolute path to workspace root (for spawning shell sessions) */
  workspaceRoot?: string;
}

/**
 * Per-workflow terminal container.
 *
 * Layout: flex row
 *   Left: terminal canvas (flex-1, all TerminalInstances mounted, only active is visible)
 *   Right: session rail (fixed ~140px, always visible)
 *
 * The session rail is always visible — it provides the permanent home for
 * the "+" button and matches VS Code's terminal panel behavior.
 */
export const TerminalView: React.FC<TerminalViewProps> = ({
  workflowId,
  workspaceRoot,
}) => {
  const sessions = useTerminalStore((s) => s.sessions[workflowId] ?? EMPTY_SESSIONS);
  const activeSessionId = useTerminalStore(
    (s) => s.activeSessionIds[workflowId] ?? null
  );
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const removeSession = useTerminalStore((s) => s.removeSession);

  const aiCliSessions = sessions.filter((s) => s.kind === "ai-cli");
  const shellSessions = sessions.filter((s) => s.kind === "shell");
  const hasBothKinds = aiCliSessions.length > 0 && shellSessions.length > 0;

  function handleCloseShell(session: TerminalSession) {
    sendMessage(MESSAGE_TYPES.TERMINAL_CLOSE_SHELL, {
      workflowId,
      sessionId: session.id,
    });
    terminalRegistry.clearSession(workflowId, session.id);
    removeSession(workflowId, session.id);
  }

  function handleRestartShell(session: TerminalSession) {
    sendMessage(MESSAGE_TYPES.TERMINAL_RESTART_SHELL, {
      workflowId,
      sessionId: session.id,
    });
  }

  function handleSpawnShell() {
    sendMessage(MESSAGE_TYPES.TERMINAL_SPAWN_SHELL, {
      workflowId,
      cwd: workspaceRoot ?? "",
    });
  }

  return (
    <div className="flex flex-row w-full h-full min-h-0 overflow-hidden">
      {/* Terminal canvas area */}
      <div className="flex-1 min-w-0 h-full overflow-hidden bg-[var(--vscode-terminal-background,var(--vscode-editor-background))]">
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-description-fg text-[12px] select-none">
            Waiting for interactive session…
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalInstance
              key={session.id}
              workflowId={workflowId}
              sessionId={session.id}
              isVisible={session.id === activeSessionId}
            />
          ))
        )}
      </div>

      {/* Session rail */}
      <div
        className="flex flex-col bg-sidebar-bg border-l border-panel-border flex-shrink-0 overflow-y-auto"
        style={{ width: "140px" }}
      >
        {/* AI CLI sessions */}
        {aiCliSessions.map((session) => (
          <RailEntry
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => setActiveSession(workflowId, session.id)}
          />
        ))}

        {/* Divider between ai-cli and shell sections */}
        {hasBothKinds && (
          <div className="border-t border-panel-border my-1 flex-shrink-0" />
        )}

        {/* Shell sessions */}
        {shellSessions.map((session) => (
          <ShellRailEntry
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => setActiveSession(workflowId, session.id)}
            onRestart={() => handleRestartShell(session)}
            onClose={() => handleCloseShell(session)}
          />
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* New Terminal button */}
        <button
          className="flex items-center gap-1 px-2 py-1.5 text-[11px] text-description-fg hover:text-foreground hover:bg-list-hover-bg transition-colors flex-shrink-0 border-t border-panel-border"
          onClick={handleSpawnShell}
          title="New Terminal"
        >
          <i className="codicon codicon-add text-[12px]" />
          <span>New Terminal</span>
        </button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Rail entry components
// ─────────────────────────────────────────────────────────────────────────────

interface RailEntryProps {
  session: TerminalSession;
  isActive: boolean;
  onClick: () => void;
}

const RailEntry: React.FC<RailEntryProps> = ({ session, isActive, onClick }) => {
  const isRunning = session.status === "running";

  return (
    <button
      className={`flex items-center gap-1.5 px-2 py-1.5 text-left w-full transition-colors text-[11px] flex-shrink-0
        ${isActive ? "bg-list-active-bg text-foreground" : "text-description-fg hover:text-foreground hover:bg-list-hover-bg"}
        ${!isRunning ? "opacity-60" : ""}`}
      onClick={onClick}
      title={session.stepName}
    >
      <StatusDot status={session.status} />
      <span className="truncate flex-1">{session.stepName}</span>
    </button>
  );
};

interface ShellRailEntryProps extends RailEntryProps {
  onRestart: () => void;
  onClose: () => void;
}

const ShellRailEntry: React.FC<ShellRailEntryProps> = ({
  session,
  isActive,
  onClick,
  onRestart,
  onClose,
}) => {
  const isEnded = session.status !== "running";

  return (
    <div
      className={`flex items-center gap-1 px-2 py-1.5 text-[11px] flex-shrink-0 cursor-pointer transition-colors
        ${isActive ? "bg-list-active-bg text-foreground" : "text-description-fg hover:text-foreground hover:bg-list-hover-bg"}
        ${isEnded ? "opacity-60" : ""}`}
      onClick={onClick}
      title={session.stepName}
    >
      <StatusDot status={session.status} />
      <span className="truncate flex-1">{session.stepName}</span>
      {isEnded && (
        <button
          className="icon-btn py-0 px-0.5 opacity-70 hover:opacity-100 flex-shrink-0"
          title="Restart"
          onClick={(e) => { e.stopPropagation(); onRestart(); }}
        >
          <i className="codicon codicon-refresh text-[11px]" />
        </button>
      )}
      <button
        className="icon-btn py-0 px-0.5 opacity-70 hover:opacity-100 flex-shrink-0"
        title="Close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      >
        <i className="codicon codicon-close text-[11px]" />
      </button>
    </div>
  );
};

const StatusDot: React.FC<{ status: TerminalSession["status"] }> = ({ status }) => {
  if (status === "running") {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
    );
  }
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full bg-description-fg/50 flex-shrink-0" />
  );
};
