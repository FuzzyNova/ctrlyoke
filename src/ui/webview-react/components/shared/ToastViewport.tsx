import { useEffect, useRef, useState } from "react";
import {
  TOAST_INFO_SUCCESS_TIMEOUT_MS,
  TOAST_MAX_VISIBLE_COUNT,
  TOAST_VIEWPORT_BOTTOM_OFFSET,
  TOAST_WARNING_ERROR_TIMEOUT_MS,
} from "@/constants";
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";
import { useUiStore, type ToastItem } from "@store/uiStore";

function isPersistentSeverity(toast: ToastItem): boolean {
  return (
    toast.severity === USER_FEEDBACK_SEVERITY.WARNING ||
    toast.severity === USER_FEEDBACK_SEVERITY.ERROR
  );
}

function getToastTimeout(toast: ToastItem): number {
  return isPersistentSeverity(toast)
    ? TOAST_WARNING_ERROR_TIMEOUT_MS
    : TOAST_INFO_SUCCESS_TIMEOUT_MS;
}

function getSeverityClasses(toast: ToastItem): string {
  switch (toast.severity) {
    case USER_FEEDBACK_SEVERITY.SUCCESS:
      return "border-status-running bg-status-running/10";
    case USER_FEEDBACK_SEVERITY.WARNING:
      return "border-severity-warning bg-severity-warning-bg";
    case USER_FEEDBACK_SEVERITY.ERROR:
      return "border-severity-error bg-severity-error-bg";
    case USER_FEEDBACK_SEVERITY.INFO:
    default:
      return "border-severity-info bg-severity-info-bg";
  }
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismissToast = useUiStore((state) => state.dismissToast);
  const [isPaused, setIsPaused] = useState(false);
  const [isDetailExpanded, setIsDetailExpanded] = useState(false);
  const remainingMsRef = useRef(getToastTimeout(toast));
  const timerStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (isPaused) {
      return;
    }

    if (remainingMsRef.current <= 0) {
      dismissToast(toast.id);
      return;
    }

    timerStartedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      remainingMsRef.current = 0;
      dismissToast(toast.id);
    }, remainingMsRef.current);

    return () => {
      window.clearTimeout(timer);
      if (timerStartedAtRef.current !== null) {
        remainingMsRef.current = Math.max(
          0,
          remainingMsRef.current - (Date.now() - timerStartedAtRef.current)
        );
        timerStartedAtRef.current = null;
      }
    };
  }, [dismissToast, isPaused, toast.id]);

  const pause = () => {
    if (timerStartedAtRef.current !== null) {
      remainingMsRef.current = Math.max(
        0,
        remainingMsRef.current - (Date.now() - timerStartedAtRef.current)
      );
      timerStartedAtRef.current = null;
    }
    setIsPaused(true);
  };

  const resume = () => setIsPaused(false);
  const assertive = isPersistentSeverity(toast);
  const detailId = `toast-detail-${toast.id}`;

  return (
    // Live regions are deliberately non-interactive; their descendants carry
    // the keyboard controls while the region owns hover/focus pause behavior.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <article
      className={`pointer-events-auto flex w-full items-start gap-2 rounded border px-3 py-2 shadow-lg text-sm text-foreground motion-safe:animate-slide-down-in motion-reduce:transition-none ${getSeverityClasses(toast)}`}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      tabIndex={-1}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          resume();
        }
      }}
    >
      <div className="min-w-0 flex-1 select-text">
        <p className="whitespace-pre-wrap break-words">{toast.message}</p>
        {toast.detail && (
          <>
            <button
              type="button"
              className="mt-1 text-xs text-link-fg underline underline-offset-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border"
              aria-expanded={isDetailExpanded}
              aria-controls={detailId}
              onClick={() => setIsDetailExpanded((expanded) => !expanded)}
            >
              {isDetailExpanded ? "Hide details" : "Show details"}
            </button>
            {isDetailExpanded && (
              <p
                id={detailId}
                className="mt-1 whitespace-pre-wrap break-words text-xs"
              >
                {toast.detail}
              </p>
            )}
          </>
        )}
        {toast.action && (
          <button
            type="button"
            className="mt-2 text-xs text-link-fg underline underline-offset-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border"
            onClick={() => {
              toast.action?.onClick();
              dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-foreground hover:bg-list-hover-bg focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      >
        <span className="codicon codicon-close" aria-hidden="true" />
      </button>
    </article>
  );
}

export function ToastViewport() {
  const toastQueue = useUiStore((state) => state.toastQueue);
  const visibleToasts = toastQueue.slice(0, TOAST_MAX_VISIBLE_COUNT);

  if (visibleToasts.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed left-2 right-2 z-popover flex max-h-[calc(100dvh-5rem)] flex-col gap-2 overflow-y-auto sm:left-auto sm:right-4 sm:w-[min(24rem,calc(100vw-2rem))]"
      style={{ bottom: TOAST_VIEWPORT_BOTTOM_OFFSET }}
      aria-label="Notifications"
    >
      {visibleToasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
