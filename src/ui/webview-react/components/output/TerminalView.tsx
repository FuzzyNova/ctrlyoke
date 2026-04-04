import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Panel,
  Group,
  Separator,
  PanelImperativeHandle,
} from "react-resizable-panels";
import { sendMessage } from "@hooks/useMessageHandler";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { terminalRegistry } from "../../terminalRegistry";
import {
  MESSAGE_TYPES,
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
} from "../../types/messages";
import { TerminalInstance } from "./TerminalInstance";
import type { TerminalSession } from "@store/terminalStore";
import { SEPARATOR_VERTICAL } from "../../constants";

// Stable empty fallback — avoids infinite re-render from `?? []` in useSyncExternalStore.
const EMPTY_SESSIONS: TerminalSession[] = [];

interface TerminalViewProps {
  workflowId: string;
}

/**
 * Per-workflow terminal container.
 *
 * Layout: horizontal resizable Group
 *   Left: terminal canvas (flex-1, all TerminalInstances mounted, only active is visible)
 *   Right: session rail (resizable, collapsible, max 50% of parent)
 *
 * When the session rail is collapsed it shows compact numbered entries that
 * are still clickable so users can switch terminals without expanding the rail.
 * The "New Terminal" button lives in the OutputSection header above this view.
 */
export const TerminalView: React.FC<TerminalViewProps> = ({ workflowId }) => {
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const activeSessionId = useTerminalStore(
    (s) => s.activeSessionIds[workflowId] ?? null
  );
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const removeSession = useTerminalStore((s) => s.removeSession);

  const terminalRailCollapsed = useUiStore((s) => s.terminalRailCollapsed);
  const terminalRailSizePx = useUiStore((s) => s.terminalRailSizePx);
  const setTerminalRailCollapsed = useUiStore(
    (s) => s.setTerminalRailCollapsed
  );
  const setTerminalRailSizePx = useUiStore((s) => s.setTerminalRailSizePx);

  const [railCollapsed, setRailCollapsed] = useState(terminalRailCollapsed);
  const railRef = useRef<PanelImperativeHandle>(null);
  // Snapshot persisted values once on mount — defaultSize must not change after mount
  // or react-resizable-panels will re-apply it, overriding user drag interactions.
  const initialRailSizePx = useRef(terminalRailSizePx);
  // Snapshot collapsed state for defaultSize calculation (ref so it never changes).
  const initialRailCollapsed = useRef(terminalRailCollapsed);
  // Gate: block ALL onResize store writes until after mount effects have settled.
  // Follows the same pattern as App.tsx (horizontalInitializedRef).
  const railResizeMountedRef = useRef(false);

  // Restore collapsed state before paint so there is no visual flash on remount
  // (tab switch). Using useLayoutEffect matches the App.tsx pattern.
  useLayoutEffect(() => {
    if (initialRailCollapsed.current) {
      railRef.current?.collapse();
    }
  }, []);

  // Open the onResize gate after ALL mount layout effects and effects have fired.
  // useEffect runs after child effects (including the Panel mount onResize events
  // and the useLayoutEffect above), so spurious mount events never reach the store.
  useEffect(() => {
    railResizeMountedRef.current = true;
  }, []);

  const aiCliSessions = sessions.filter((s) => s.kind === SESSION_KINDS.AI_CLI);
  const shellSessions = sessions.filter((s) => s.kind === SESSION_KINDS.SHELL);
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

  return (
    <Group
      orientation="horizontal"
      className="w-full h-full"
      id="terminal-view-layout"
      resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
    >
      {/* Terminal canvas */}
      <Panel id="terminal-canvas">
        <div className="h-full bg-[var(--vscode-terminal-background,var(--vscode-editor-background))]">
          {sessions.length === 0 ? (
            <div className="flex items-center justify-center h-full text-description-fg text-[12px] select-none">
              Starting shell…
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
      </Panel>

      <Separator className={SEPARATOR_VERTICAL} />

      {/* Session rail — resizable, collapsible to compact numbered view */}
      <Panel
        id="terminal-session-rail"
        panelRef={railRef}
        defaultSize={
          initialRailCollapsed.current
            ? "30px"
            : `${initialRailSizePx.current}px`
        }
        minSize="80px"
        maxSize="50"
        collapsible
        collapsedSize="30px"
        onResize={(panelSize) => {
          if (!railResizeMountedRef.current) return;
          const collapsed = railRef.current?.isCollapsed() ?? false;
          setRailCollapsed(collapsed);
          setTerminalRailCollapsed(collapsed);
          if (!collapsed) {
            setTerminalRailSizePx(panelSize.inPixels);
          }
        }}
      >
        <div className="flex flex-col h-full bg-sidebar-bg overflow-y-auto">
          {/* AI CLI sessions */}
          {aiCliSessions.map((session, idx) =>
            railCollapsed ? (
              <CompactRailEntry
                key={session.id}
                session={session}
                label={String(session.promptNumber ?? idx + 1)}
                isActive={session.id === activeSessionId}
                onClick={() => setActiveSession(workflowId, session.id)}
              />
            ) : (
              <RailEntry
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => setActiveSession(workflowId, session.id)}
              />
            )
          )}

          {/* Divider between ai-cli and shell sections */}
          {hasBothKinds && (
            <div className="border-t border-panel-border my-1 flex-shrink-0" />
          )}

          {/* Shell sessions */}
          {shellSessions.map((session) =>
            railCollapsed ? (
              <CompactRailEntry
                key={session.id}
                session={session}
                label="sh"
                isActive={session.id === activeSessionId}
                onClick={() => setActiveSession(workflowId, session.id)}
              />
            ) : (
              <ShellRailEntry
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => setActiveSession(workflowId, session.id)}
                onRestart={() => handleRestartShell(session)}
                onClose={() => handleCloseShell(session)}
              />
            )
          )}

          {!railCollapsed && <div className="flex-1" />}
        </div>
      </Panel>
    </Group>
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

const RailEntry: React.FC<RailEntryProps> = ({
  session,
  isActive,
  onClick,
}) => {
  const isRunning = session.status === TERMINAL_SESSION_STATUS.RUNNING;

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
  const isEnded = session.status !== TERMINAL_SESSION_STATUS.RUNNING;

  return (
    <div
      role="tab"
      tabIndex={0}
      className={`flex items-center gap-1 px-2 py-1.5 text-[11px] flex-shrink-0 cursor-pointer transition-colors
        ${isActive ? "bg-list-active-bg text-foreground" : "text-description-fg hover:text-foreground hover:bg-list-hover-bg"}
        ${isEnded ? "opacity-60" : ""}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={session.stepName}
    >
      <StatusDot status={session.status} />
      <span className="truncate flex-1">{session.stepName}</span>
      {isEnded && (
        <button
          className="icon-btn py-0 px-0.5 opacity-70 hover:opacity-100 flex-shrink-0"
          title="Restart"
          onClick={(e) => {
            e.stopPropagation();
            onRestart();
          }}
        >
          <i className="codicon codicon-refresh text-[11px]" />
        </button>
      )}
      <button
        className="icon-btn py-0 px-0.5 opacity-70 hover:opacity-100 flex-shrink-0"
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <i className="codicon codicon-close text-[11px]" />
      </button>
    </div>
  );
};

interface CompactRailEntryProps {
  session: TerminalSession;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

/** Collapsed rail entry — shown when the session rail is narrow (≤40px). */
const CompactRailEntry: React.FC<CompactRailEntryProps> = ({
  session,
  label,
  isActive,
  onClick,
}) => (
  <button
    className={`flex flex-col items-center justify-center gap-0.5 py-2 w-full flex-shrink-0 transition-colors
      ${isActive ? "bg-list-active-bg text-foreground" : "text-description-fg hover:text-foreground hover:bg-list-hover-bg"}`}
    onClick={onClick}
    title={session.stepName}
  >
    <StatusDot status={session.status} />
    <span className="text-[9px] font-mono">{label}</span>
  </button>
);

const StatusDot: React.FC<{ status: TerminalSession["status"] }> = ({
  status,
}) => {
  if (status === TERMINAL_SESSION_STATUS.RUNNING) {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
    );
  }
  if (status === TERMINAL_SESSION_STATUS.FAILED) {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
    );
  }
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full bg-description-fg/50 flex-shrink-0" />
  );
};
