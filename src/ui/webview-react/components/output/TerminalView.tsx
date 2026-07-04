import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Panel,
  Group,
  Separator,
  PanelImperativeHandle,
} from "react-resizable-panels";
import { sendMessage } from "@hooks/useMessageHandler";
import { useMobileTerminalBar } from "@hooks/useMobileTerminalBar";
import { useLongPress } from "@hooks/useLongPress";
import { useTerminalContextMenu } from "@hooks/useTerminalContextMenu";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { terminalRegistry } from "../../terminalRegistry";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
} from "../../types/messages";
import { TerminalInstance } from "./TerminalInstance";
import { TerminalControlBar } from "./TerminalControlBar";
import type { TerminalSession } from "@store/terminalStore";
import { SEPARATOR_VERTICAL } from "../../constants";
import { TerminalSessionIcon } from "./TerminalSessionIcon";
import { getShellCompactLabel } from "@utils/terminalPresentation";
import { WebviewLog } from "@utils/logger";

// Stable empty fallback — avoids infinite re-render from `?? []` in useSyncExternalStore.
const EMPTY_SESSIONS: TerminalSession[] = [];

interface TerminalViewProps {
  workflowId: string;
}

// Clamp the terminal to the visible viewport when a mobile keyboard overlaps
// the layout viewport. The control bar then remains the terminal footer rather
// than becoming a keyboard-height spacer inside the terminal.
function useVisibleTerminalHeight(
  containerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
): number | null {
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled) {
      setVisibleHeight(null);
      return;
    }

    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      setVisibleHeight(null);
      return;
    }

    let animationFrame = 0;
    const updateVisibleHeight = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const container = containerRef.current;
        const parent = container?.parentElement;
        if (!container || !parent) {
          setVisibleHeight(null);
          return;
        }

        const parentRect = parent.getBoundingClientRect();
        const viewportBottom = visualViewport.offsetTop + visualViewport.height;
        const availableHeight = Math.floor(
          Math.max(0, viewportBottom - parentRect.top)
        );
        const naturalHeight = Math.round(parentRect.height);

        setVisibleHeight(
          availableHeight > 0 && availableHeight < naturalHeight - 1
            ? availableHeight
            : null
        );
      });
    };

    updateVisibleHeight();
    visualViewport.addEventListener("resize", updateVisibleHeight);
    visualViewport.addEventListener("scroll", updateVisibleHeight);
    window.addEventListener("resize", updateVisibleHeight);
    window.addEventListener("focusin", updateVisibleHeight);
    window.addEventListener("focusout", updateVisibleHeight);

    // The available terminal region also changes without any viewport/window
    // event — e.g. the editor panel auto-expanding when its keyboard opens, a
    // separator drag, or the session rail collapsing. Those shrink the parent
    // via react-resizable-panels, and without recomputing the container keeps a
    // now-too-tall explicit height, overflowing downward so the control bar
    // hides behind the editor section. Observe the parent to re-clamp on any
    // layout-driven resize. Observe the parent only (not the container): our
    // own height write never changes the parent, so there is no feedback loop.
    const observedParent = containerRef.current?.parentElement ?? null;
    const resizeObserver =
      observedParent && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateVisibleHeight)
        : null;
    resizeObserver?.observe(observedParent as Element);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      visualViewport.removeEventListener("resize", updateVisibleHeight);
      visualViewport.removeEventListener("scroll", updateVisibleHeight);
      window.removeEventListener("resize", updateVisibleHeight);
      window.removeEventListener("focusin", updateVisibleHeight);
      window.removeEventListener("focusout", updateVisibleHeight);
    };
  }, [containerRef, enabled]);

  return visibleHeight;
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

  const executionState = useWorkflowStore((s) => s.executionState);
  const isWorkflowExecuting =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.CANCELLING;

  const terminalRailCollapsed = useUiStore((s) => s.terminalRailCollapsed);
  const terminalRailSizePx = useUiStore((s) => s.terminalRailSizePx);
  const setTerminalRailCollapsed = useUiStore(
    (s) => s.setTerminalRailCollapsed
  );
  const setActiveOutputTab = useUiStore((s) => s.setActiveOutputTab);
  const setTerminalRailSizePx = useUiStore((s) => s.setTerminalRailSizePx);

  const [railCollapsed, setRailCollapsed] = useState(terminalRailCollapsed);
  const viewportRef = useRef<HTMLDivElement>(null);
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
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  useEffect(() => {
    WebviewLog.debug(
      `[TerminalView] workflow=${workflowId.slice(0, 8)} sessions=${sessions.length} activeSession=${activeSessionId?.slice(0, 8) ?? "none"} ` +
        `activeController=${activeSession?.isController ?? "n/a"} activeStatus=${activeSession?.status ?? "none"} ` +
        `singleSession=${sessions.length === 1}`
    );
  }, [
    workflowId,
    sessions.length,
    activeSessionId,
    activeSession?.isController,
    activeSession?.status,
  ]);

  const handleCloseSession = useCallback(
    (session: TerminalSession) => {
      if (session.kind === SESSION_KINDS.SHELL) {
        sendMessage(MESSAGE_TYPES.TERMINAL_CLOSE_SHELL, {
          workflowId,
          sessionId: session.id,
        });
      } else {
        sendMessage(MESSAGE_TYPES.TERMINAL_CLOSE_AI_CLI, {
          workflowId,
          sessionId: session.id,
        });
      }
      terminalRegistry.clearSession(workflowId, session.id);
      removeSession(workflowId, session.id);
      const remaining = useTerminalStore.getState().sessions[workflowId] ?? [];
      if (remaining.length === 0) {
        setActiveOutputTab(workflowId, "output");
      }
    },
    [workflowId, removeSession, setActiveOutputTab]
  );

  const { openContextMenu, terminalContextMenuPortal } = useTerminalContextMenu(
    {
      workflowId,
      activeSession,
      isExecutionActive: isWorkflowExecuting,
      onClose: handleCloseSession,
    }
  );

  const terminalLongPressHandlers = useLongPress(openContextMenu);
  const { shouldShow: shouldShowMobileTerminalBar } = useMobileTerminalBar();
  const showControlBar =
    shouldShowMobileTerminalBar &&
    activeSessionId !== null &&
    activeSession?.isController !== false &&
    activeSession?.status === TERMINAL_SESSION_STATUS.RUNNING;
  const visibleTerminalHeight = useVisibleTerminalHeight(
    viewportRef,
    showControlBar
  );

  function handleCloseShell(session: TerminalSession) {
    sendMessage(MESSAGE_TYPES.TERMINAL_CLOSE_SHELL, {
      workflowId,
      sessionId: session.id,
    });
    terminalRegistry.clearSession(workflowId, session.id);
    removeSession(workflowId, session.id);
  }

  function handleCloseAiCliSession(session: TerminalSession) {
    sendMessage(MESSAGE_TYPES.TERMINAL_CLOSE_AI_CLI, {
      workflowId,
      sessionId: session.id,
    });
    terminalRegistry.clearSession(workflowId, session.id);
    removeSession(workflowId, session.id);
    // If this was the last session, switch back to output tab immediately
    const remaining = useTerminalStore.getState().sessions[workflowId] ?? [];
    if (remaining.length === 0) {
      setActiveOutputTab(workflowId, "output");
    }
  }

  return (
    <div
      ref={viewportRef}
      className="w-full h-full min-h-0"
      style={
        visibleTerminalHeight !== null
          ? { height: `${visibleTerminalHeight}px` }
          : undefined
      }
    >
      <Group
        orientation="horizontal"
        className="w-full h-full"
        id="terminal-view-layout"
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        {/* Terminal canvas */}
        <Panel id="terminal-canvas">
          <div className="h-full flex flex-col bg-terminal-bg">
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div
              className="flex-1 min-h-0 relative"
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(e.clientX, e.clientY);
              }}
              {...terminalLongPressHandlers}
            >
              {sessions.length === 0 ? (
                <div className="flex items-center justify-center h-full text-description-fg text-xs select-none">
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
            {showControlBar && activeSessionId && (
              <TerminalControlBar
                workflowId={workflowId}
                sessionId={activeSessionId}
              />
            )}
          </div>
        </Panel>

        {sessions.length > 1 && (
          <>
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
                      onClose={
                        !isWorkflowExecuting
                          ? () => handleCloseAiCliSession(session)
                          : undefined
                      }
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
                      label={getShellCompactLabel(
                        session.shellKind,
                        session.stepName
                      )}
                      isActive={session.id === activeSessionId}
                      onClick={() => setActiveSession(workflowId, session.id)}
                    />
                  ) : (
                    <ShellRailEntry
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => setActiveSession(workflowId, session.id)}
                      onClose={() => handleCloseShell(session)}
                    />
                  )
                )}

                {!railCollapsed && <div className="flex-1" />}
              </div>
            </Panel>
          </>
        )}
      </Group>
      {terminalContextMenuPortal}
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
  onClose?: () => void;
}

const RailEntry: React.FC<RailEntryProps> = ({
  session,
  isActive,
  onClick,
  onClose,
}) => {
  const isRunning = session.status === TERMINAL_SESSION_STATUS.RUNNING;

  return (
    <div
      role="tab"
      tabIndex={0}
      className={`flex items-center gap-1 px-2 py-1.5 text-xs flex-shrink-0 cursor-pointer transition-colors
        ${isActive ? "bg-list-active-bg text-foreground" : "text-description-fg hover:text-foreground hover:bg-list-hover-bg"}
        ${!isRunning ? "opacity-60" : ""}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={session.stepName}
    >
      <SessionIcon session={session} />
      <span className="truncate flex-1">{session.stepName}</span>
      {onClose && (
        <button
          className="icon-btn py-0 px-0.5 opacity-70 hover:opacity-100 flex-shrink-0"
          title="Close terminal"
          aria-label="Close terminal"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <i className="codicon codicon-trash text-xs" />
        </button>
      )}
    </div>
  );
};

interface ShellRailEntryProps extends RailEntryProps {
  onClose: () => void;
}

const ShellRailEntry: React.FC<ShellRailEntryProps> = ({
  session,
  isActive,
  onClick,
  onClose,
}) => {
  const isEnded = session.status !== TERMINAL_SESSION_STATUS.RUNNING;

  return (
    <div
      role="tab"
      tabIndex={0}
      className={`flex items-center gap-1 px-2 py-1.5 text-xs flex-shrink-0 cursor-pointer transition-colors
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
      <SessionIcon session={session} />
      <span className="truncate flex-1">{session.stepName}</span>
      <button
        className="icon-btn py-0 px-0.5 opacity-70 hover:opacity-100 flex-shrink-0"
        title="Close terminal"
        aria-label="Close terminal"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <i className="codicon codicon-trash text-xs" />
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
    <SessionIcon session={session} />
    <span className="text-xxs font-mono">{label}</span>
  </button>
);

const SessionIcon: React.FC<{ session: TerminalSession }> = ({ session }) => (
  <TerminalSessionIcon session={session} />
);
