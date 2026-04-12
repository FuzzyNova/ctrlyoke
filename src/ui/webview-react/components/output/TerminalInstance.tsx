import React, { useEffect, useRef } from "react";
import { sendMessage } from "@hooks/useMessageHandler";
import { useTerminalStore } from "@store/terminalStore";
import type { TerminalSession } from "@store/terminalStore";
import { terminalRegistry } from "../../terminalRegistry";
import {
  MESSAGE_TYPES,
  TERMINAL_SESSION_STATUS,
  SESSION_KINDS,
} from "../../types/messages";
import "@xterm/xterm/css/xterm.css";

// Stable empty fallback — avoids infinite re-render from `?? []` in useSyncExternalStore.
const EMPTY_SESSIONS: TerminalSession[] = [];

interface TerminalInstanceProps {
  workflowId: string;
  sessionId: string;
  /** false = display:none (rail switching within workflow) */
  isVisible: boolean;
}

/**
 * Mount-point manager for a single xterm.js terminal session.
 *
 * Delegates all xterm lifecycle to terminalRegistry — this component
 * only manages the DOM attachment point and React lifecycle hooks.
 * xterm.js instances survive React unmounts via the module-level registry.
 *
 * When `session.isController` is false this client is a viewer: xterm output
 * is still rendered but input routing is disabled and a "View Only" badge is shown.
 * The user can click "Take Control" to claim the session.
 */
export const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  workflowId,
  sessionId,
  isVisible,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Subscribe to controller status and controller cols — re-evaluate on every change
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const session = sessions.find((s) => s.id === sessionId);
  const isController = session?.isController ?? true;
  const controllerCols = session?.controllerCols;

  // Mount effect: create registry entry, attach to DOM, flush pending output
  useEffect(() => {
    let cancelled = false;
    console.debug(
      `[TerminalInstance] mount effect start wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
        `isVisible=${isVisible} containerConnected=${containerRef.current?.isConnected ?? false} ` +
        `registryHasEntry=${!!terminalRegistry.get(workflowId, sessionId)}`
    );

    async function mount() {
      if (!containerRef.current) {
        console.debug(`[TerminalInstance] mount aborted — containerRef.current is null`);
        return;
      }

      // Create or retrieve the registry entry (async: dynamic imports)
      const entry = await terminalRegistry.create(workflowId, sessionId);
      if (cancelled || !containerRef.current) {
        console.debug(
          `[TerminalInstance] mount aborted after create — cancelled=${cancelled} containerNull=${!containerRef.current}`
        );
        return;
      }
      console.debug(
        `[TerminalInstance] mount: entry created/retrieved wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
          `isNewEntry=${!entry.term.element}`
      );

      // Flush buffered output immediately after the entry lands in the registry,
      // before attach()'s async WebGL import. Any TERMINAL_OUTPUT messages that
      // arrive after create() completes write directly to entry.term.write(); if
      // we flushed pendingOutput after attach() those earlier chunks would be
      // written out-of-order (after chunks that arrived during the WebGL import).
      const { sessions, clearPendingOutput } = useTerminalStore.getState();
      const sess = (sessions[workflowId] ?? []).find(
        (s) => s.id === sessionId
      );
      if (sess?.pendingOutput.length) {
        for (const chunk of sess.pendingOutput) {
          entry.term.write(chunk);
        }
        clearPendingOutput(workflowId, sessionId);
      }

      // Seed the registry entry with the controller's col count if already known
      // (TERMINAL_SIZE_CHANGED may have arrived before this mount ran).
      // attach()'s requestAnimationFrame checks entry.controllerCols and applies
      // viewer sizing instead of fitAddon.fit() when this is set.
      if (sess?.isController === false && sess.controllerCols != null) {
        entry.controllerCols = sess.controllerCols;
      }

      // Attach the xterm DOM element into this container (async: loads WebGL addon on first open)
      await terminalRegistry.attach(
        workflowId,
        sessionId,
        containerRef.current
      );
      console.debug(
        `[TerminalInstance] attach complete wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
          `domElConnected=${terminalRegistry.get(workflowId, sessionId)?.domEl.isConnected ?? false} ` +
          `containerConnected=${containerRef.current?.isConnected ?? false}`
      );

      // Register onData for input routing — skip if session is frozen, already listening,
      // or this client is a viewer (isController=false)
      const currentSession = useTerminalStore
        .getState()
        .sessions[workflowId]?.find((s) => s.id === sessionId);
      if (!entry.frozen && !entry.onDataDisposable && currentSession?.isController !== false) {
        entry.onDataDisposable = entry.term.onData((input) => {
          sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
            workflowId,
            sessionId,
            data: input,
          });
          // Ad-hoc prompt capture for ai-cli sessions
          const captured = entry.inputCapture.accumulate(input);
          if (captured) {
            // TODO: emit ad-hoc prompt capture event for Output tab attribution
            console.debug("[FlightPath] Ad-hoc prompt captured:", captured);
          }
        });
      }

      // ResizeObserver: fit xterm to container; only the controller notifies the PTY.
      // Viewers keep cols locked to the controller's value to prevent double line-wrap.
      const observer = new ResizeObserver(() => {
        if (!entry.term.element) return;
        try {
          const sessNow = useTerminalStore
            .getState()
            .sessions[workflowId]?.find((s) => s.id === sessionId);
          const isCtrl = sessNow?.isController;
          if (isCtrl !== false) {
            // Controller: fit to container, then report new dimensions to PTY
            entry.fitAddon.fit();
            const { cols, rows } = entry.term;
            sendMessage(MESSAGE_TYPES.TERMINAL_RESIZE, {
              workflowId,
              sessionId,
              cols,
              rows,
            });
          } else if (entry.controllerCols != null) {
            // Viewer: keep cols fixed at controller's width, let rows adapt to
            // the local container height so the terminal fills vertically.
            const dims = entry.fitAddon.proposeDimensions();
            const rows = Math.max(1, dims?.rows ?? entry.term.rows);
            entry.term.resize(entry.controllerCols, rows);
          }
        } catch {
          // Ignore — may fire before terminal is fully initialized
        }
      });

      if (containerRef.current) {
        observer.observe(containerRef.current);
      }
      resizeObserverRef.current = observer;
    }

    mount();

    return () => {
      cancelled = true;
      console.debug(
        `[TerminalInstance] unmount cleanup wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
          `registryHasEntry=${!!terminalRegistry.get(workflowId, sessionId)}`
      );
      // Dispose onData listener so it isn't duplicated when the component remounts
      const entry = terminalRegistry.get(workflowId, sessionId);
      if (entry && !entry.frozen) {
        entry.onDataDisposable?.dispose();
        entry.onDataDisposable = undefined;
      }
      // Detach xterm DOM element from this container (xterm survives in registry)
      terminalRegistry.detach(workflowId, sessionId);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [workflowId, sessionId]);

  // When isController changes from false→true (viewer claiming control), re-register onData
  // and restore fit-to-container sizing.
  useEffect(() => {
    if (!isController) return;
    const entry = terminalRegistry.get(workflowId, sessionId);
    if (!entry || entry.frozen || entry.onDataDisposable) return;
    entry.onDataDisposable = entry.term.onData((input) => {
      sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
        workflowId,
        sessionId,
        data: input,
      });
      const captured = entry.inputCapture.accumulate(input);
      if (captured) {
        console.debug("[FlightPath] Ad-hoc prompt captured:", captured);
      }
    });
    // Becoming controller: restore fit-to-container sizing.
    // If we were previously a viewer, also send TERMINAL_RESIZE so the PTY is
    // updated to our local viewport size and TERMINAL_SIZE_CHANGED is broadcast
    // to all other viewers — without this they stay at the old controller's width.
    const wasViewer = entry.controllerCols != null;
    terminalRegistry.clearControllerSize(workflowId, sessionId);
    if (wasViewer && !entry.frozen) {
      requestAnimationFrame(() => {
        try {
          entry.fitAddon.fit();
          const { cols, rows } = entry.term;
          sendMessage(MESSAGE_TYPES.TERMINAL_RESIZE, {
            workflowId,
            sessionId,
            cols,
            rows,
          });
        } catch {
          // Ignore — terminal may not be visible
        }
      });
    }
  }, [isController, workflowId, sessionId]);

  // When isController changes from true→false (control claimed by another client),
  // dispose onData and apply the controller's known column width.
  useEffect(() => {
    if (isController) return;
    const entry = terminalRegistry.get(workflowId, sessionId);
    if (!entry || entry.frozen) return;
    entry.onDataDisposable?.dispose();
    entry.onDataDisposable = undefined;
    // Apply controller sizing if we already know it (TERMINAL_SIZE_CHANGED may have
    // arrived before this effect fired, or arrives later and triggers reapplication)
    if (entry.controllerCols != null) {
      terminalRegistry.applyControllerSize(workflowId, sessionId, entry.controllerCols);
    }
  }, [isController, workflowId, sessionId]);

  // When controllerCols changes while already a viewer, reapply the new size.
  // This handles the case where TERMINAL_SIZE_CHANGED arrives after isController
  // has already been set to false.
  useEffect(() => {
    if (isController || controllerCols == null) return;
    terminalRegistry.applyControllerSize(workflowId, sessionId, controllerCols);
  }, [controllerCols, isController, workflowId, sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: isVisible ? "flex" : "none",
        flexDirection: "column",
        position: "relative",
        // Controllers fill their container with no overflow (fitAddon sizes exactly).
        // Viewers lock xterm to the controller's col-width; if narrower they get a
        // horizontal scrollbar, if wider the xterm is centered via auto margins.
        overflowX: isController ? "hidden" : "auto",
        overflowY: "hidden",
      }}
    >
      {/* "Process exited" overlay for frozen ai-cli sessions */}
      <FrozenOverlay workflowId={workflowId} sessionId={sessionId} />
      {/* "View Only" badge for non-controller clients */}
      {!isController && <ViewOnlyBadge workflowId={workflowId} sessionId={sessionId} />}
    </div>
  );
};

/**
 * Dim overlay shown when an ai-cli session has ended.
 * Purely decorative — does not block scrollback interaction.
 */
const FrozenOverlay: React.FC<{ workflowId: string; sessionId: string }> = ({
  workflowId,
  sessionId,
}) => {
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const session = sessions.find((s) => s.id === sessionId);
  const isFrozen =
    session?.kind === SESSION_KINDS.AI_CLI &&
    session.status !== TERMINAL_SESSION_STATUS.RUNNING;

  if (!isFrozen) return null;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex items-center justify-center py-1 pointer-events-none"
      style={{ background: "rgba(0,0,0,0.4)" }}
    >
      <span className="text-[11px] text-description-fg select-none">
        {session?.status === TERMINAL_SESSION_STATUS.FAILED
          ? "Process exited with error"
          : "Process exited"}
      </span>
    </div>
  );
};

/**
 * View-only banner shown when this client is observing but not controlling the terminal.
 * The "Take Control" button sends TERMINAL_CLAIM_CONTROL to claim ownership.
 */
const ViewOnlyBadge: React.FC<{ workflowId: string; sessionId: string }> = ({
  workflowId,
  sessionId,
}) => {
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const session = sessions.find((s) => s.id === sessionId);

  // Don't show badge for ended sessions — FrozenOverlay handles that
  if (session?.status !== TERMINAL_SESSION_STATUS.RUNNING) return null;

  const handleTakeControl = () => {
    sendMessage(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, { workflowId, sessionId });
  };

  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-1"
      style={{ background: "rgba(0,0,0,0.55)", zIndex: 10 }}
    >
      <span className="text-[11px] select-none" style={{ color: "var(--vscode-descriptionForeground)" }}>
        View Only
      </span>
      <button
        onClick={handleTakeControl}
        className="text-[11px] px-2 py-0.5 rounded select-none cursor-pointer"
        style={{
          background: "var(--vscode-button-secondaryBackground, rgba(255,255,255,0.12))",
          color: "var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground))",
          border: "1px solid var(--vscode-button-secondaryBorder, transparent)",
        }}
      >
        Take Control
      </button>
    </div>
  );
};
