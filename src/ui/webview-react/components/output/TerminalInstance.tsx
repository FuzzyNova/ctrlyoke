import React, { useEffect, useRef } from "react";
import { sendMessage } from "@hooks/useMessageHandler";
import { useTerminalStore } from "@store/terminalStore";
import type { TerminalSession } from "@store/terminalStore";
import { terminalRegistry } from "../../terminalRegistry";
import { MESSAGE_TYPES, TERMINAL_SESSION_STATUS, SESSION_KINDS } from "../../types/messages";
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
 */
export const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  workflowId,
  sessionId,
  isVisible,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Mount effect: create registry entry, attach to DOM, flush pending output
  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current) return;

      // Create or retrieve the registry entry (async: dynamic imports)
      const entry = await terminalRegistry.create(workflowId, sessionId);
      if (cancelled || !containerRef.current) return;

      // Flush buffered output immediately after the entry lands in the registry,
      // before attach()'s async WebGL import. Any TERMINAL_OUTPUT messages that
      // arrive after create() completes write directly to entry.term.write(); if
      // we flushed pendingOutput after attach() those earlier chunks would be
      // written out-of-order (after chunks that arrived during the WebGL import).
      const { sessions, clearPendingOutput } = useTerminalStore.getState();
      const session = (sessions[workflowId] ?? []).find((s) => s.id === sessionId);
      if (session?.pendingOutput.length) {
        for (const chunk of session.pendingOutput) {
          entry.term.write(chunk);
        }
        clearPendingOutput(workflowId, sessionId);
      }

      // Attach the xterm DOM element into this container (async: loads WebGL addon on first open)
      await terminalRegistry.attach(workflowId, sessionId, containerRef.current);

      // Register onData for input routing (skip if session is frozen or already listening)
      if (!entry.frozen && !entry.onDataDisposable) {
        entry.onDataDisposable = entry.term.onData((input) => {
          sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, { workflowId, sessionId, data: input });
          // Ad-hoc prompt capture for ai-cli sessions
          const captured = entry.inputCapture.accumulate(input);
          if (captured) {
            // TODO: emit ad-hoc prompt capture event for Output tab attribution
            console.debug("[FlightPath] Ad-hoc prompt captured:", captured);
          }
        });
      }

      // ResizeObserver: fit xterm to container and notify PTY of new dimensions
      const observer = new ResizeObserver(() => {
        if (!entry.term.element) return;
        try {
          entry.fitAddon.fit();
          const { cols, rows } = entry.term;
          sendMessage(MESSAGE_TYPES.TERMINAL_RESIZE, { workflowId, sessionId, cols, rows });
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

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: isVisible ? "flex" : "none",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* "Process exited" overlay for frozen ai-cli sessions */}
      <FrozenOverlay workflowId={workflowId} sessionId={sessionId} />
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
  const sessions = useTerminalStore((s) => s.sessions[workflowId] ?? EMPTY_SESSIONS);
  const session = sessions.find((s) => s.id === sessionId);
  const isFrozen = session?.kind === SESSION_KINDS.AI_CLI && session.status !== TERMINAL_SESSION_STATUS.RUNNING;

  if (!isFrozen) return null;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex items-center justify-center py-1 pointer-events-none"
      style={{ background: "rgba(0,0,0,0.4)" }}
    >
      <span className="text-[11px] text-description-fg select-none">
        {session?.status === TERMINAL_SESSION_STATUS.FAILED ? "Process exited with error" : "Process exited"}
      </span>
    </div>
  );
};
