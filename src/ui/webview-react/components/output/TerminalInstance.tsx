import React, { useCallback, useEffect, useRef } from "react";
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
import { getTerminalEndedLabel } from "@utils/terminalPresentation";

// Stable empty fallback — avoids infinite re-render from `?? []` in useSyncExternalStore.
const EMPTY_SESSIONS: TerminalSession[] = [];

interface TerminalInstanceProps {
  workflowId: string;
  sessionId: string;
  /**
   * false = inactive session in the rail. Hidden with visibility:hidden (not
   * display:none) so the container keeps its real dimensions — collapsing it to
   * 0×0 would make the controller's ResizeObserver fit to a clamped 2×1 grid and
   * push that bogus size to the PTY, squishing the harness TUI on switch-back.
   */
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
  // Last viewport size reported to the extension via TERMINAL_VIEWPORT_HINT, so we
  // only re-send when the fitted cols/rows actually change (columns tick every
  // ~8px of drag, so this collapses a pixel-drag to a handful of tiny messages).
  const lastSentHintRef = useRef<{ cols: number; rows: number } | null>(null);

  // Subscribe to controller status and controller cols — re-evaluate on every change
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const session = sessions.find((s) => s.id === sessionId);
  const isController = session?.isController ?? true;
  const controllerCols = session?.controllerCols;
  const controllerRows = session?.controllerRows;

  // Report this (controller) client's current viewport as the spawn size for the
  // NEXT PTY. Change-gated. Fires from every controller fit — including while the
  // terminal is frozen/ended — so a drag between runs updates the next spawn's
  // width. Only the controller's size matters, so callers gate on isController.
  const sendViewportHint = useCallback(
    (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      const last = lastSentHintRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastSentHintRef.current = { cols, rows };
      sendMessage(MESSAGE_TYPES.TERMINAL_VIEWPORT_HINT, {
        workflowId,
        sessionId,
        cols,
        rows,
      });
    },
    [workflowId, sessionId]
  );

  const syncControllerTerminalSize = useCallback(
    (
      reason: string,
      options?: {
        forceResize?: boolean;
      }
    ) => {
      const entry = terminalRegistry.get(workflowId, sessionId);
      const container = containerRef.current;
      if (
        !entry ||
        !container ||
        container.offsetWidth === 0 ||
        container.offsetHeight === 0
      ) {
        return null;
      }

      const previousCols = entry.term.cols;
      const previousRows = entry.term.rows;
      const fitResult = terminalRegistry.fitSessionToContainer(
        workflowId,
        sessionId,
        "controller"
      );
      const cols = fitResult?.cols ?? entry.term.cols;
      const rows = fitResult?.rows ?? entry.term.rows;
      const changed = cols !== previousCols || rows !== previousRows;
      const shouldSendResize = options?.forceResize === true || changed;

      if (shouldSendResize) {
        WebviewLog.trace(
          `[TerminalInstance] controller TERMINAL_RESIZE (${reason}) wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
            `container=${container.offsetWidth}x${container.offsetHeight}px ` +
            `proposed=${fitResult?.proposedCols ?? "none"}x${fitResult?.proposedRows ?? "none"} ` +
            `previous=${previousCols}x${previousRows} xtermRendered=${entry.term.cols}x${entry.term.rows} ` +
            `sending=${cols}x${rows} changed=${changed} forced=${options?.forceResize === true}`
        );
        sendMessage(MESSAGE_TYPES.TERMINAL_RESIZE, {
          workflowId,
          sessionId,
          cols,
          rows,
        });
      }
      sendViewportHint(cols, rows);
      return { fitResult, cols, rows, changed };
    },
    [workflowId, sessionId, sendViewportHint]
  );

  useEffect(() => {
    WebviewLog.trace(
      `[TerminalInstance] visibility wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
        `isVisible=${isVisible} isController=${isController} controllerCols=${controllerCols ?? "none"}`
    );
  }, [
    controllerCols,
    controllerRows,
    isController,
    isVisible,
    workflowId,
    sessionId,
  ]);

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

  // A font-size or terminal-option change refits xterm in the registry without
  // a container resize, so the ResizeObserver never fires. The controller must
  // still tell the PTY, or the harness keeps drawing at the old column count.
  // The registry has already refit locally, so the resize is forced.
  useEffect(() => {
    return terminalRegistry.onMetricsChanged(() => {
      const sessNow = useTerminalStore
        .getState()
        .sessions[workflowId]?.find((s) => s.id === sessionId);
      if (sessNow?.isController === false) return;
      syncControllerTerminalSize("metrics-changed", { forceResize: true });
    });
  }, [workflowId, sessionId, syncControllerTerminalSize]);

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

    // The custom scrollback/inertia handler below runs for the CONTROLLER only.
    // A viewer's xterm mirrors the controller's exact cols×rows grid, which is
    // usually larger than the viewer's container, so a viewer instead pans that
    // fixed grid via the container's native overflow scroll (touch-action below
    // is set to allow pan-x/pan-y for viewers). Letting native panning own both
    // axes is what makes the iOS horizontal scrollbar reachable and lets the user
    // reach rows below the fold. Viewers therefore early-return from these
    // handlers and never call preventDefault.
    const isViewerNow = () =>
      terminalRegistry.get(workflowId, sessionId)?.controllerCols != null;

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
      // Viewers pan natively — leave the gesture entirely to the browser.
      if (isViewerNow()) return;
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
      // Viewers pan natively (both axes) — do not preventDefault or scroll xterm.
      if (isViewerNow()) return;
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
      if (isViewerNow()) return;
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

      // Output that arrived before this entry existed is flushed inside
      // terminalRegistry.create() — the single point where the entry materializes
      // — so it renders in order before any live chunks that now write directly.

      // Seed the registry entry with the controller's dimensions if already known
      // (TERMINAL_SIZE_CHANGED may have arrived before this mount ran).
      // attach()'s requestAnimationFrame checks entry.controllerCols and applies
      // viewer sizing (cols×rows mirror) instead of fitAddon.fit() when set.
      const sess = useTerminalStore
        .getState()
        .sessions[workflowId]?.find((s) => s.id === sessionId);
      if (sess?.isController === false && sess.controllerCols != null) {
        entry.controllerCols = sess.controllerCols;
        if (sess.controllerRows != null) {
          entry.controllerRows = sess.controllerRows;
        }
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
          // Never fit/resize against a collapsed container. A 0×0 box (display:none
          // somewhere up the tree, mid-transition layout) makes FitAddon clamp to its
          // 2×1 minimum; for a controller that bogus size is then sent to the PTY and
          // squishes the harness TUI. Bail until the container has real dimensions.
          const container = containerRef.current;
          if (
            !container ||
            container.offsetWidth === 0 ||
            container.offsetHeight === 0
          ) {
            return;
          }
          try {
            const sessNow = useTerminalStore
              .getState()
              .sessions[workflowId]?.find((s) => s.id === sessionId);
            const isCtrl = sessNow?.isController;
            if (isCtrl !== false) {
              // Controller: fit to container, then report changed dimensions to PTY.
              syncControllerTerminalSize("resize-observer");
            } else if (entry.controllerCols != null) {
              // Viewer: keep cols fixed at controller's width, let rows adapt to
              // the local container height so the terminal fills vertically.
              terminalRegistry.fitSessionToContainer(
                workflowId,
                sessionId,
                "viewer"
              );
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

    // Defensive catch so an unexpected mount failure logs instead of surfacing as
    // an unhandled rejection. xterm is statically imported now, so create() can no
    // longer fail on a chunk fetch — the prior failure mode that left the terminal
    // blank is gone.
    void mount().catch((err) => {
      if (cancelled) return;
      WebviewLog.error(
        `[TerminalInstance] mount failed wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    });

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
  }, [workflowId, sessionId, sendViewportHint, syncControllerTerminalSize]);

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
          // A viewer taking control may fit to a different width than the old
          // controller — force a resize so the PTY and every viewer re-sync.
          syncControllerTerminalSize("controller-claim", { forceResize: true });
        } catch {
          // Ignore — terminal may not be visible
        }
      });
    }
  }, [
    controllerCols,
    isController,
    workflowId,
    sessionId,
    syncControllerTerminalSize,
  ]);

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
        entry.controllerCols,
        entry.controllerRows
      );
    }
  }, [controllerCols, controllerRows, isController, workflowId, sessionId]);

  // When the controller's dimensions change while already a viewer, reapply the
  // new size. This handles the case where TERMINAL_SIZE_CHANGED arrives after
  // isController has already been set to false.
  useEffect(() => {
    if (isController || controllerCols == null) return;
    terminalRegistry.applyControllerSize(
      workflowId,
      sessionId,
      controllerCols,
      controllerRows
    );
  }, [controllerCols, controllerRows, isController, workflowId, sessionId]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const entry = terminalRegistry.get(workflowId, sessionId);
    const container = containerRef.current;
    if (!entry || !container) {
      WebviewLog.trace(
        `[TerminalInstance] visible refresh skipped wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
          `entryExists=${!!entry} containerConnected=${container?.isConnected ?? false}`
      );
      return;
    }

    const runVisibleRefresh = (phase: "raf1" | "raf2") => {
      const activeEntry = terminalRegistry.get(workflowId, sessionId);
      const activeContainer = containerRef.current;
      if (!activeEntry || !activeContainer) {
        return;
      }
      // Same 0×0 guard as the ResizeObserver: refusing to fit a collapsed
      // container avoids a local 2×1 resize that would visibly squish on show.
      if (
        activeContainer.offsetWidth === 0 ||
        activeContainer.offsetHeight === 0
      ) {
        return;
      }

      try {
        const isViewerFit =
          activeEntry.controllerCols != null && isController === false;
        const fitResult = isViewerFit
          ? terminalRegistry.fitSessionToContainer(
              workflowId,
              sessionId,
              "viewer"
            )
          : syncControllerTerminalSize(`visible-refresh-${phase}`, {
              forceResize: phase === "raf2",
            })?.fitResult;
        activeEntry.term.refresh(0, Math.max(0, activeEntry.term.rows - 1));
        WebviewLog.trace(
          `[TerminalInstance] visible refresh ${phase} wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
            `containerSize=${activeContainer.offsetWidth}x${activeContainer.offsetHeight} ` +
            `containerDisplay=${getComputedStyle(activeContainer).display} ` +
            `proposed=${fitResult?.proposedCols ?? "none"}x${fitResult?.proposedRows ?? "none"} ` +
            `cols=${activeEntry.term.cols} rows=${activeEntry.term.rows}`
        );
      } catch (error) {
        WebviewLog.trace(
          `[TerminalInstance] visible refresh ${phase} failed wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    const raf1 = requestAnimationFrame(() => {
      runVisibleRefresh("raf1");
    });
    const raf2 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        runVisibleRefresh("raf2");
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [
    controllerCols,
    controllerRows,
    isController,
    isVisible,
    workflowId,
    sessionId,
    syncControllerTerminalSize,
  ]);

  return (
    // Non-scrolling outer wrapper — the positioning context for the "View Only" /
    // "Process exited" overlays so they stay pinned to the bottom of the visible
    // terminal area instead of scrolling with the mirrored grid inside the inner
    // scroll container below.
    //
    // Inactive rail sessions are hidden with visibility:hidden (via `invisible`)
    // while staying absolutely positioned at full size, NOT display:none. A
    // collapsed 0×0 container fires the ResizeObserver below and pushes a clamped
    // 2×1 fit to the PTY, which reflows and squishes the harness TUI. Mirrors the
    // pane-level visibility trick in OutputSection.
    <div
      className={`absolute inset-0 flex flex-col ${
        isVisible ? "" : "invisible pointer-events-none"
      }`}
    >
      {/*
        Controllers fill their container with no overflow (fitAddon sizes exactly).
        Viewers mirror the controller's exact cols×rows grid (fixed size) and
        letterbox it: scrollbars on whichever axis the viewer is smaller, auto
        horizontal margins center it when wider. Hence overflow auto on both
        axes for viewers.

        Controllers take full touch control (touch-none) so our custom handler
        owns vertical scrollback and the browser never pans/zooms the page.
        Viewers pan the fixed mirrored grid natively on both axes (pan-x/pan-y)
        — this is what makes the horizontal scrollbar reachable on iOS Safari
        and lets the user reach rows below the fold. Pinch-zoom stays disabled
        either way.
      */}
      <div
        ref={containerRef}
        className={`flex flex-1 flex-col min-w-0 min-h-0 ${
          isController
            ? "overflow-hidden touch-none"
            : "overflow-auto touch-pan-x touch-pan-y"
        }`}
      />
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
 * Dim overlay shown when an ai-cli session has ended, naming why when ctrlyoke
 * ended it deliberately. Purely decorative — does not block scrollback.
 */
const FrozenOverlay: React.FC<{ workflowId: string; sessionId: string }> = ({
  workflowId,
  sessionId,
}) => {
  const sessions = useTerminalStore(
    (s) => s.sessions[workflowId] ?? EMPTY_SESSIONS
  );
  const session = sessions.find((s) => s.id === sessionId);
  const label =
    session?.kind === SESSION_KINDS.AI_CLI
      ? getTerminalEndedLabel(session)
      : undefined;

  if (!label) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center py-1 pointer-events-none bg-overlay-scrim">
      <span className="text-xs text-description-fg select-none">{label}</span>
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
    WebviewLog.info(
      `[TerminalInstance] manual take control requested wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
    );
    sendMessage(MESSAGE_TYPES.TERMINAL_CLAIM_CONTROL, {
      workflowId,
      sessionId,
    });
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 z-raised flex items-center justify-between px-4 py-1.5 bg-overlay-scrim-strong">
      <span className="text-sm text-severity-warning font-medium select-none">
        View Only
      </span>
      <button
        onClick={handleTakeControl}
        className="text-sm px-5 py-1 rounded-sm select-none cursor-pointer border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
      >
        Take Control
      </button>
    </div>
  );
};
