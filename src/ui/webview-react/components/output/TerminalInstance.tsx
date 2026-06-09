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
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import { WebviewLog } from "@/utils/logger";

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
  const resizeObserverDisconnectRef = useRef<(() => void) | null>(null);
  const previousIsControllerRef = useRef<boolean | null>(null);

  // Subscribe to controller status and controller cols — re-evaluate on every change
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const session = sessions.find((s) => s.id === sessionId);
  const isController = session?.isController ?? true;
  const controllerCols = session?.controllerCols;

  useEffect(() => {
    const previousIsController = previousIsControllerRef.current;
    if (previousIsController === null) {
      WebviewLog.debug(
        `[TerminalInstance] control state initialized wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} isController=${isController}`
      );
    } else if (previousIsController !== isController) {
      WebviewLog.debug(
        `[TerminalInstance] control ${isController ? "gained" : "lost"} wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} controllerCols=${controllerCols ?? "none"}`
      );
    }
    previousIsControllerRef.current = isController;
  }, [controllerCols, isController, workflowId, sessionId]);

  // Mount effect: create registry entry, attach to DOM, flush pending output
  useEffect(() => {
    let cancelled = false;
    WebviewLog.debug(
      `[TerminalInstance] mount effect start wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
        `containerConnected=${containerRef.current?.isConnected ?? false} ` +
        `registryHasEntry=${!!terminalRegistry.get(workflowId, sessionId)}`
    );

    // Touch-scroll support with iOS-style momentum (inertia) scrolling.
    // Defined at effect scope so the cleanup return can call removeEventListener
    // with the same stable function references.
    let touchStartY = 0;
    let touchScrollAccum = 0;
    let touchEl: HTMLElement | null = null;

    // Inertia state — velocity in px/ms, positive = scroll down
    let inertiaVelocity = 0;
    let inertiaScrollAccum = 0;
    let inertiaRafId: number | null = null;
    let inertiaLastTime = 0;
    // Velocity saved at touchstart so re-flicks in the same direction build speed
    let preTouchInertiaVelocity = 0;

    // Ring of recent move samples used to estimate end-of-gesture velocity
    let velSamples: Array<{ dp: number; t: number }> = [];
    const VEL_WINDOW_MS = 80; // look-back window for velocity estimate
    // Exponential decay: 0.9987^ms reaches ~1% of initial velocity in ~3.5 s
    const DECEL_PER_MS = 0.9987;
    const VEL_STOP_PX_PER_MS = 0.01;
    const MAX_VELOCITY_PX_PER_MS = 10;
    // Dead zones: both must pass for a gesture to trigger inertia.
    // Filters lift-off wobble (finger not releasing straight) and slow drags.
    const MIN_GESTURE_VELOCITY_PX_PER_MS = 0.1; // ~100 px/s
    const MIN_GESTURE_DISTANCE_PX = 3;
    // Scales touch pixels to lines — higher = faster scroll per unit of drag.
    const TOUCH_SPEED_MULTIPLIER = 1.5;
    const hasMeaningfulInertia = (velocity: number) =>
      Math.abs(velocity) >= VEL_STOP_PX_PER_MS &&
      // Reuse the same dead zone for scroll end: once the remaining motion over
      // the velocity window is inside it, stop coasting instead of dragging out
      // a long sub-pixel tail that occasionally emits late scroll lines.
      Math.abs(velocity) * VEL_WINDOW_MS >= MIN_GESTURE_DISTANCE_PX;

    // Dispatch scroll lines to xterm and synthesize a WheelEvent for TUI
    // mouse-reporting (same logic as the original direct-touch path).
    const dispatchScroll = (lines: number) => {
      const entry = terminalRegistry.get(workflowId, sessionId);
      if (!entry) return;
      const fontSize =
        (entry.term.options.fontSize as number | undefined) ?? 14;
      const lineHeight =
        (entry.term.options.lineHeight as number | undefined) ?? 1.2;
      // scrollLines handles normal scrollback; on the alternate buffer it is a
      // no-op so it never interferes with TUI output.
      entry.term.scrollLines(lines);
      // Synthesize WheelEvent so xterm forwards mouse-reporting escape sequences
      // to TUI programs when mouse-reporting is active.
      const wheelTarget =
        entry.term.element?.querySelector<Element>(".xterm-viewport") ??
        entry.term.element;
      if (wheelTarget) {
        const rect = wheelTarget.getBoundingClientRect();
        wheelTarget.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: lines * fontSize * lineHeight,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          })
        );
      }
    };

    const stopInertia = () => {
      if (inertiaRafId !== null) {
        cancelAnimationFrame(inertiaRafId);
        inertiaRafId = null;
      }
    };

    const tickInertia = (now: number) => {
      // Cap dt to avoid a massive jump after the tab returns from background.
      const dt = Math.min(now - inertiaLastTime, 50);
      inertiaLastTime = now;
      inertiaVelocity *= Math.pow(DECEL_PER_MS, dt);
      if (!hasMeaningfulInertia(inertiaVelocity)) {
        inertiaRafId = null;
        inertiaScrollAccum = 0;
        return;
      }
      const entry = terminalRegistry.get(workflowId, sessionId);
      if (!entry) {
        inertiaRafId = null;
        return;
      }
      const fontSize =
        (entry.term.options.fontSize as number | undefined) ?? 14;
      const lineHeight =
        (entry.term.options.lineHeight as number | undefined) ?? 1.2;
      inertiaScrollAccum +=
        (inertiaVelocity * dt * TOUCH_SPEED_MULTIPLIER) /
        (fontSize * lineHeight);
      const lines = Math.trunc(inertiaScrollAccum);
      if (lines !== 0) {
        inertiaScrollAccum -= lines;
        dispatchScroll(lines);
      }
      inertiaRafId = requestAnimationFrame(tickInertia);
    };

    const handleTouchStart = (e: TouchEvent) => {
      // Save current coasting velocity before stopping — a re-flick in the same
      // direction will add it back at touchend to accumulate momentum.
      preTouchInertiaVelocity = inertiaVelocity;
      stopInertia();
      touchStartY = e.touches[0].clientY;
      touchScrollAccum = 0;
      inertiaScrollAccum = 0;
      velSamples = [];
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!e.touches.length) return;
      const now = performance.now();
      const deltaPixels = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;

      // Accumulate velocity samples; prune anything outside the look-back window.
      velSamples.push({ dp: deltaPixels, t: now });
      const cutoff = now - VEL_WINDOW_MS;
      while (velSamples.length > 1 && velSamples[0].t < cutoff) {
        velSamples.shift();
      }

      const entry = terminalRegistry.get(workflowId, sessionId);
      if (!entry) return;
      const fontSize =
        (entry.term.options.fontSize as number | undefined) ?? 14;
      const lineHeight =
        (entry.term.options.lineHeight as number | undefined) ?? 1.2;
      touchScrollAccum +=
        (deltaPixels * TOUCH_SPEED_MULTIPLIER) / (fontSize * lineHeight);
      const lines = Math.trunc(touchScrollAccum);
      if (lines !== 0) {
        touchScrollAccum -= lines;
        dispatchScroll(lines);
      }
      e.preventDefault();
    };

    const handleTouchEnd = (_e: TouchEvent) => {
      const now = performance.now();
      const cutoff = now - VEL_WINDOW_MS;
      const recent = velSamples.filter((s) => s.t >= cutoff);

      let gestureVelocity = 0;
      if (recent.length > 0) {
        const totalDp = recent.reduce((sum, s) => sum + s.dp, 0);
        // Use actual elapsed time between first and last sample; fall back to
        // one assumed frame if only a single sample is available.
        const timeSpan =
          recent.length > 1 ? recent[recent.length - 1].t - recent[0].t : 16;
        const rawVelocity = totalDp / Math.max(timeSpan, 1);
        // Dead-zone check: require both enough speed and enough net displacement
        // so lift-off wobble (finger not releasing straight) is ignored.
        if (
          Math.abs(rawVelocity) >= MIN_GESTURE_VELOCITY_PX_PER_MS &&
          Math.abs(totalDp) >= MIN_GESTURE_DISTANCE_PX
        ) {
          gestureVelocity = rawVelocity;
        }
      }

      // Only accumulate pre-touch coasting when the gesture itself qualifies —
      // a catch gesture (finger down then up with no real movement) should stop
      // the scroll rather than silently resume it.
      const combined =
        gestureVelocity !== 0 ? gestureVelocity + preTouchInertiaVelocity : 0;
      inertiaVelocity = Math.max(
        -MAX_VELOCITY_PX_PER_MS,
        Math.min(MAX_VELOCITY_PX_PER_MS, combined)
      );
      velSamples = [];

      if (hasMeaningfulInertia(inertiaVelocity)) {
        inertiaScrollAccum = 0;
        inertiaLastTime = performance.now();
        inertiaRafId = requestAnimationFrame(tickInertia);
      }
    };

    const handleTouchCancel = () => {
      // Gesture was interrupted (e.g. system alert); discard without inertia.
      velSamples = [];
    };

    async function mount() {
      if (!containerRef.current) {
        WebviewLog.debug(
          `[TerminalInstance] mount aborted — containerRef.current is null`
        );
        return;
      }

      // Create or retrieve the registry entry (async: dynamic imports)
      const entry = await terminalRegistry.create(workflowId, sessionId);
      if (cancelled || !containerRef.current) {
        WebviewLog.debug(
          `[TerminalInstance] mount aborted after create — cancelled=${cancelled} containerNull=${!containerRef.current}`
        );
        return;
      }
      WebviewLog.debug(
        `[TerminalInstance] mount: entry created/retrieved wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
          `isNewEntry=${!entry.term.element}`
      );

      // Flush buffered output immediately after the entry lands in the registry,
      // before attach()'s async WebGL import. Any TERMINAL_OUTPUT messages that
      // arrive after create() completes write directly to entry.term.write(); if
      // we flushed pendingOutput after attach() those earlier chunks would be
      // written out-of-order (after chunks that arrived during the WebGL import).
      const { sessions, clearPendingOutput } = useTerminalStore.getState();
      const sess = (sessions[workflowId] ?? []).find((s) => s.id === sessionId);
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
      WebviewLog.debug(
        `[TerminalInstance] attach complete wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
          `domElConnected=${terminalRegistry.get(workflowId, sessionId)?.domEl.isConnected ?? false} ` +
          `containerConnected=${containerRef.current?.isConnected ?? false}`
      );

      // Register onData for input routing — skip if session is frozen, already listening,
      // or this client is a viewer (isController=false)
      const currentSession = useTerminalStore
        .getState()
        .sessions[workflowId]?.find((s) => s.id === sessionId);
      if (
        !entry.frozen &&
        !entry.onDataDisposable &&
        currentSession?.isController !== false
      ) {
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
            WebviewLog.debug("[FlightPath] Ad-hoc prompt captured:", captured);
          }
        });
      }

      // Register touch-scroll listeners on the container so the user can drag
      // through the scrollback buffer on mobile.
      touchEl = containerRef.current;
      if (touchEl) {
        touchEl.addEventListener("touchstart", handleTouchStart, {
          passive: true,
        });
        touchEl.addEventListener("touchmove", handleTouchMove, {
          passive: false,
        });
        touchEl.addEventListener("touchend", handleTouchEnd, { passive: true });
        touchEl.addEventListener("touchcancel", handleTouchCancel, {
          passive: true,
        });
      }

      // ResizeObserver: fit xterm to container; only the controller notifies the PTY.
      // Viewers keep cols locked to the controller's value to prevent double line-wrap.
      const { observer, disconnect } = createAnimationFrameResizeObserver(
        () => {
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
        }
      );

      if (containerRef.current) {
        observer.observe(containerRef.current);
      }
      resizeObserverRef.current = observer;
      resizeObserverDisconnectRef.current = disconnect;
    }

    mount();

    return () => {
      cancelled = true;
      WebviewLog.debug(
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
      resizeObserverDisconnectRef.current?.();
      resizeObserverDisconnectRef.current = null;
      resizeObserverRef.current = null;
      // Remove touch-scroll listeners and cancel any in-flight inertia animation
      stopInertia();
      touchEl?.removeEventListener("touchstart", handleTouchStart);
      touchEl?.removeEventListener("touchmove", handleTouchMove);
      touchEl?.removeEventListener("touchend", handleTouchEnd);
      touchEl?.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [workflowId, sessionId]);

  // When isController changes from false→true (viewer claiming control), re-register onData
  // and restore fit-to-container sizing.
  useEffect(() => {
    if (!isController) return;
    const entry = terminalRegistry.get(workflowId, sessionId);
    if (!entry || entry.frozen || entry.onDataDisposable) return;
    WebviewLog.debug(
      `[TerminalInstance] enabling controller input wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
    );
    entry.onDataDisposable = entry.term.onData((input) => {
      sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
        workflowId,
        sessionId,
        data: input,
      });
      const captured = entry.inputCapture.accumulate(input);
      if (captured) {
        WebviewLog.debug("[FlightPath] Ad-hoc prompt captured:", captured);
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
  }, [controllerCols, isController, workflowId, sessionId]);

  // When isController changes from true→false (control claimed by another client),
  // dispose onData and apply the controller's known column width.
  useEffect(() => {
    if (isController) return;
    const entry = terminalRegistry.get(workflowId, sessionId);
    if (!entry || entry.frozen) return;
    WebviewLog.debug(
      `[TerminalInstance] entering view-only mode wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} controllerCols=${entry.controllerCols ?? controllerCols ?? "none"}`
    );
    entry.onDataDisposable?.dispose();
    entry.onDataDisposable = undefined;
    // Apply controller sizing if we already know it (TERMINAL_SIZE_CHANGED may have
    // arrived before this effect fired, or arrives later and triggers reapplication)
    if (entry.controllerCols != null) {
      terminalRegistry.applyControllerSize(
        workflowId,
        sessionId,
        entry.controllerCols
      );
    }
  }, [controllerCols, isController, workflowId, sessionId]);

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
        // Disable browser pan/zoom on the terminal so our touch-scroll handler
        // has exclusive control over touch events. The browser would otherwise
        // try to scroll the page instead of the xterm scrollback buffer.
        touchAction: "none",
      }}
    >
      {/* "Process exited" overlay for frozen ai-cli sessions */}
      <FrozenOverlay workflowId={workflowId} sessionId={sessionId} />
      {/* "View Only" badge for non-controller clients */}
      {!isController && (
        <ViewOnlyBadge workflowId={workflowId} sessionId={sessionId} />
      )}
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
      <span className="text-xs text-description-fg select-none">
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
    WebviewLog.debug(
      `[TerminalInstance] manual take control requested wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
    );
    sendMessage(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, {
      workflowId,
      sessionId,
    });
  };

  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-1"
      style={{ background: "rgba(0,0,0,0.55)", zIndex: 10 }}
    >
      <span
        className="text-xs select-none"
        style={{ color: "var(--vscode-descriptionForeground)" }}
      >
        View Only
      </span>
      <button
        onClick={handleTakeControl}
        className="text-xs px-2 py-0.5 rounded select-none cursor-pointer"
        style={{
          background:
            "var(--vscode-button-secondaryBackground, rgba(255,255,255,0.12))",
          color:
            "var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground))",
          border: "1px solid var(--vscode-button-secondaryBorder, transparent)",
        }}
      >
        Take Control
      </button>
    </div>
  );
};
