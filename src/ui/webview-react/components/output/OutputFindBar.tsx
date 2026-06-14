import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useElementNarrow } from "@hooks/useElementNarrow";
import type { OutputFindState } from "@hooks/useOutputFind";

const EXIT_DURATION_MS = 180;

interface OutputFindBarProps {
  state: OutputFindState;
  onQueryChange: (query: string) => void;
  onNavigate: (direction: 1 | -1) => void;
  onToggleCaseSensitive: () => void;
  onClose: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

export function OutputFindBar({
  state,
  onQueryChange,
  onNavigate,
  onToggleCaseSensitive,
  onClose,
  onKeyDown,
}: OutputFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [containerRef, isNarrow] = useElementNarrow<HTMLDivElement>(440);
  const [rendering, setRendering] = useState(state.isOpen);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (state.isOpen) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setRendering(true);
      setClosing(false);
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }

    if (!rendering) {
      return;
    }

    setClosing(true);
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }
    exitTimerRef.current = setTimeout(() => {
      setRendering(false);
      setClosing(false);
      exitTimerRef.current = null;
    }, EXIT_DURATION_MS);
  }, [rendering, state.isOpen]);

  if (!rendering) {
    return null;
  }

  const counterLabel =
    state.matchCount > 0
      ? isNarrow
        ? `${state.currentMatch}/${state.matchCount}`
        : `${state.currentMatch} of ${state.matchCount}`
      : "0";

  return (
    <div
      ref={containerRef}
      className={`absolute left-2 right-2 top-0 z-raised flex items-center gap-1.5 overflow-hidden rounded border border-simple-find-sash-border bg-panel-sticky-bg/92 px-2 py-1 shadow-md backdrop-blur-md ${
        closing ? "animate-output-find-exit" : "animate-output-find-enter"
      }`}
      onKeyDown={onKeyDown}
      aria-hidden={closing}
    >
      <input
        ref={inputRef}
        type="text"
        value={state.query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Find in output"
        aria-label="Find in output"
        className="h-7 min-w-0 flex-1 basis-32 rounded border border-input-border bg-input-bg px-2 text-sm text-input-fg outline-none focus:border-focus-border"
      />
      <span
        className={`shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-description-fg ${
          isNarrow ? "w-8" : "w-16"
        }`}
      >
        {counterLabel}
      </span>
      <button
        type="button"
        className="icon-btn shrink-0 px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(-1)}
        title="Previous match"
        aria-label="Previous match"
      >
        <i className="codicon codicon-arrow-up" />
      </button>
      <button
        type="button"
        className="icon-btn shrink-0 px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(1)}
        title="Next match"
        aria-label="Next match"
      >
        <i className="codicon codicon-arrow-down" />
      </button>
      <button
        type="button"
        className={`icon-btn shrink-0 px-1.5 py-1 ${
          state.caseSensitive
            ? "text-foreground"
            : "text-description-fg hover:text-foreground"
        }`}
        onClick={onToggleCaseSensitive}
        title="Match case"
        aria-label="Match case"
        aria-pressed={state.caseSensitive}
      >
        <i className="codicon codicon-case-sensitive" />
      </button>
      <button
        type="button"
        className="icon-btn shrink-0 px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={onClose}
        title="Close find"
        aria-label="Close find"
      >
        <i className="codicon codicon-close" />
      </button>
    </div>
  );
}
