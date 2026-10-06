import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useElementNarrow } from "@hooks/useElementNarrow";
import type { OutputFindState } from "@hooks/useOutputFind";
import { ExitButton } from "@components/shared";
import { Icon } from "../shared/Icon";

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
  const containerDivRef = useRef<HTMLDivElement>(null);
  const [parentRef, isNarrow] = useElementNarrow<HTMLElement>(440);
  const [rendering, setRendering] = useState(state.isOpen);
  const [closing, setClosing] = useState(false);

  // Observe the *parent* element, not the bar itself. The bar's width changes
  // when isNarrow flips (left-2 added/removed), which would create a
  // ResizeObserver feedback loop if we watched the bar directly.
  useEffect(() => {
    if (!rendering) return;
    const parent = containerDivRef.current?.parentElement ?? null;
    parentRef(parent);
    return () => {
      parentRef(null);
    };
  }, [parentRef, rendering]);

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
    // right offset clears the minimap rail (its width + an 8px gap) so the
    // bar never overlaps the minimap on wide screens.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onKeyDown delegates events bubbling from interactive children (input, buttons)
    <div
      ref={containerDivRef}
      role="search"
      className={`absolute right-[calc(var(--cy-output-minimap-width)+0.5rem)] top-0 z-content-floating flex items-center gap-1.5 overflow-hidden rounded-sm border border-simple-find-sash-border bg-panel-sticky-bg/92 px-2 py-1 shadow-md backdrop-blur-md ${
        isNarrow ? "left-2" : ""
      } ${closing ? "animate-output-find-exit" : "animate-output-find-enter"}`}
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
        className="h-7 min-w-0 flex-1 basis-32 rounded-sm border border-input-border bg-input-bg px-2 text-sm text-input-fg outline-hidden focus:border-focus-border"
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
        <Icon name="arrow-up" />
      </button>
      <button
        type="button"
        className="icon-btn shrink-0 px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(1)}
        title="Next match"
        aria-label="Next match"
      >
        <Icon name="arrow-down" />
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
        <Icon name="case-sensitive" />
      </button>
      <ExitButton
        className="shrink-0"
        onClick={onClose}
        title="Close find"
        aria-label="Close find"
      />
    </div>
  );
}
